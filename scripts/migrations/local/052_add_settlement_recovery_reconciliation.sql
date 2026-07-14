create table settlement_service.recovery_events (
  event_id uuid primary key,
  settlement_id uuid references settlement_service.authoritative_settlement_records(settlement_id),
  instruction_id uuid references settlement_service.financial_instructions(instruction_id),
  execution_attempt_id uuid references settlement_service.financial_instruction_execution_attempts(attempt_id),
  recovery_state text not null check (recovery_state in (
    'InstructionPending',
    'InstructionReady',
    'InstructionFailed',
    'InstructionUnknownResult',
    'SettlementPartiallyExecuted',
    'SettlementAwaitingRecovery',
    'SettlementAwaitingVerification',
    'SettlementCompleted',
    'SettlementFailed'
  )),
  decision text not null,
  verification_result text not null check (verification_result in ('Committed', 'NotCommitted', 'Unknown', 'NotRequired')),
  reason text,
  evidence_hash text not null unique,
  created_at timestamptz not null default now(),
  check (settlement_id is not null or instruction_id is not null)
);

create table settlement_service.reconciliation_events (
  event_id uuid primary key,
  settlement_id uuid not null references settlement_service.authoritative_settlement_records(settlement_id),
  instruction_id uuid not null references settlement_service.financial_instructions(instruction_id),
  execution_attempt_id uuid references settlement_service.financial_instruction_execution_attempts(attempt_id),
  reconciliation_status text not null check (reconciliation_status in (
    'Reconciled',
    'MissingTargetRecord',
    'Mismatch',
    'AwaitingVerification'
  )),
  local_payload_hash text not null,
  target_idempotency_key text not null,
  external_reference_type text,
  external_reference_id text,
  target_response_hash text,
  evidence_hash text not null unique,
  created_at timestamptz not null default now()
);

create index idx_recovery_events_settlement
  on settlement_service.recovery_events(settlement_id, created_at);

create index idx_recovery_events_instruction
  on settlement_service.recovery_events(instruction_id, created_at);

create index idx_recovery_events_state
  on settlement_service.recovery_events(recovery_state, created_at);

create index idx_recovery_events_attempt
  on settlement_service.recovery_events(execution_attempt_id);

create index idx_reconciliation_events_settlement
  on settlement_service.reconciliation_events(settlement_id, created_at);

create index idx_reconciliation_events_instruction
  on settlement_service.reconciliation_events(instruction_id, created_at);

create index idx_reconciliation_events_status
  on settlement_service.reconciliation_events(reconciliation_status, created_at);

create index idx_reconciliation_events_target_idempotency
  on settlement_service.reconciliation_events(target_idempotency_key);

create or replace function settlement_service.prevent_recovery_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'recovery_events are append-only; append a new recovery event instead';
end;
$$;

create trigger trg_prevent_recovery_event_update
before update on settlement_service.recovery_events
for each row execute function settlement_service.prevent_recovery_event_mutation();

create trigger trg_prevent_recovery_event_delete
before delete on settlement_service.recovery_events
for each row execute function settlement_service.prevent_recovery_event_mutation();

create or replace function settlement_service.prevent_reconciliation_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'reconciliation_events are append-only; append a new reconciliation event instead';
end;
$$;

create trigger trg_prevent_reconciliation_event_update
before update on settlement_service.reconciliation_events
for each row execute function settlement_service.prevent_reconciliation_event_mutation();

create trigger trg_prevent_reconciliation_event_delete
before delete on settlement_service.reconciliation_events
for each row execute function settlement_service.prevent_reconciliation_event_mutation();

comment on table settlement_service.recovery_events is
  'Append-only Settlement Authority recovery/resume decision evidence. It never mutates SettlementRecords or FinancialInstructions.';

comment on table settlement_service.reconciliation_events is
  'Append-only instruction-level reconciliation evidence comparing local financial instructions with target idempotency/reference evidence.';
