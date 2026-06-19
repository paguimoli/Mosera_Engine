create table if not exists public.ledger_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  correlation_id text,
  transaction_id text not null,
  account_id text not null,
  wallet_id text null,
  entry_type text not null,
  comparison_status text not null,
  shadow_entry_type text not null,
  monolith_entry_type text null,
  shadow_amount_minor bigint not null,
  monolith_amount_minor bigint null,
  shadow_currency text not null,
  monolith_currency text null,
  shadow_account_id text not null,
  monolith_account_id text null,
  shadow_idempotency_key text null,
  monolith_idempotency_key text null,
  shadow_service_version text null,
  created_at timestamptz not null default now(),
  constraint ledger_shadow_runs_comparison_status_check
    check (comparison_status in ('MATCH', 'MISMATCH', 'NOT_COMPARED')),
  constraint ledger_shadow_runs_shadow_currency_check
    check (shadow_currency ~ '^[A-Z]{3}$'),
  constraint ledger_shadow_runs_monolith_currency_check
    check (monolith_currency is null or monolith_currency ~ '^[A-Z]{3}$')
);

create table if not exists public.ledger_shadow_mismatches (
  id uuid primary key default gen_random_uuid(),
  shadow_run_id uuid not null references public.ledger_shadow_runs(id) on delete cascade,
  mismatch_type text not null,
  field_name text not null,
  monolith_value text null,
  shadow_value text null,
  severity text not null,
  created_at timestamptz not null default now(),
  constraint ledger_shadow_mismatches_type_check
    check (mismatch_type in (
      'AMOUNT_MISMATCH',
      'CURRENCY_MISMATCH',
      'ENTRY_TYPE_MISMATCH',
      'ACCOUNT_MISMATCH',
      'IDEMPOTENCY_MISMATCH',
      'UNKNOWN_MISMATCH'
    )),
  constraint ledger_shadow_mismatches_severity_check
    check (severity in ('INFO', 'WARNING', 'CRITICAL'))
);

create table if not exists public.ledger_shadow_failures (
  id uuid primary key default gen_random_uuid(),
  correlation_id text null,
  transaction_id text null,
  failure_reason text not null,
  failure_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ledger_shadow_runs_correlation_id_idx
  on public.ledger_shadow_runs(correlation_id);

create index if not exists ledger_shadow_runs_transaction_id_idx
  on public.ledger_shadow_runs(transaction_id);

create index if not exists ledger_shadow_runs_created_at_idx
  on public.ledger_shadow_runs(created_at);

create index if not exists ledger_shadow_runs_comparison_status_idx
  on public.ledger_shadow_runs(comparison_status);

create index if not exists ledger_shadow_runs_account_id_idx
  on public.ledger_shadow_runs(account_id);

create index if not exists ledger_shadow_mismatches_shadow_run_id_idx
  on public.ledger_shadow_mismatches(shadow_run_id);

create index if not exists ledger_shadow_mismatches_created_at_idx
  on public.ledger_shadow_mismatches(created_at);

create index if not exists ledger_shadow_mismatches_field_name_idx
  on public.ledger_shadow_mismatches(field_name);

create index if not exists ledger_shadow_failures_correlation_id_idx
  on public.ledger_shadow_failures(correlation_id);

create index if not exists ledger_shadow_failures_transaction_id_idx
  on public.ledger_shadow_failures(transaction_id);

create index if not exists ledger_shadow_failures_created_at_idx
  on public.ledger_shadow_failures(created_at);

alter table public.ledger_shadow_runs enable row level security;
alter table public.ledger_shadow_mismatches enable row level security;
alter table public.ledger_shadow_failures enable row level security;
