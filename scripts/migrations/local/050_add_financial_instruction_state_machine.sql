create table settlement_service.financial_instructions (
  instruction_id uuid primary key,
  settlement_id uuid not null references settlement_service.authoritative_settlement_records(settlement_id),
  settlement_request_id uuid not null references settlement_service.settlement_requests(settlement_request_id),
  instruction_type text not null,
  instruction_status text not null,
  canonical_payload_hash text not null unique,
  idempotency_key text not null unique,
  target_service text not null,
  instruction_sequence integer not null,
  attempt_count integer not null,
  created_at timestamptz not null,
  completed_at timestamptz,
  failure_reason text,
  provenance jsonb not null default '{}'::jsonb,
  check (instruction_type in (
    'LEDGER_PAYOUT',
    'LEDGER_REFUND',
    'LEDGER_REVERSAL',
    'LEDGER_NOOP',
    'CREDIT_APPLY',
    'CREDIT_RELEASE',
    'CREDIT_REFUND',
    'CREDIT_NOOP'
  )),
  check (instruction_status in (
    'Pending',
    'Ready',
    'Skipped',
    'Failed',
    'Compensated',
    'Posted'
  )),
  check (instruction_status <> 'Posted'),
  check (canonical_payload_hash like 'sha256:%'),
  check (idempotency_key <> ''),
  check (target_service in ('ledger-service', 'credit-wallet-service')),
  check (instruction_sequence > 0),
  check (attempt_count >= 0),
  check (jsonb_typeof(provenance) = 'object'),
  unique (settlement_id, instruction_type)
);

create table settlement_service.financial_instruction_attempts (
  attempt_id uuid primary key,
  settlement_id uuid not null references settlement_service.authoritative_settlement_records(settlement_id),
  attempt_number integer not null,
  status text not null,
  instruction_set_hash text not null,
  evidence_hash text not null,
  errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  check (attempt_number > 0),
  check (status in ('Generated', 'Reused', 'Conflict', 'ReplayVerified', 'ReplayMismatch')),
  check (instruction_set_hash like 'sha256:%'),
  check (evidence_hash like 'sha256:%'),
  check (jsonb_typeof(errors) = 'array'),
  unique (settlement_id, attempt_number)
);

create index idx_financial_instructions_settlement
  on settlement_service.financial_instructions(settlement_id, instruction_sequence);

create index idx_financial_instructions_request
  on settlement_service.financial_instructions(settlement_request_id);

create index idx_financial_instructions_type_status
  on settlement_service.financial_instructions(instruction_type, instruction_status);

create index idx_financial_instructions_target_service
  on settlement_service.financial_instructions(target_service);

create index idx_financial_instruction_attempts_settlement
  on settlement_service.financial_instruction_attempts(settlement_id, attempt_number);

create or replace function settlement_service.prevent_financial_instruction_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'financial_instructions are append-only; create governed evidence instead';
end;
$$;

create trigger trg_prevent_financial_instruction_update
before update on settlement_service.financial_instructions
for each row execute function settlement_service.prevent_financial_instruction_mutation();

create trigger trg_prevent_financial_instruction_delete
before delete on settlement_service.financial_instructions
for each row execute function settlement_service.prevent_financial_instruction_mutation();

create or replace function settlement_service.prevent_financial_instruction_attempt_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'financial_instruction_attempts are append-only; append a new attempt instead';
end;
$$;

create trigger trg_prevent_financial_instruction_attempt_update
before update on settlement_service.financial_instruction_attempts
for each row execute function settlement_service.prevent_financial_instruction_attempt_mutation();

create trigger trg_prevent_financial_instruction_attempt_delete
before delete on settlement_service.financial_instruction_attempts
for each row execute function settlement_service.prevent_financial_instruction_attempt_mutation();

comment on table settlement_service.financial_instructions is
  'Append-only deterministic financial instructions derived from authoritative SettlementRecords. Posting is disabled; no external service response, ledger posting, credit wallet posting, commission, tax, cashier, or reconciliation state is recorded.';
