alter table public.reconciliation_runs
  add column if not exists review_status text not null default 'PENDING',
  add column if not exists reviewed_by_user_id uuid null,
  add column if not exists reviewed_at timestamptz null,
  add column if not exists severity_summary jsonb not null default '{}'::jsonb;

alter table public.reconciliation_runs
  drop constraint if exists reconciliation_runs_review_status_check;

alter table public.reconciliation_runs
  add constraint reconciliation_runs_review_status_check check (
    review_status in ('PENDING', 'REVIEWED', 'REQUIRES_ATTENTION')
  );

create index if not exists reconciliation_runs_review_status_idx
  on public.reconciliation_runs(review_status);

create index if not exists reconciliation_runs_reviewed_at_idx
  on public.reconciliation_runs(reviewed_at);

alter table public.reconciliation_run_findings
  add column if not exists review_status text not null default 'OPEN',
  add column if not exists assigned_operator_user_id uuid null,
  add column if not exists reviewed_at timestamptz null,
  add column if not exists acknowledged_by_user_id uuid null,
  add column if not exists acknowledged_at timestamptz null,
  add column if not exists resolved_by_user_id uuid null,
  add column if not exists resolved_at timestamptz null,
  add column if not exists resolution_notes text null;

alter table public.reconciliation_run_findings
  drop constraint if exists reconciliation_run_findings_review_status_check;

alter table public.reconciliation_run_findings
  add constraint reconciliation_run_findings_review_status_check check (
    review_status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')
  );

create index if not exists reconciliation_run_findings_review_status_idx
  on public.reconciliation_run_findings(review_status);

create index if not exists reconciliation_run_findings_assigned_operator_idx
  on public.reconciliation_run_findings(assigned_operator_user_id);

create index if not exists reconciliation_run_findings_acknowledged_at_idx
  on public.reconciliation_run_findings(acknowledged_at);

create index if not exists reconciliation_run_findings_resolved_at_idx
  on public.reconciliation_run_findings(resolved_at);
