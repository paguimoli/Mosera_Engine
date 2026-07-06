create table game_engine.math_evaluation_events (
  math_evaluation_id uuid primary key,
  request_id uuid not null,
  outcome_certificate_id uuid not null,
  outcome_certificate_hash text not null,
  game_manifest_reference text not null,
  math_model_id text not null,
  math_model_version text not null,
  math_model_hash text not null,
  paytable_id text not null,
  paytable_version text not null,
  paytable_hash text not null,
  ticket_reference text not null,
  wager_payload jsonb not null,
  prize_facts jsonb not null,
  canonical_prize_facts_hash text not null,
  idempotency_key text not null,
  evaluation_mode text not null,
  evaluated_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_math_evaluation_events_idempotency_key unique (idempotency_key),
  check (evaluation_mode in ('DryRun', 'Simulation', 'ProductionDisabled')),
  check (jsonb_typeof(wager_payload) = 'object'),
  check (jsonb_typeof(prize_facts) = 'object')
);

create table game_engine.math_evaluation_certificates (
  certificate_id uuid primary key,
  math_evaluation_id uuid not null references game_engine.math_evaluation_events(math_evaluation_id),
  outcome_certificate_id uuid not null,
  outcome_certificate_hash text not null,
  math_model_id text not null,
  math_model_version text not null,
  math_model_hash text not null,
  paytable_id text not null,
  paytable_version text not null,
  paytable_hash text not null,
  ticket_reference text not null,
  canonical_prize_facts_hash text not null,
  rtp_math_metadata_reference text not null,
  signing_metadata jsonb,
  issued_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_math_evaluation_certificates_evaluation unique (math_evaluation_id),
  check (signing_metadata is null or jsonb_typeof(signing_metadata) = 'object')
);

create index idx_math_evaluation_events_outcome_certificate
  on game_engine.math_evaluation_events(outcome_certificate_id);

create index idx_math_evaluation_events_math_model
  on game_engine.math_evaluation_events(math_model_id, math_model_version);

create index idx_math_evaluation_events_paytable
  on game_engine.math_evaluation_events(paytable_id, paytable_version);

create index idx_math_evaluation_events_ticket
  on game_engine.math_evaluation_events(ticket_reference);

create index idx_math_evaluation_events_prize_hash
  on game_engine.math_evaluation_events(canonical_prize_facts_hash);

create index idx_math_evaluation_certificates_outcome_certificate
  on game_engine.math_evaluation_certificates(outcome_certificate_id);

create index idx_math_evaluation_certificates_math_model
  on game_engine.math_evaluation_certificates(math_model_id, math_model_version);

create index idx_math_evaluation_certificates_paytable
  on game_engine.math_evaluation_certificates(paytable_id, paytable_version);

create index idx_math_evaluation_certificates_ticket
  on game_engine.math_evaluation_certificates(ticket_reference);

create index idx_math_evaluation_certificates_prize_hash
  on game_engine.math_evaluation_certificates(canonical_prize_facts_hash);

create or replace function game_engine.validate_math_evaluation_event()
returns trigger
language plpgsql
as $$
declare
  outcome_record record;
  math_model_count integer;
  paytable_count integer;
begin
  if new.evaluation_mode = 'ProductionDisabled' then
    raise exception 'Production Math Authority evaluation is disabled';
  end if;

  select oc.canonical_outcome_hash,
         oe.game_manifest_reference
  into outcome_record
  from game_engine.outcome_certificates oc
  join game_engine.outcome_events oe on oe.outcome_id = oc.outcome_id
  where oc.certificate_id = new.outcome_certificate_id
    and oc.canonical_outcome_hash = new.outcome_certificate_hash;

  if not found then
    raise exception 'Outcome certificate reference is invalid';
  end if;

  if outcome_record.game_manifest_reference <> new.game_manifest_reference then
    raise exception 'Game manifest reference does not match the outcome certificate chain';
  end if;

  select count(*)
  into math_model_count
  from game_engine.math_model_definitions
  where math_model_id = new.math_model_id
    and version = new.math_model_version
    and content_hash = new.math_model_hash;

  if math_model_count = 0 then
    raise exception 'Math model reference is invalid';
  end if;

  select count(*)
  into paytable_count
  from game_engine.paytable_definitions
  where paytable_id = new.paytable_id
    and version = new.paytable_version
    and content_hash = new.paytable_hash
    and math_model_id = new.math_model_id
    and math_model_version = new.math_model_version;

  if paytable_count = 0 then
    raise exception 'Paytable reference is invalid';
  end if;

  if new.prize_facts ? 'ledgerEntryId'
    or new.prize_facts ? 'walletTransactionId'
    or new.prize_facts ? 'cashMovement'
    or new.prize_facts ? 'financialLedgerEntry' then
    raise exception 'Math evaluation prize facts cannot contain financial movement references';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_math_evaluation_certificate()
returns trigger
language plpgsql
as $$
declare
  event_record record;
begin
  select outcome_certificate_id,
         outcome_certificate_hash,
         math_model_id,
         math_model_version,
         math_model_hash,
         paytable_id,
         paytable_version,
         paytable_hash,
         ticket_reference,
         canonical_prize_facts_hash
  into event_record
  from game_engine.math_evaluation_events
  where math_evaluation_id = new.math_evaluation_id;

  if not found then
    raise exception 'Math evaluation certificate requires an existing evaluation event';
  end if;

  if event_record.outcome_certificate_id <> new.outcome_certificate_id
    or event_record.outcome_certificate_hash <> new.outcome_certificate_hash
    or event_record.math_model_id <> new.math_model_id
    or event_record.math_model_version <> new.math_model_version
    or event_record.math_model_hash <> new.math_model_hash
    or event_record.paytable_id <> new.paytable_id
    or event_record.paytable_version <> new.paytable_version
    or event_record.paytable_hash <> new.paytable_hash
    or event_record.ticket_reference <> new.ticket_reference
    or event_record.canonical_prize_facts_hash <> new.canonical_prize_facts_hash then
    raise exception 'Math evaluation certificate does not match the evaluation event evidence chain';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_math_evaluation_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.math_evaluation_events is append-only; create a superseding math evaluation event instead';
end;
$$;

create or replace function game_engine.prevent_math_evaluation_certificate_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.math_evaluation_certificates is append-only; create a superseding math evaluation certificate instead';
end;
$$;

create trigger trg_validate_math_evaluation_event
before insert on game_engine.math_evaluation_events
for each row execute function game_engine.validate_math_evaluation_event();

create trigger trg_prevent_math_evaluation_event_update
before update on game_engine.math_evaluation_events
for each row execute function game_engine.prevent_math_evaluation_event_mutation();

create trigger trg_prevent_math_evaluation_event_delete
before delete on game_engine.math_evaluation_events
for each row execute function game_engine.prevent_math_evaluation_event_mutation();

create trigger trg_validate_math_evaluation_certificate
before insert on game_engine.math_evaluation_certificates
for each row execute function game_engine.validate_math_evaluation_certificate();

create trigger trg_prevent_math_evaluation_certificate_update
before update on game_engine.math_evaluation_certificates
for each row execute function game_engine.prevent_math_evaluation_certificate_mutation();

create trigger trg_prevent_math_evaluation_certificate_delete
before delete on game_engine.math_evaluation_certificates
for each row execute function game_engine.prevent_math_evaluation_certificate_mutation();

comment on table game_engine.math_evaluation_events is
  'Append-only dry-run Math Authority evaluation events. Prize facts are outcome-derived and cannot contain ledger, wallet, or cash movement references.';

comment on table game_engine.math_evaluation_certificates is
  'Append-only dry-run Math Evaluation Certificates linking outcome certificate, math model, paytable, ticket/wager, and prize facts hash.';
