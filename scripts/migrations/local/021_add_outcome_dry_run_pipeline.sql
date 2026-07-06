create table game_engine.outcome_events (
  outcome_id uuid primary key,
  request_id uuid not null,
  draw_id uuid not null,
  game_manifest_reference text not null,
  strategy_id text not null,
  strategy_version text not null,
  rng_provider_id text not null,
  rng_provider_version text not null,
  rng_evidence_hash text not null,
  idempotency_key text not null,
  outcome_mode text not null,
  outcome_payload jsonb not null,
  canonical_outcome_hash text not null,
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_outcome_events_idempotency_key unique (idempotency_key),
  check (outcome_mode in ('DryRun', 'Simulation', 'ProductionDisabled')),
  check (jsonb_typeof(outcome_payload) = 'object')
);

create table game_engine.outcome_certificates (
  certificate_id uuid primary key,
  outcome_id uuid not null references game_engine.outcome_events(outcome_id),
  draw_id uuid not null,
  strategy_id text not null,
  strategy_version text not null,
  rng_provider_id text not null,
  rng_provider_version text not null,
  canonical_outcome_hash text not null,
  evidence_hash_reference text not null,
  previous_certificates jsonb not null default '[]'::jsonb,
  signing_metadata jsonb,
  custody_state text not null,
  issued_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_outcome_certificates_outcome unique (outcome_id),
  check (jsonb_typeof(previous_certificates) = 'array'),
  check (signing_metadata is null or jsonb_typeof(signing_metadata) = 'object'),
  check (custody_state in ('Generated', 'Sealed', 'Certified', 'Superseded', 'Voided', 'Disputed'))
);

create index idx_outcome_events_draw_id
  on game_engine.outcome_events(draw_id);

create index idx_outcome_events_strategy
  on game_engine.outcome_events(strategy_id, strategy_version);

create index idx_outcome_events_provider
  on game_engine.outcome_events(rng_provider_id, rng_provider_version);

create index idx_outcome_events_hash
  on game_engine.outcome_events(canonical_outcome_hash);

create index idx_outcome_certificates_draw_id
  on game_engine.outcome_certificates(draw_id);

create index idx_outcome_certificates_outcome_hash
  on game_engine.outcome_certificates(canonical_outcome_hash);

create index idx_outcome_certificates_provider
  on game_engine.outcome_certificates(rng_provider_id, rng_provider_version);

create or replace function game_engine.validate_outcome_event()
returns trigger
language plpgsql
as $$
declare
  provider_record record;
  evidence_count integer;
  strategy_count integer;
begin
  if new.outcome_mode = 'ProductionDisabled' then
    raise exception 'Production outcome authority is disabled';
  end if;

  select count(*)
  into strategy_count
  from game_engine.outcome_strategy_definitions
  where strategy_id = new.strategy_id
    and strategy_version = new.strategy_version;

  if strategy_count = 0 then
    raise exception 'Outcome strategy reference is invalid';
  end if;

  select provider_type, production_eligible
  into provider_record
  from game_engine.rng_provider_definitions
  where provider_id = new.rng_provider_id
    and provider_version = new.rng_provider_version;

  if not found then
    raise exception 'RNG provider reference is invalid';
  end if;

  if provider_record.production_eligible then
    raise exception 'Dry-run outcome generation requires a non-production RNG provider';
  end if;

  if new.outcome_mode = 'DryRun' and provider_record.provider_type <> 'TEST_DETERMINISTIC' then
    raise exception 'Dry-run outcome generation requires a deterministic test RNG provider';
  end if;

  if new.outcome_mode = 'Simulation' and provider_record.provider_type not in ('TEST_DETERMINISTIC', 'SIMULATION') then
    raise exception 'Simulation outcome generation requires a deterministic test or simulation RNG provider';
  end if;

  select count(*)
  into evidence_count
  from game_engine.rng_provider_evidence
  where provider_id = new.rng_provider_id
    and provider_version = new.rng_provider_version
    and canonical_evidence_hash = new.rng_evidence_hash;

  if evidence_count = 0 then
    raise exception 'RNG evidence reference is invalid or missing';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_outcome_certificate()
returns trigger
language plpgsql
as $$
declare
  event_record record;
begin
  select draw_id,
         strategy_id,
         strategy_version,
         rng_provider_id,
         rng_provider_version,
         rng_evidence_hash,
         canonical_outcome_hash
  into event_record
  from game_engine.outcome_events
  where outcome_id = new.outcome_id;

  if not found then
    raise exception 'Outcome certificate requires an existing outcome event';
  end if;

  if event_record.draw_id <> new.draw_id
    or event_record.strategy_id <> new.strategy_id
    or event_record.strategy_version <> new.strategy_version
    or event_record.rng_provider_id <> new.rng_provider_id
    or event_record.rng_provider_version <> new.rng_provider_version
    or event_record.rng_evidence_hash <> new.evidence_hash_reference
    or event_record.canonical_outcome_hash <> new.canonical_outcome_hash then
    raise exception 'Outcome certificate does not match the outcome event evidence chain';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_outcome_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.outcome_events is append-only; create a superseding outcome event instead';
end;
$$;

create or replace function game_engine.prevent_outcome_certificate_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.outcome_certificates is append-only; create a superseding outcome certificate instead';
end;
$$;

create trigger trg_validate_outcome_event
before insert on game_engine.outcome_events
for each row execute function game_engine.validate_outcome_event();

create trigger trg_prevent_outcome_event_update
before update on game_engine.outcome_events
for each row execute function game_engine.prevent_outcome_event_mutation();

create trigger trg_prevent_outcome_event_delete
before delete on game_engine.outcome_events
for each row execute function game_engine.prevent_outcome_event_mutation();

create trigger trg_validate_outcome_certificate
before insert on game_engine.outcome_certificates
for each row execute function game_engine.validate_outcome_certificate();

create trigger trg_prevent_outcome_certificate_update
before update on game_engine.outcome_certificates
for each row execute function game_engine.prevent_outcome_certificate_mutation();

create trigger trg_prevent_outcome_certificate_delete
before delete on game_engine.outcome_certificates
for each row execute function game_engine.prevent_outcome_certificate_mutation();

comment on table game_engine.outcome_events is
  'Append-only dry-run Outcome Authority events. Production outcome authority remains disabled; dry-run requests require non-production RNG provider evidence.';

comment on table game_engine.outcome_certificates is
  'Append-only dry-run Outcome Certificates with hash-linked outcome payload and RNG evidence references.';
