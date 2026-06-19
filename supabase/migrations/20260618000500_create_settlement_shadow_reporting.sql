create table if not exists public.settlement_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  correlation_id text,
  settlement_run_id text null,
  ticket_id text not null,
  game_id text null,
  drawing_id text null,
  comparison_status text not null,
  shadow_outcome text not null,
  monolith_outcome text null,
  shadow_gross_payout bigint not null,
  monolith_gross_payout bigint null,
  shadow_net_amount bigint not null,
  monolith_net_amount bigint null,
  currency text not null,
  shadow_service_version text null,
  created_at timestamptz not null default now(),
  constraint settlement_shadow_runs_comparison_status_check
    check (comparison_status in ('MATCH', 'MISMATCH', 'NOT_COMPARED')),
  constraint settlement_shadow_runs_shadow_outcome_check
    check (shadow_outcome in ('WIN', 'LOSS', 'PUSH', 'VOID')),
  constraint settlement_shadow_runs_monolith_outcome_check
    check (monolith_outcome is null or monolith_outcome in ('WIN', 'LOSS', 'PUSH', 'VOID')),
  constraint settlement_shadow_runs_currency_check
    check (currency ~ '^[A-Z]{3}$')
);

create table if not exists public.settlement_shadow_mismatches (
  id uuid primary key default gen_random_uuid(),
  shadow_run_id uuid not null references public.settlement_shadow_runs(id) on delete cascade,
  mismatch_type text not null,
  field_name text not null,
  monolith_value text null,
  shadow_value text null,
  severity text not null,
  created_at timestamptz not null default now(),
  constraint settlement_shadow_mismatches_type_check
    check (mismatch_type in (
      'OUTCOME_MISMATCH',
      'PAYOUT_MISMATCH',
      'NET_AMOUNT_MISMATCH',
      'STAKE_MISMATCH',
      'CURRENCY_MISMATCH',
      'UNKNOWN_MISMATCH'
    )),
  constraint settlement_shadow_mismatches_severity_check
    check (severity in ('INFO', 'WARNING', 'CRITICAL'))
);

create table if not exists public.settlement_shadow_failures (
  id uuid primary key default gen_random_uuid(),
  correlation_id text null,
  ticket_id text null,
  failure_reason text not null,
  failure_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists settlement_shadow_runs_ticket_id_idx
  on public.settlement_shadow_runs(ticket_id);

create index if not exists settlement_shadow_runs_correlation_id_idx
  on public.settlement_shadow_runs(correlation_id);

create index if not exists settlement_shadow_runs_created_at_idx
  on public.settlement_shadow_runs(created_at);

create index if not exists settlement_shadow_runs_comparison_status_idx
  on public.settlement_shadow_runs(comparison_status);

create index if not exists settlement_shadow_runs_game_id_idx
  on public.settlement_shadow_runs(game_id);

create index if not exists settlement_shadow_mismatches_shadow_run_id_idx
  on public.settlement_shadow_mismatches(shadow_run_id);

create index if not exists settlement_shadow_mismatches_created_at_idx
  on public.settlement_shadow_mismatches(created_at);

create index if not exists settlement_shadow_mismatches_field_name_idx
  on public.settlement_shadow_mismatches(field_name);

create index if not exists settlement_shadow_failures_ticket_id_idx
  on public.settlement_shadow_failures(ticket_id);

create index if not exists settlement_shadow_failures_correlation_id_idx
  on public.settlement_shadow_failures(correlation_id);

create index if not exists settlement_shadow_failures_created_at_idx
  on public.settlement_shadow_failures(created_at);

alter table public.settlement_shadow_runs enable row level security;
alter table public.settlement_shadow_mismatches enable row level security;
alter table public.settlement_shadow_failures enable row level security;
