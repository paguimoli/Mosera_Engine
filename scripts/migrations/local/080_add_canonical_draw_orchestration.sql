create table game_engine.outcome_settlement_consumptions (
  consumption_id uuid primary key,
  settlement_request_id uuid not null
    references game_engine.outcome_settlement_requests(settlement_request_id),
  outcome_version_id uuid not null
    references game_engine.canonical_outcome_versions(outcome_version_id),
  outbox_event_id uuid not null references public.outbox_events(id),
  consumer_name text not null,
  canonical_message_hash text not null check (canonical_message_hash like 'sha256:%'),
  correlation_id text not null,
  audit_reference text not null,
  consumed_at timestamptz not null default now(),
  constraint ux_outcome_settlement_consumptions_request unique (settlement_request_id),
  constraint ux_outcome_settlement_consumptions_outbox unique (outbox_event_id)
);

create index idx_outcome_settlement_consumptions_version
  on game_engine.outcome_settlement_consumptions(outcome_version_id, consumed_at desc);

create table game_engine.canonical_draw_completion_evidence (
  completion_id uuid primary key,
  draw_id uuid not null,
  outcome_version_id uuid not null
    references game_engine.canonical_outcome_versions(outcome_version_id),
  settlement_request_id uuid not null
    references game_engine.outcome_settlement_requests(settlement_request_id),
  consumption_id uuid not null
    references game_engine.outcome_settlement_consumptions(consumption_id),
  completion_kind text not null check (completion_kind in ('Published', 'Corrected', 'Cancelled')),
  canonical_evidence_hash text not null check (canonical_evidence_hash like 'sha256:%'),
  completed_at timestamptz not null default now(),
  constraint ux_canonical_draw_completion_version unique (outcome_version_id),
  constraint ux_canonical_draw_completion_request unique (settlement_request_id),
  constraint ux_canonical_draw_completion_consumption unique (consumption_id)
);

create index idx_canonical_draw_completion_draw
  on game_engine.canonical_draw_completion_evidence(draw_id, completed_at desc);

create table game_engine.canonical_outcome_recovery_events (
  recovery_event_id uuid primary key,
  outcome_version_id uuid not null
    references game_engine.canonical_outcome_versions(outcome_version_id),
  settlement_request_id uuid
    references game_engine.outcome_settlement_requests(settlement_request_id),
  recovery_action text not null
    check (recovery_action in ('REQUEST_CREATED', 'EVENT_REQUEUED', 'BLOCKED')),
  attempt_number integer not null check (attempt_number > 0),
  reason text not null,
  canonical_evidence_hash text not null check (canonical_evidence_hash like 'sha256:%'),
  created_at timestamptz not null default now(),
  constraint ux_canonical_outcome_recovery_attempt
    unique (outcome_version_id, recovery_action, attempt_number)
);

create index idx_canonical_outcome_recovery_version
  on game_engine.canonical_outcome_recovery_events(outcome_version_id, created_at desc);

create table game_engine.canonical_runtime_components (
  component_name text primary key,
  runtime_version text not null,
  runtime_kind text not null check (runtime_kind = 'COMPILED_JAVASCRIPT'),
  status text not null check (status in ('READY', 'DEGRADED', 'STOPPED')),
  last_seen_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create or replace function game_engine.validate_outcome_settlement_consumption()
returns trigger
language plpgsql
as $$
declare
  request_record record;
begin
  select
    request.settlement_request_id,
    request.outcome_version_id,
    request.outbox_event_id,
    event.event_type
  into request_record
  from game_engine.outcome_settlement_requests request
  join public.outbox_events event on event.id = request.outbox_event_id
  where request.settlement_request_id = new.settlement_request_id;

  if request_record is null then
    raise exception 'Canonical Settlement request evidence was not found.';
  end if;

  if request_record.outcome_version_id <> new.outcome_version_id
     or request_record.outbox_event_id <> new.outbox_event_id
     or request_record.event_type <> 'settlement.requested' then
    raise exception 'Settlement consumption does not match canonical request evidence.';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_canonical_draw_completion()
returns trigger
language plpgsql
as $$
declare
  evidence_record record;
begin
  select
    version.draw_id,
    version.version_kind,
    consumption.outcome_version_id,
    consumption.settlement_request_id
  into evidence_record
  from game_engine.outcome_settlement_consumptions consumption
  join game_engine.canonical_outcome_versions version
    on version.outcome_version_id = consumption.outcome_version_id
  where consumption.consumption_id = new.consumption_id;

  if evidence_record is null then
    raise exception 'Canonical Settlement consumption evidence was not found.';
  end if;

  if evidence_record.draw_id <> new.draw_id
     or evidence_record.version_kind <> new.completion_kind
     or evidence_record.outcome_version_id <> new.outcome_version_id
     or evidence_record.settlement_request_id <> new.settlement_request_id then
    raise exception 'Draw completion does not match canonical consumption evidence.';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_canonical_orchestration_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only; % is not allowed.', tg_table_name, tg_op;
end;
$$;

create trigger trg_validate_outcome_settlement_consumption
before insert on game_engine.outcome_settlement_consumptions
for each row execute function game_engine.validate_outcome_settlement_consumption();

create trigger trg_prevent_outcome_settlement_consumption_update
before update on game_engine.outcome_settlement_consumptions
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

create trigger trg_prevent_outcome_settlement_consumption_delete
before delete on game_engine.outcome_settlement_consumptions
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

create trigger trg_validate_canonical_draw_completion
before insert on game_engine.canonical_draw_completion_evidence
for each row execute function game_engine.validate_canonical_draw_completion();

create trigger trg_prevent_canonical_draw_completion_update
before update on game_engine.canonical_draw_completion_evidence
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

create trigger trg_prevent_canonical_draw_completion_delete
before delete on game_engine.canonical_draw_completion_evidence
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

create trigger trg_prevent_canonical_outcome_recovery_update
before update on game_engine.canonical_outcome_recovery_events
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

create trigger trg_prevent_canonical_outcome_recovery_delete
before delete on game_engine.canonical_outcome_recovery_events
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

comment on table game_engine.outcome_settlement_consumptions is
  'Append-only exactly-once receipt evidence written by the existing Settlement workload consumer.';

comment on table game_engine.canonical_draw_completion_evidence is
  'Append-only draw completion evidence. Completion is valid only after canonical publication and Settlement request consumption.';

comment on table game_engine.canonical_outcome_recovery_events is
  'Append-only evidence for missing-request creation, safe outbox replay, and fail-closed recovery decisions.';

comment on table game_engine.canonical_runtime_components is
  'Operational heartbeat state for compiled canonical outbox and Settlement worker runtimes; not authority evidence.';
