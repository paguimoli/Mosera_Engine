create table settlement_service.resettlement_requests (
  resettlement_request_id uuid primary key,
  idempotency_key text not null unique,
  canonical_request_hash text not null,
  original_settlement_id uuid not null references settlement_service.authoritative_settlement_records(settlement_id),
  original_settlement_hash text not null,
  original_settlement_input_id uuid not null references game_engine.settlement_input_records(settlement_input_id),
  original_settlement_input_hash text not null,
  corrected_settlement_input_id uuid not null references game_engine.settlement_input_records(settlement_input_id),
  corrected_settlement_input_hash text not null,
  original_math_evaluation_certificate_id uuid not null,
  original_math_evaluation_certificate_hash text not null,
  corrected_math_evaluation_certificate_id uuid not null,
  corrected_math_evaluation_certificate_hash text not null,
  reason_code text not null,
  requestor_reference text not null,
  approval_metadata jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null,
  provenance jsonb not null default '{}'::jsonb,
  mode text not null,
  created_at timestamptz not null default now(),
  check (canonical_request_hash like 'sha256:%'),
  check (original_settlement_hash like 'sha256:%'),
  check (original_settlement_input_hash like 'sha256:%'),
  check (corrected_settlement_input_hash like 'sha256:%'),
  check (original_math_evaluation_certificate_hash like 'sha256:%'),
  check (corrected_math_evaluation_certificate_hash like 'sha256:%'),
  check (reason_code in ('MATH_CORRECTION', 'RESULT_CORRECTION', 'VOID_CORRECTION', 'OPERATOR_CORRECTION')),
  check (requestor_reference <> ''),
  check (jsonb_typeof(approval_metadata) = 'object'),
  check (jsonb_typeof(provenance) = 'object'),
  check (mode = 'DryRun'),
  check (original_settlement_input_id <> corrected_settlement_input_id),
  check (original_settlement_input_hash <> corrected_settlement_input_hash),
  unique (original_settlement_id, corrected_settlement_input_id)
);

create table settlement_service.resettlement_records (
  resettlement_record_id uuid primary key,
  resettlement_request_id uuid not null unique references settlement_service.resettlement_requests(resettlement_request_id),
  lifecycle_state text not null,
  original_settlement_id uuid not null references settlement_service.authoritative_settlement_records(settlement_id),
  original_settlement_hash text not null,
  original_settlement_input_id uuid not null references game_engine.settlement_input_records(settlement_input_id),
  reversal_settlement_id uuid not null unique references settlement_service.authoritative_settlement_records(settlement_id),
  reversal_settlement_hash text not null,
  corrected_settlement_input_id uuid not null references game_engine.settlement_input_records(settlement_input_id),
  corrected_settlement_id uuid not null unique references settlement_service.authoritative_settlement_records(settlement_id),
  corrected_settlement_hash text not null,
  chain_hash text not null unique,
  created_at timestamptz not null default now(),
  check (lifecycle_state in (
    'Requested',
    'Validated',
    'ReversalPrepared',
    'ReversalExecuting',
    'ReversalCompleted',
    'CorrectionPrepared',
    'CorrectionExecuting',
    'Completed',
    'Failed',
    'AwaitingVerification',
    'CancelledBeforeExecution'
  )),
  check (original_settlement_hash like 'sha256:%'),
  check (reversal_settlement_hash like 'sha256:%'),
  check (corrected_settlement_hash like 'sha256:%'),
  check (chain_hash like 'sha256:%')
);

create table settlement_service.resettlement_events (
  event_id uuid primary key,
  resettlement_request_id uuid not null references settlement_service.resettlement_requests(resettlement_request_id),
  resettlement_record_id uuid references settlement_service.resettlement_records(resettlement_record_id),
  lifecycle_state text not null,
  event_type text not null,
  evidence_hash text not null unique,
  errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  check (lifecycle_state in (
    'Requested',
    'Validated',
    'ReversalPrepared',
    'ReversalExecuting',
    'ReversalCompleted',
    'CorrectionPrepared',
    'CorrectionExecuting',
    'Completed',
    'Failed',
    'AwaitingVerification',
    'CancelledBeforeExecution'
  )),
  check (event_type <> ''),
  check (evidence_hash like 'sha256:%'),
  check (jsonb_typeof(errors) = 'array')
);

create index idx_resettlement_requests_original
  on settlement_service.resettlement_requests(original_settlement_id, corrected_settlement_input_id);

create index idx_resettlement_requests_corrected_input
  on settlement_service.resettlement_requests(corrected_settlement_input_id, corrected_settlement_input_hash);

create index idx_resettlement_requests_hash
  on settlement_service.resettlement_requests(canonical_request_hash);

create index idx_resettlement_records_original
  on settlement_service.resettlement_records(original_settlement_id);

create index idx_resettlement_records_reversal
  on settlement_service.resettlement_records(reversal_settlement_id);

create index idx_resettlement_records_corrected
  on settlement_service.resettlement_records(corrected_settlement_id);

create index idx_resettlement_records_state
  on settlement_service.resettlement_records(lifecycle_state);

create index idx_resettlement_events_request
  on settlement_service.resettlement_events(resettlement_request_id, created_at);

create index idx_resettlement_events_state
  on settlement_service.resettlement_events(lifecycle_state, created_at);

create or replace function settlement_service.prevent_resettlement_request_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'resettlement_requests are append-only; append a new governed request instead';
end;
$$;

create trigger trg_prevent_resettlement_request_update
before update on settlement_service.resettlement_requests
for each row execute function settlement_service.prevent_resettlement_request_mutation();

create trigger trg_prevent_resettlement_request_delete
before delete on settlement_service.resettlement_requests
for each row execute function settlement_service.prevent_resettlement_request_mutation();

create or replace function settlement_service.prevent_resettlement_record_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'resettlement_records are append-only; append evidence instead';
end;
$$;

create trigger trg_prevent_resettlement_record_update
before update on settlement_service.resettlement_records
for each row execute function settlement_service.prevent_resettlement_record_mutation();

create trigger trg_prevent_resettlement_record_delete
before delete on settlement_service.resettlement_records
for each row execute function settlement_service.prevent_resettlement_record_mutation();

create or replace function settlement_service.prevent_resettlement_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'resettlement_events are append-only; append a new event instead';
end;
$$;

create trigger trg_prevent_resettlement_event_update
before update on settlement_service.resettlement_events
for each row execute function settlement_service.prevent_resettlement_event_mutation();

create trigger trg_prevent_resettlement_event_delete
before delete on settlement_service.resettlement_events
for each row execute function settlement_service.prevent_resettlement_event_mutation();

comment on table settlement_service.resettlement_requests is
  'Append-only governed ResettlementRequests linking original and corrected SettlementInput-backed evidence. Production mode is disabled.';

comment on table settlement_service.resettlement_records is
  'Append-only ResettlementChain records linking original SettlementRecord, compensating reversal record, corrected SettlementRecord, and chain hash.';

comment on table settlement_service.resettlement_events is
  'Append-only resettlement lifecycle/recovery evidence. It never mutates original settlement or instruction rows.';
