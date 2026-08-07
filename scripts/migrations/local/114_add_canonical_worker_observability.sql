create table if not exists public.worker_heartbeats (
  id uuid primary key default gen_random_uuid(),
  worker_name text not null,
  workload_category text not null check (workload_category in (
    'CRITICAL_FINANCIAL',
    'TICKET_LIFECYCLE',
    'SETTLEMENT',
    'ACCOUNTING',
    'COMMISSION',
    'RECONCILIATION',
    'OPERATIONAL_ACCESS',
    'REPORTING_LOW_PRIORITY'
  )),
  instance_id text not null,
  status text not null check (status in ('ACTIVE', 'IDLE', 'DEGRADED', 'STOPPED')),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ux_worker_heartbeats_worker_instance unique (worker_name, instance_id)
);

create index if not exists idx_worker_heartbeats_workload_status
  on public.worker_heartbeats(workload_category, status, last_seen_at desc);
create index if not exists idx_worker_heartbeats_last_seen
  on public.worker_heartbeats(last_seen_at desc);

drop trigger if exists set_worker_heartbeats_updated_at on public.worker_heartbeats;
create trigger set_worker_heartbeats_updated_at
before update on public.worker_heartbeats
for each row execute function public.set_updated_at();

create table if not exists public.worker_processing_metrics (
  id uuid primary key,
  worker_name text not null,
  workload_category text not null check (workload_category in (
    'CRITICAL_FINANCIAL',
    'TICKET_LIFECYCLE',
    'SETTLEMENT',
    'ACCOUNTING',
    'COMMISSION',
    'RECONCILIATION',
    'OPERATIONAL_ACCESS',
    'REPORTING_LOW_PRIORITY'
  )),
  event_type text not null,
  processed_count integer not null default 0,
  failed_count integer not null default 0,
  retry_count integer not null default 0,
  total_processing_ms integer not null default 0,
  max_processing_ms integer not null default 0,
  window_start timestamptz not null,
  window_end timestamptz not null,
  created_at timestamptz not null default now(),
  constraint worker_processing_metrics_counts_check check (
    processed_count >= 0 and failed_count >= 0 and retry_count >= 0
    and total_processing_ms >= 0 and max_processing_ms >= 0
  ),
  constraint worker_processing_metrics_window_check check (window_end >= window_start)
);

create index if not exists idx_worker_processing_metrics_worker
  on public.worker_processing_metrics(worker_name, created_at desc);
create index if not exists idx_worker_processing_metrics_category
  on public.worker_processing_metrics(workload_category, created_at desc);
create index if not exists idx_worker_processing_metrics_event
  on public.worker_processing_metrics(event_type, created_at desc);

create table if not exists public.worker_failures (
  id uuid primary key,
  worker_name text not null,
  workload_category text not null check (workload_category in (
    'CRITICAL_FINANCIAL',
    'TICKET_LIFECYCLE',
    'SETTLEMENT',
    'ACCOUNTING',
    'COMMISSION',
    'RECONCILIATION',
    'OPERATIONAL_ACCESS',
    'REPORTING_LOW_PRIORITY'
  )),
  event_type text not null,
  entity_id text,
  correlation_id text,
  error_code text,
  error_message text not null check (btrim(error_message) <> ''),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_worker_failures_worker
  on public.worker_failures(worker_name, created_at desc);
create index if not exists idx_worker_failures_category
  on public.worker_failures(workload_category, created_at desc);
create index if not exists idx_worker_failures_correlation
  on public.worker_failures(correlation_id, created_at desc);

comment on table public.worker_heartbeats is
  'Canonical mutable liveness projection for compiled worker instances.';
comment on table public.worker_processing_metrics is
  'Canonical append-only worker processing metric evidence.';
comment on table public.worker_failures is
  'Canonical append-only structured worker failure evidence.';
