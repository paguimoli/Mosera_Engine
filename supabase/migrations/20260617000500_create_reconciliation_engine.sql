create table if not exists public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null,
  scope_type text not null,
  scope_id text null,
  week_start timestamptz null,
  week_end timestamptz null,
  currency text null,
  status text not null,
  total_checks integer not null default 0,
  passed_checks integer not null default 0,
  failed_checks integer not null default 0,
  warning_checks integer not null default 0,
  correlation_id text null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint reconciliation_runs_run_type_check check (
    run_type in ('CREDIT', 'SETTLEMENT', 'ACCOUNTING', 'COMMISSION', 'FULL')
  ),
  constraint reconciliation_runs_scope_type_check check (
    scope_type in ('GLOBAL', 'ACCOUNT', 'PLAYER', 'AGENT', 'MASTER', 'WEEK')
  ),
  constraint reconciliation_runs_status_check check (
    status in ('STARTED', 'COMPLETED', 'FAILED')
  ),
  constraint reconciliation_runs_currency_check check (
    currency is null or currency ~ '^[A-Z]{3}$'
  ),
  constraint reconciliation_runs_window_check check (
    week_start is null or week_end is null or week_end > week_start
  )
);

create index if not exists reconciliation_runs_run_type_idx
  on public.reconciliation_runs(run_type);

create index if not exists reconciliation_runs_scope_idx
  on public.reconciliation_runs(scope_type, scope_id);

create index if not exists reconciliation_runs_status_idx
  on public.reconciliation_runs(status);

create index if not exists reconciliation_runs_week_idx
  on public.reconciliation_runs(week_start, week_end);

create index if not exists reconciliation_runs_correlation_id_idx
  on public.reconciliation_runs(correlation_id);

create index if not exists reconciliation_runs_created_at_idx
  on public.reconciliation_runs(created_at);

alter table public.reconciliation_runs enable row level security;

create table if not exists public.reconciliation_run_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.reconciliation_runs(id) on delete cascade,
  severity text not null,
  check_code text not null,
  entity_type text not null,
  entity_id text not null,
  expected_amount bigint null,
  actual_amount bigint null,
  currency text null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint reconciliation_run_findings_severity_check check (
    severity in ('PASS', 'WARNING', 'FAIL')
  ),
  constraint reconciliation_run_findings_currency_check check (
    currency is null or currency ~ '^[A-Z]{3}$'
  )
);

create index if not exists reconciliation_run_findings_run_id_idx
  on public.reconciliation_run_findings(run_id);

create index if not exists reconciliation_run_findings_severity_idx
  on public.reconciliation_run_findings(severity);

create index if not exists reconciliation_run_findings_check_code_idx
  on public.reconciliation_run_findings(check_code);

create index if not exists reconciliation_run_findings_entity_idx
  on public.reconciliation_run_findings(entity_type, entity_id);

create index if not exists reconciliation_run_findings_created_at_idx
  on public.reconciliation_run_findings(created_at);

alter table public.reconciliation_run_findings enable row level security;
