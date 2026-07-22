create table if not exists ledger_service.ledger_recovery_events (
  event_id uuid primary key,
  posting_request_id uuid not null references ledger_service.ledger_posting_requests(id),
  ledger_transaction_id uuid references ledger_service.ledger_transactions(id),
  recovery_scope text not null check (recovery_scope in ('POSTING_REQUEST', 'JOURNAL_TRANSACTION', 'REVERSAL')),
  classification text not null check (classification in (
    'MATCHED_COMMIT', 'NOT_COMMITTED', 'INCONCLUSIVE',
    'JOURNAL_MATCH', 'JOURNAL_MISMATCH', 'RETRY_COMPLETED', 'COMPLETED_REUSED'
  )),
  evidence_hash text not null unique check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  failure_reason text,
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists idx_ledger_recovery_events_request
  on ledger_service.ledger_recovery_events(posting_request_id, created_at);
create index if not exists idx_ledger_recovery_events_transaction
  on ledger_service.ledger_recovery_events(ledger_transaction_id, created_at)
  where ledger_transaction_id is not null;
create index if not exists idx_ledger_recovery_events_classification
  on ledger_service.ledger_recovery_events(classification, created_at);

create table if not exists ledger_service.ledger_reconciliation_events (
  event_id uuid primary key,
  settlement_instruction_id uuid not null references settlement_service.financial_instructions(instruction_id),
  posting_request_id uuid references ledger_service.ledger_posting_requests(id),
  ledger_transaction_id uuid references ledger_service.ledger_transactions(id),
  credit_instruction_id uuid references settlement_service.financial_instructions(instruction_id),
  credit_reference text,
  reconciliation_result text not null check (reconciliation_result in (
    'RECONCILED', 'LEDGER_MISSING', 'CREDIT_MISSING', 'PAYLOAD_MISMATCH',
    'STATUS_MISMATCH', 'INCONCLUSIVE'
  )),
  evidence_hash text not null unique check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  failure_reason text,
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists idx_ledger_reconciliation_events_instruction
  on ledger_service.ledger_reconciliation_events(settlement_instruction_id, created_at);
create index if not exists idx_ledger_reconciliation_events_result
  on ledger_service.ledger_reconciliation_events(reconciliation_result, created_at);
create index if not exists idx_ledger_reconciliation_events_transaction
  on ledger_service.ledger_reconciliation_events(ledger_transaction_id, created_at)
  where ledger_transaction_id is not null;

create or replace function ledger_service.prevent_recovery_reconciliation_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Ledger recovery and reconciliation evidence is append-only.';
end;
$$;

drop trigger if exists ledger_recovery_events_update_guard on ledger_service.ledger_recovery_events;
create trigger ledger_recovery_events_update_guard
before update on ledger_service.ledger_recovery_events
for each row execute function ledger_service.prevent_recovery_reconciliation_mutation();

drop trigger if exists ledger_recovery_events_delete_guard on ledger_service.ledger_recovery_events;
create trigger ledger_recovery_events_delete_guard
before delete on ledger_service.ledger_recovery_events
for each row execute function ledger_service.prevent_recovery_reconciliation_mutation();

drop trigger if exists ledger_reconciliation_events_update_guard on ledger_service.ledger_reconciliation_events;
create trigger ledger_reconciliation_events_update_guard
before update on ledger_service.ledger_reconciliation_events
for each row execute function ledger_service.prevent_recovery_reconciliation_mutation();

drop trigger if exists ledger_reconciliation_events_delete_guard on ledger_service.ledger_reconciliation_events;
create trigger ledger_reconciliation_events_delete_guard
before delete on ledger_service.ledger_reconciliation_events
for each row execute function ledger_service.prevent_recovery_reconciliation_mutation();

comment on table ledger_service.ledger_recovery_events is
  'Append-only evidence for governed posting, journal, and reversal recovery. It never repairs immutable journals by mutation.';
comment on table ledger_service.ledger_reconciliation_events is
  'Append-only instruction-level Settlement/Ledger/Credit verification evidence. This is not broad accounting reconciliation.';
