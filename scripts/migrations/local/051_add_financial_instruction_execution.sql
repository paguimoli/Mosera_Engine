create table settlement_service.financial_instruction_execution_attempts (
  attempt_id uuid primary key,
  instruction_id uuid not null references settlement_service.financial_instructions(instruction_id),
  settlement_id uuid not null references settlement_service.authoritative_settlement_records(settlement_id),
  attempt_number integer not null,
  status text not null,
  target_service text not null,
  target_idempotency_key text not null,
  external_reference_type text,
  external_reference_id text,
  target_response_hash text,
  error_classification text,
  error_message text,
  evidence_hash text not null,
  created_at timestamptz not null default now(),
  check (attempt_number > 0),
  check (status in ('Posted', 'Skipped', 'Failed', 'Reused', 'RecoveryVerified', 'Conflict')),
  check (target_service in ('ledger-service', 'credit-wallet-service')),
  check (target_idempotency_key <> ''),
  check (target_response_hash is null or target_response_hash like 'sha256:%'),
  check (evidence_hash like 'sha256:%'),
  unique (instruction_id, attempt_number)
);

create unique index idx_financial_instruction_execution_terminal
  on settlement_service.financial_instruction_execution_attempts(instruction_id)
  where status in ('Posted', 'Skipped');

create unique index idx_financial_instruction_execution_target_idempotency
  on settlement_service.financial_instruction_execution_attempts(target_service, target_idempotency_key)
  where status in ('Posted', 'Skipped', 'RecoveryVerified', 'Reused');

create index idx_financial_instruction_execution_settlement
  on settlement_service.financial_instruction_execution_attempts(settlement_id, attempt_number);

create index idx_financial_instruction_execution_status
  on settlement_service.financial_instruction_execution_attempts(status, target_service);

create or replace function settlement_service.prevent_financial_instruction_execution_attempt_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'financial_instruction_execution_attempts are append-only; append a new execution attempt instead';
end;
$$;

create trigger trg_prevent_financial_instruction_execution_attempt_update
before update on settlement_service.financial_instruction_execution_attempts
for each row execute function settlement_service.prevent_financial_instruction_execution_attempt_mutation();

create trigger trg_prevent_financial_instruction_execution_attempt_delete
before delete on settlement_service.financial_instruction_execution_attempts
for each row execute function settlement_service.prevent_financial_instruction_execution_attempt_mutation();

comment on table settlement_service.financial_instruction_execution_attempts is
  'Append-only execution evidence for durable financial instructions. Calls target Ledger/Credit services through HTTP contracts only; no direct Ledger/Credit schema mutation, commissions, taxes, cashier logic, or reconciliation.';
