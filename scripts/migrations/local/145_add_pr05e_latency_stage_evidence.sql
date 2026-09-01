begin;

alter table game_engine.canonical_settlement_event_processing_evidence
  add column connection_requested_at timestamptz,
  add column connection_acquired_at timestamptz,
  add column lock_attempted_at timestamptz,
  add column lock_acquired_at timestamptz,
  add column claim_acquired_at timestamptz,
  add column authority_started_at timestamptz,
  add column authority_completed_at timestamptz,
  add column persistence_started_at timestamptz,
  add column persistence_completed_at timestamptz,
  add constraint chk_canonical_settlement_detailed_timing_order check (
    (connection_requested_at is null or connection_acquired_at is null
      or connection_acquired_at >= connection_requested_at)
    and (connection_acquired_at is null or lock_attempted_at is null
      or lock_attempted_at >= connection_acquired_at)
    and (lock_attempted_at is null or lock_acquired_at is null
      or lock_acquired_at >= lock_attempted_at)
    and (lock_acquired_at is null or claim_acquired_at is null
      or claim_acquired_at >= lock_acquired_at)
    and (claim_acquired_at is null or processing_started_at is null
      or processing_started_at >= claim_acquired_at)
    and (processing_started_at is null or authority_started_at is null
      or authority_started_at >= processing_started_at)
    and (authority_started_at is null or authority_completed_at is null
      or authority_completed_at >= authority_started_at)
    and (authority_completed_at is null or persistence_started_at is null
      or persistence_started_at >= authority_completed_at)
    and (persistence_started_at is null or persistence_completed_at is null
      or persistence_completed_at >= persistence_started_at)
  );

create table game_engine.math_evaluation_processing_evidence (
  processing_evidence_id uuid primary key,
  evaluation_request_id uuid not null
    references game_engine.math_evaluation_requests(evaluation_request_id),
  attempt_number integer not null check (attempt_number > 0),
  worker_received_at timestamptz not null,
  work_created_at timestamptz not null,
  work_published_at timestamptz not null,
  claim_attempted_at timestamptz not null,
  connection_requested_at timestamptz not null,
  connection_acquired_at timestamptz not null,
  claim_acquired_at timestamptz not null,
  processing_started_at timestamptz not null,
  math_started_at timestamptz not null,
  math_completed_at timestamptz not null,
  persistence_started_at timestamptz not null,
  persistence_completed_at timestamptz not null default clock_timestamp(),
  authority_completed_at timestamptz not null default clock_timestamp(),
  canonical_evidence_hash text not null check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  constraint ux_math_evaluation_processing_attempt
    unique (evaluation_request_id, attempt_number),
  constraint chk_math_evaluation_processing_timing_order check (
    work_published_at >= work_created_at
    and claim_attempted_at >= worker_received_at
    and connection_requested_at >= claim_attempted_at
    and connection_acquired_at >= connection_requested_at
    and claim_acquired_at >= connection_acquired_at
    and processing_started_at >= claim_acquired_at
    and math_started_at >= processing_started_at
    and math_completed_at >= math_started_at
    and persistence_started_at >= math_completed_at
    and persistence_completed_at >= persistence_started_at
    and authority_completed_at >= persistence_completed_at
  )
);

create index idx_math_evaluation_processing_latency
  on game_engine.math_evaluation_processing_evidence(
    evaluation_request_id, authority_completed_at);

create or replace function game_engine.prevent_pr05e_timing_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only; append new processing evidence instead', tg_table_name;
end;
$$;

create trigger trg_math_evaluation_processing_evidence_immutable
before update or delete on game_engine.math_evaluation_processing_evidence
for each row execute function game_engine.prevent_pr05e_timing_evidence_mutation();

comment on table game_engine.math_evaluation_processing_evidence is
  'Append-only PR-05E stage timing evidence for the canonical durable Math Authority path; no queue or broker is implied by work_published_at.';
comment on column game_engine.math_evaluation_processing_evidence.work_published_at is
  'For the in-process Math Authority path this equals durable work creation; Math does not traverse RabbitMQ.';

commit;
