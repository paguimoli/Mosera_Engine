alter table game_engine.canonical_outcome_versions
  add constraint fk_canonical_outcome_draw_instance
    foreign key (draw_id)
    references game_engine.draw_schedules(id)
    on delete restrict;

alter table game_engine.canonical_outcome_recovery_events
  drop constraint canonical_outcome_recovery_events_outcome_version_id_fkey,
  add constraint fk_canonical_recovery_outcome_version
    foreign key (outcome_version_id)
    references game_engine.canonical_outcome_versions(outcome_version_id)
    on delete restrict,
  drop constraint canonical_outcome_recovery_events_settlement_request_id_fkey,
  add constraint fk_canonical_recovery_settlement_request
    foreign key (settlement_request_id)
    references game_engine.outcome_settlement_requests(settlement_request_id)
    on delete restrict;

create table game_engine.canonical_outcome_lifecycle_events (
  lifecycle_event_id uuid primary key,
  operation text not null check (
    operation in ('RECOVERY', 'CORRECTION', 'CANCELLATION', 'REPLAY_VERIFIED', 'REPLAY_REJECTED')
  ),
  outcome_version_id uuid not null
    references game_engine.canonical_outcome_versions(outcome_version_id) on delete restrict,
  draw_id uuid not null
    references game_engine.draw_schedules(id) on delete restrict,
  outcome_certificate_id uuid not null
    references game_engine.outcome_certificates(certificate_id) on delete restrict,
  provider_evidence_id uuid not null
    references game_engine.outcome_provider_execution_evidence(evidence_id) on delete restrict,
  previous_outcome_version_id uuid
    references game_engine.canonical_outcome_versions(outcome_version_id) on delete restrict,
  settlement_request_id uuid
    references game_engine.outcome_settlement_requests(settlement_request_id) on delete restrict,
  settlement_input_id uuid
    references game_engine.settlement_input_records(settlement_input_id) on delete restrict,
  actor_reference text not null check (btrim(actor_reference) <> ''),
  reason_code text not null check (btrim(reason_code) <> ''),
  correlation_id text not null check (btrim(correlation_id) <> ''),
  causation_id text not null check (btrim(causation_id) <> ''),
  canonical_request_hash text not null check (canonical_request_hash like 'sha256:%'),
  evidence_hash text not null check (evidence_hash like 'sha256:%'),
  idempotency_key text not null,
  created_at timestamptz not null,
  constraint ux_canonical_outcome_lifecycle_idempotency unique (idempotency_key)
);

create index idx_canonical_outcome_lifecycle_draw
  on game_engine.canonical_outcome_lifecycle_events(draw_id, created_at, lifecycle_event_id);

create index idx_canonical_outcome_lifecycle_version
  on game_engine.canonical_outcome_lifecycle_events(outcome_version_id, operation, created_at);

create or replace function game_engine.validate_canonical_outcome_lifecycle_version()
returns trigger
language plpgsql
as $$
declare
  previous_record game_engine.canonical_outcome_versions%rowtype;
begin
  if new.version_kind = 'Published' then
    return new;
  end if;

  select * into previous_record
  from game_engine.canonical_outcome_versions
  where outcome_version_id = new.previous_outcome_version_id;
  if not found or previous_record.draw_id <> new.draw_id then
    raise exception 'Lifecycle change must reference the exact prior outcome version';
  end if;

  if new.version_kind = 'Cancelled' and (
    new.outcome_id <> previous_record.outcome_id
    or new.outcome_certificate_id <> previous_record.outcome_certificate_id
    or new.outcome_certificate_hash <> previous_record.outcome_certificate_hash
    or new.provider_evidence_id <> previous_record.provider_evidence_id
    or new.provider_execution_id <> previous_record.provider_execution_id
    or new.provider_evidence_hash <> previous_record.provider_evidence_hash
    or new.canonical_outcome_hash <> previous_record.canonical_outcome_hash
    or new.validated_outcome_hash <> previous_record.validated_outcome_hash
  ) then
    raise exception 'Cancellation must retain the exact current certified outcome evidence';
  end if;

  return new;
end;
$$;

create trigger trg_validate_canonical_outcome_lifecycle_version
before insert on game_engine.canonical_outcome_versions
for each row execute function game_engine.validate_canonical_outcome_lifecycle_version();

create or replace function game_engine.validate_canonical_outcome_lifecycle_event()
returns trigger
language plpgsql
as $$
declare
  outcome_record game_engine.canonical_outcome_versions%rowtype;
begin
  select * into outcome_record
  from game_engine.canonical_outcome_versions
  where outcome_version_id = new.outcome_version_id;
  if not found
    or outcome_record.draw_id <> new.draw_id
    or outcome_record.outcome_certificate_id <> new.outcome_certificate_id
    or outcome_record.provider_evidence_id <> new.provider_evidence_id
    or outcome_record.previous_outcome_version_id is distinct from new.previous_outcome_version_id then
    raise exception 'Lifecycle evidence does not bind the exact canonical outcome version';
  end if;

  if new.operation = 'CORRECTION' and outcome_record.version_kind <> 'Corrected' then
    raise exception 'Correction evidence requires a corrected canonical outcome version';
  end if;
  if new.operation = 'CANCELLATION' and outcome_record.version_kind <> 'Cancelled' then
    raise exception 'Cancellation evidence requires a cancelled canonical outcome version';
  end if;
  if new.settlement_request_id is not null and not exists (
    select 1 from game_engine.outcome_settlement_requests request
    where request.settlement_request_id = new.settlement_request_id
      and request.outcome_version_id = new.outcome_version_id
      and request.settlement_input_id is not distinct from new.settlement_input_id
  ) then
    raise exception 'Lifecycle evidence Settlement references do not match the canonical outcome';
  end if;
  return new;
end;
$$;

create trigger trg_validate_canonical_outcome_lifecycle_event
before insert on game_engine.canonical_outcome_lifecycle_events
for each row execute function game_engine.validate_canonical_outcome_lifecycle_event();

create trigger trg_prevent_canonical_outcome_lifecycle_event_update
before update on game_engine.canonical_outcome_lifecycle_events
for each row execute function game_engine.prevent_canonical_outcome_publication_mutation();

create trigger trg_prevent_canonical_outcome_lifecycle_event_delete
before delete on game_engine.canonical_outcome_lifecycle_events
for each row execute function game_engine.prevent_canonical_outcome_publication_mutation();

comment on table game_engine.canonical_outcome_lifecycle_events is
  'Append-only audit evidence owned by Canonical Outcome Lifecycle Authority for recovery, correction, cancellation, and evidence-only replay.';
