create table game_engine.canonical_outcome_versions (
  outcome_version_id uuid primary key,
  draw_id uuid not null,
  product_reference text not null,
  engine_name text not null,
  engine_version text not null,
  version_number integer not null check (version_number > 0),
  version_kind text not null check (version_kind in ('Published', 'Corrected', 'Cancelled')),
  outcome_id uuid not null references game_engine.outcome_events(outcome_id),
  outcome_certificate_id uuid not null references game_engine.outcome_certificates(certificate_id),
  outcome_certificate_hash text not null check (outcome_certificate_hash like 'sha256:%'),
  previous_outcome_version_id uuid references game_engine.canonical_outcome_versions(outcome_version_id),
  outcome_payload jsonb not null check (jsonb_typeof(outcome_payload) = 'object'),
  canonical_outcome_hash text not null check (canonical_outcome_hash like 'sha256:%'),
  generated_at timestamptz not null,
  authoritative_source text not null,
  correlation_id text not null,
  causation_id text not null,
  audit_reference text not null,
  canonical_request_hash text not null check (canonical_request_hash like 'sha256:%'),
  idempotency_key text not null,
  outbox_event_id uuid not null references public.outbox_events(id),
  published_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_canonical_outcome_versions_draw_version unique (draw_id, version_number),
  constraint ux_canonical_outcome_versions_idempotency unique (idempotency_key),
  constraint ux_canonical_outcome_versions_outbox unique (outbox_event_id)
);

create index idx_canonical_outcome_versions_draw_current
  on game_engine.canonical_outcome_versions(draw_id, version_number desc);

create index idx_canonical_outcome_versions_certificate
  on game_engine.canonical_outcome_versions(outcome_certificate_id, outcome_certificate_hash);

create index idx_canonical_outcome_versions_previous
  on game_engine.canonical_outcome_versions(previous_outcome_version_id);

create table game_engine.outcome_settlement_requests (
  settlement_request_id uuid primary key,
  outcome_version_id uuid not null references game_engine.canonical_outcome_versions(outcome_version_id),
  draw_id uuid not null,
  request_kind text not null check (request_kind in ('Published', 'Corrected', 'Cancelled')),
  settlement_input_id uuid references game_engine.settlement_input_records(settlement_input_id),
  canonical_request_hash text not null check (canonical_request_hash like 'sha256:%'),
  idempotency_key text not null,
  correlation_id text not null,
  causation_id text not null,
  audit_reference text not null,
  outbox_event_id uuid not null references public.outbox_events(id),
  emitted_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_outcome_settlement_requests_version unique (outcome_version_id),
  constraint ux_outcome_settlement_requests_idempotency unique (idempotency_key),
  constraint ux_outcome_settlement_requests_outbox unique (outbox_event_id)
);

create index idx_outcome_settlement_requests_draw
  on game_engine.outcome_settlement_requests(draw_id, emitted_at);

create index idx_outcome_settlement_requests_input
  on game_engine.outcome_settlement_requests(settlement_input_id)
  where settlement_input_id is not null;

create or replace function game_engine.validate_canonical_outcome_version()
returns trigger
language plpgsql
as $$
declare
  source_record record;
  current_record record;
begin
  select
    oe.outcome_id,
    oe.draw_id,
    oe.outcome_payload,
    oe.canonical_outcome_hash,
    oe.generated_at
  into source_record
  from game_engine.outcome_certificates oc
  join game_engine.outcome_events oe on oe.outcome_id = oc.outcome_id
  where oc.certificate_id = new.outcome_certificate_id
    and oc.canonical_outcome_hash = new.outcome_certificate_hash;

  if not found then
    raise exception 'Canonical outcome publication requires verified Outcome Certificate evidence';
  end if;

  if source_record.outcome_id <> new.outcome_id
    or source_record.draw_id <> new.draw_id
    or source_record.outcome_payload <> new.outcome_payload
    or source_record.canonical_outcome_hash <> new.canonical_outcome_hash
    or source_record.generated_at <> new.generated_at then
    raise exception 'Canonical outcome publication does not match its Outcome Certificate evidence';
  end if;

  select outcome_version_id, version_number, version_kind, canonical_outcome_hash
  into current_record
  from game_engine.canonical_outcome_versions
  where draw_id = new.draw_id
  order by version_number desc
  limit 1;

  if new.version_kind = 'Published' then
    if found or new.previous_outcome_version_id is not null or new.version_number <> 1 then
      raise exception 'Initial publication must be the first version and cannot supersede an existing outcome';
    end if;
  else
    if not found
      or new.previous_outcome_version_id is distinct from current_record.outcome_version_id
      or new.version_number <> current_record.version_number + 1 then
      raise exception 'Correction or cancellation must supersede the exact current outcome version';
    end if;

    if current_record.version_kind = 'Cancelled' then
      raise exception 'A cancelled outcome is terminal';
    end if;

    if new.version_kind = 'Corrected'
      and new.canonical_outcome_hash = current_record.canonical_outcome_hash then
      raise exception 'A corrected outcome requires different certified outcome evidence';
    end if;
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_outcome_settlement_request()
returns trigger
language plpgsql
as $$
declare
  version_record record;
  input_record record;
  current_version_id uuid;
begin
  select draw_id, version_kind, outcome_certificate_id, outcome_certificate_hash
  into version_record
  from game_engine.canonical_outcome_versions
  where outcome_version_id = new.outcome_version_id;

  if not found
    or version_record.draw_id <> new.draw_id
    or version_record.version_kind <> new.request_kind then
    raise exception 'Settlement request does not match the canonical outcome version';
  end if;

  select outcome_version_id
  into current_version_id
  from game_engine.canonical_outcome_versions
  where draw_id = new.draw_id
  order by version_number desc
  limit 1;

  if current_version_id <> new.outcome_version_id then
    raise exception 'Settlement request requires the current canonical outcome version';
  end if;

  if new.request_kind = 'Cancelled' then
    if new.settlement_input_id is not null then
      raise exception 'Cancellation settlement requests cannot carry a SettlementInput';
    end if;
  else
    if new.settlement_input_id is null then
      raise exception 'Published and corrected outcomes require a SettlementInput';
    end if;

    select outcome_certificate_id, outcome_certificate_hash
    into input_record
    from game_engine.settlement_input_records
    where settlement_input_id = new.settlement_input_id;

    if not found
      or input_record.outcome_certificate_id <> version_record.outcome_certificate_id
      or input_record.outcome_certificate_hash <> version_record.outcome_certificate_hash then
      raise exception 'SettlementInput does not reference the canonical published Outcome Certificate';
    end if;
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_canonical_outcome_publication_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only; create a new canonical outcome version instead', tg_table_name;
end;
$$;

create trigger trg_validate_canonical_outcome_version
before insert on game_engine.canonical_outcome_versions
for each row execute function game_engine.validate_canonical_outcome_version();

create trigger trg_prevent_canonical_outcome_version_update
before update on game_engine.canonical_outcome_versions
for each row execute function game_engine.prevent_canonical_outcome_publication_mutation();

create trigger trg_prevent_canonical_outcome_version_delete
before delete on game_engine.canonical_outcome_versions
for each row execute function game_engine.prevent_canonical_outcome_publication_mutation();

create trigger trg_validate_outcome_settlement_request
before insert on game_engine.outcome_settlement_requests
for each row execute function game_engine.validate_outcome_settlement_request();

create trigger trg_prevent_outcome_settlement_request_update
before update on game_engine.outcome_settlement_requests
for each row execute function game_engine.prevent_canonical_outcome_publication_mutation();

create trigger trg_prevent_outcome_settlement_request_delete
before delete on game_engine.outcome_settlement_requests
for each row execute function game_engine.prevent_canonical_outcome_publication_mutation();

comment on table game_engine.canonical_outcome_versions is
  'Append-only canonical Outcome Authority publication chain. Corrections and cancellations are new versions; historical outcomes are never mutated.';

comment on table game_engine.outcome_settlement_requests is
  'Append-only, outbox-backed Settlement request evidence. One canonical outcome version emits at most one request and never calls Settlement directly.';
