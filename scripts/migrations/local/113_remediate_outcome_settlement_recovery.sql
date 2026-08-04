create table game_engine.canonical_settlement_event_processing_evidence (
  processing_evidence_id uuid primary key,
  event_id text not null,
  settlement_request_id uuid,
  outcome_version_id uuid,
  classification text not null check (classification in (
    'SUCCESS',
    'IDEMPOTENT_DUPLICATE',
    'TRANSIENT_RETRY',
    'GOVERNED_RECOVERY_REQUIRED',
    'TERMINAL_INVALID',
    'LEGACY_UNPROCESSABLE'
  )),
  canonical_message_hash text not null check (canonical_message_hash like 'sha256:%'),
  attempt_number integer not null check (attempt_number > 0),
  reason text not null check (btrim(reason) <> ''),
  correlation_id text,
  created_at timestamptz not null default now(),
  constraint ux_canonical_settlement_processing_attempt
    unique (event_id, attempt_number)
);

create index idx_canonical_settlement_processing_request
  on game_engine.canonical_settlement_event_processing_evidence(
    settlement_request_id, created_at desc);

create index idx_canonical_settlement_processing_classification
  on game_engine.canonical_settlement_event_processing_evidence(
    classification, created_at desc);

create table game_engine.canonical_outcome_recovery_classifications (
  recovery_classification_id uuid primary key,
  outcome_version_id uuid not null
    references game_engine.canonical_outcome_versions(outcome_version_id),
  classification text not null check (classification in (
    'RECOVERABLE_MISSING_WORK',
    'GOVERNED_MANUAL_INTERVENTION_REQUIRED',
    'LEGACY_INSUFFICIENT_EVIDENCE',
    'TERMINAL_INVALID',
    'COMPLETED_STALE_PROJECTION'
  )),
  evidence_state_hash text not null check (evidence_state_hash like 'sha256:%'),
  reason text not null check (btrim(reason) <> ''),
  correlation_id text not null,
  actor_reference text not null,
  classified_at timestamptz not null default now(),
  constraint ux_canonical_outcome_recovery_classification
    unique (outcome_version_id, classification, evidence_state_hash)
);

create index idx_canonical_outcome_recovery_classification_state
  on game_engine.canonical_outcome_recovery_classifications(
    classification, classified_at desc);

create table game_engine.canonical_settlement_dlq_replay_evidence (
  replay_evidence_id uuid primary key,
  operation_id uuid not null,
  event_id text not null,
  source_queue text not null,
  original_routing_key text not null,
  original_envelope jsonb not null,
  original_body_base64 text not null check (btrim(original_body_base64) <> ''),
  original_properties jsonb not null default '{}'::jsonb,
  original_envelope_hash text not null check (original_envelope_hash like 'sha256:%'),
  replay_result text not null check (replay_result in (
    'REPLAYED', 'TERMINAL_CLASSIFIED', 'BLOCKED'
  )),
  approval_token_hash text not null check (approval_token_hash like 'sha256:%'),
  operator_reference text not null,
  reason text not null,
  replayed_at timestamptz not null default now(),
  constraint ux_canonical_settlement_dlq_replay_event
    unique (operation_id, event_id)
);

create index idx_canonical_settlement_dlq_replay_result
  on game_engine.canonical_settlement_dlq_replay_evidence(
    replay_result, replayed_at desc);

create trigger trg_prevent_canonical_settlement_processing_update
before update on game_engine.canonical_settlement_event_processing_evidence
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

create trigger trg_prevent_canonical_settlement_processing_delete
before delete on game_engine.canonical_settlement_event_processing_evidence
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

create trigger trg_prevent_canonical_outcome_recovery_classification_update
before update on game_engine.canonical_outcome_recovery_classifications
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

create trigger trg_prevent_canonical_outcome_recovery_classification_delete
before delete on game_engine.canonical_outcome_recovery_classifications
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

create trigger trg_prevent_canonical_settlement_dlq_replay_update
before update on game_engine.canonical_settlement_dlq_replay_evidence
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

create trigger trg_prevent_canonical_settlement_dlq_replay_delete
before delete on game_engine.canonical_settlement_dlq_replay_evidence
for each row execute function game_engine.prevent_canonical_orchestration_mutation();

create or replace function game_engine.validate_canonical_draw_completion()
returns trigger
language plpgsql
as $$
declare
  evidence_record record;
begin
  if new.settlement_acknowledgement_id is null then
    select
      version.draw_id,
      version.version_kind,
      request.settlement_input_id,
      consumption.outcome_version_id,
      consumption.settlement_request_id
    into evidence_record
    from game_engine.outcome_settlement_consumptions consumption
    join game_engine.outcome_settlement_requests request
      on request.settlement_request_id = consumption.settlement_request_id
    join game_engine.canonical_outcome_versions version
      on version.outcome_version_id = consumption.outcome_version_id
    where consumption.consumption_id = new.consumption_id;

    if evidence_record is null
       or evidence_record.version_kind <> 'Cancelled'
       or evidence_record.settlement_input_id is not null
       or new.completion_kind <> 'Cancelled'
       or evidence_record.draw_id <> new.draw_id
       or evidence_record.outcome_version_id <> new.outcome_version_id
       or evidence_record.settlement_request_id <> new.settlement_request_id then
      raise exception 'Non-financial draw completion requires exact canonical cancellation evidence.';
    end if;

    return new;
  end if;

  select
    version.draw_id,
    version.version_kind,
    acknowledgement.outcome_version_id,
    acknowledgement.settlement_request_id,
    acknowledgement.consumption_id,
    acknowledgement.acknowledgement_status
  into evidence_record
  from game_engine.outcome_settlement_acknowledgements acknowledgement
  join game_engine.canonical_outcome_versions version
    on version.outcome_version_id = acknowledgement.outcome_version_id
  where acknowledgement.settlement_acknowledgement_id = new.settlement_acknowledgement_id;

  if evidence_record is null
     or evidence_record.acknowledgement_status <> 'ACKNOWLEDGED'
     or evidence_record.draw_id <> new.draw_id
     or evidence_record.version_kind <> new.completion_kind
     or evidence_record.outcome_version_id <> new.outcome_version_id
     or evidence_record.settlement_request_id <> new.settlement_request_id
     or evidence_record.consumption_id <> new.consumption_id then
    raise exception 'Draw completion does not match authoritative Settlement acknowledgement.';
  end if;

  return new;
end;
$$;

comment on table game_engine.canonical_settlement_event_processing_evidence is
  'Append-only canonical Settlement consumer result and retry classification evidence.';
comment on table game_engine.canonical_outcome_recovery_classifications is
  'Append-only durable classification of canonical Outcome recovery candidates by immutable evidence state.';
comment on table game_engine.canonical_settlement_dlq_replay_evidence is
  'Append-only governed replay or terminal classification evidence for canonical Settlement DLQ envelopes.';
