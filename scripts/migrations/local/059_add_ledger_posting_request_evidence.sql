create schema if not exists ledger_service;

create table if not exists ledger_service.ledger_posting_requests (
  id uuid primary key,
  request_kind text not null check (request_kind in ('POSTING', 'REVERSAL')),
  instruction_id text not null,
  instruction_type text not null,
  instruction_hash text not null check (instruction_hash like 'sha256:%'),
  originating_authority text not null,
  settlement_record_id uuid,
  ledger_wallet_id uuid not null references public.financial_wallets(id),
  ledger_account_id uuid references public.accounts(id),
  direction text not null check (direction in ('CREDIT', 'DEBIT')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  minor_unit_precision integer not null check (minor_unit_precision between 0 and 4),
  transaction_type text not null,
  idempotency_key text not null unique,
  canonical_request_hash text not null check (canonical_request_hash like 'sha256:%'),
  effective_at timestamptz not null,
  original_ledger_entry_id uuid references public.financial_ledger_entries(id),
  original_ledger_entry_hash text,
  correlation_metadata jsonb not null default '{}'::jsonb,
  request_status text not null check (request_status in ('CLAIMED', 'COMPLETED', 'FAILED', 'UNKNOWN')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  failure_code text,
  failure_reason text,
  ledger_entry_id uuid unique references public.financial_ledger_entries(id),
  ledger_entry_hash text,
  constraint ledger_posting_requests_reversal_reference check (
    (request_kind = 'POSTING' and original_ledger_entry_id is null and original_ledger_entry_hash is null)
    or
    (request_kind = 'REVERSAL' and original_ledger_entry_id is not null and original_ledger_entry_hash like 'sha256:%')
  ),
  constraint ledger_posting_requests_completion_evidence check (
    (request_status = 'COMPLETED' and completed_at is not null and ledger_entry_id is not null and ledger_entry_hash like 'sha256:%')
    or request_status <> 'COMPLETED'
  )
);

create index if not exists ledger_posting_requests_instruction_idx
  on ledger_service.ledger_posting_requests (instruction_id, instruction_type);
create index if not exists ledger_posting_requests_entry_idx
  on ledger_service.ledger_posting_requests (ledger_entry_id);
create index if not exists ledger_posting_requests_status_idx
  on ledger_service.ledger_posting_requests (request_status, created_at);
create index if not exists ledger_posting_requests_canonical_hash_idx
  on ledger_service.ledger_posting_requests (canonical_request_hash);

create table if not exists ledger_service.ledger_posting_attempts (
  id uuid primary key,
  posting_request_id uuid not null references ledger_service.ledger_posting_requests(id),
  attempt_number integer not null check (attempt_number > 0),
  started_at timestamptz not null,
  completed_at timestamptz not null check (completed_at >= started_at),
  result text not null check (result in ('SUCCEEDED', 'FAILED', 'REUSED', 'CONFLICT', 'UNKNOWN')),
  failure_classification text,
  target_response_reference text,
  response_hash text,
  runtime_provenance text not null,
  build_provenance text not null,
  canonical_evidence_hash text not null unique check (canonical_evidence_hash like 'sha256:%'),
  created_at timestamptz not null default now(),
  unique (posting_request_id, attempt_number)
);

create index if not exists ledger_posting_attempts_request_result_idx
  on ledger_service.ledger_posting_attempts (posting_request_id, result, attempt_number);

create table if not exists ledger_service.ledger_replay_evidence (
  id uuid primary key,
  posting_request_id uuid not null references ledger_service.ledger_posting_requests(id),
  ledger_entry_id uuid not null references public.financial_ledger_entries(id),
  replay_result text not null check (replay_result in ('MATCH', 'MISMATCH', 'INCONCLUSIVE')),
  mismatches jsonb not null default '[]'::jsonb,
  request_hash text not null,
  entry_hash text not null,
  canonical_evidence_hash text not null unique check (canonical_evidence_hash like 'sha256:%'),
  verified_at timestamptz not null default now()
);

create index if not exists ledger_replay_evidence_request_idx
  on ledger_service.ledger_replay_evidence (posting_request_id, verified_at);
create index if not exists ledger_replay_evidence_entry_idx
  on ledger_service.ledger_replay_evidence (ledger_entry_id, verified_at);

create or replace function ledger_service.validate_ledger_posting_request_update()
returns trigger
language plpgsql
as $$
begin
  if current_setting('ledger_service.allow_request_status_update', true) <> 'true' then
    raise exception 'Ledger posting requests may only change through governed status persistence.';
  end if;

  if row(
    new.id, new.request_kind, new.instruction_id, new.instruction_type,
    new.instruction_hash, new.originating_authority, new.settlement_record_id,
    new.ledger_wallet_id, new.ledger_account_id, new.direction, new.amount_minor,
    new.currency, new.minor_unit_precision, new.transaction_type,
    new.idempotency_key, new.canonical_request_hash, new.effective_at,
    new.original_ledger_entry_id, new.original_ledger_entry_hash,
    new.correlation_metadata, new.created_at
  ) is distinct from row(
    old.id, old.request_kind, old.instruction_id, old.instruction_type,
    old.instruction_hash, old.originating_authority, old.settlement_record_id,
    old.ledger_wallet_id, old.ledger_account_id, old.direction, old.amount_minor,
    old.currency, old.minor_unit_precision, old.transaction_type,
    old.idempotency_key, old.canonical_request_hash, old.effective_at,
    old.original_ledger_entry_id, old.original_ledger_entry_hash,
    old.correlation_metadata, old.created_at
  ) then
    raise exception 'Ledger posting request financial evidence is immutable.';
  end if;

  if old.request_status = 'COMPLETED' and new.request_status <> 'COMPLETED' then
    raise exception 'Completed Ledger posting requests are terminal.';
  end if;

  return new;
end;
$$;

create or replace function ledger_service.prevent_ledger_evidence_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Ledger posting evidence is append-only and cannot be deleted.';
end;
$$;

create or replace function ledger_service.prevent_ledger_evidence_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Ledger posting evidence is append-only and cannot be updated.';
end;
$$;

drop trigger if exists ledger_posting_requests_update_guard on ledger_service.ledger_posting_requests;
create trigger ledger_posting_requests_update_guard
before update on ledger_service.ledger_posting_requests
for each row execute function ledger_service.validate_ledger_posting_request_update();

drop trigger if exists ledger_posting_requests_delete_guard on ledger_service.ledger_posting_requests;
create trigger ledger_posting_requests_delete_guard
before delete on ledger_service.ledger_posting_requests
for each row execute function ledger_service.prevent_ledger_evidence_delete();

drop trigger if exists ledger_posting_attempts_update_guard on ledger_service.ledger_posting_attempts;
create trigger ledger_posting_attempts_update_guard
before update on ledger_service.ledger_posting_attempts
for each row execute function ledger_service.prevent_ledger_evidence_update();

drop trigger if exists ledger_posting_attempts_delete_guard on ledger_service.ledger_posting_attempts;
create trigger ledger_posting_attempts_delete_guard
before delete on ledger_service.ledger_posting_attempts
for each row execute function ledger_service.prevent_ledger_evidence_delete();

drop trigger if exists ledger_replay_evidence_update_guard on ledger_service.ledger_replay_evidence;
create trigger ledger_replay_evidence_update_guard
before update on ledger_service.ledger_replay_evidence
for each row execute function ledger_service.prevent_ledger_evidence_update();

drop trigger if exists ledger_replay_evidence_delete_guard on ledger_service.ledger_replay_evidence;
create trigger ledger_replay_evidence_delete_guard
before delete on ledger_service.ledger_replay_evidence
for each row execute function ledger_service.prevent_ledger_evidence_delete();
