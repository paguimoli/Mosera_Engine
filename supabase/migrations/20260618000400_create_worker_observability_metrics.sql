create table if not exists public.worker_heartbeats (
  id uuid primary key default gen_random_uuid(),
  worker_name text not null,
  workload_category text not null,
  instance_id text not null,
  status text not null,
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint worker_heartbeats_status_check check (
    status in ('ACTIVE', 'IDLE', 'DEGRADED', 'STOPPED')
  ),
  constraint worker_heartbeats_workload_category_check check (
    workload_category in (
      'CRITICAL_FINANCIAL',
      'TICKET_LIFECYCLE',
      'SETTLEMENT',
      'ACCOUNTING',
      'COMMISSION',
      'RECONCILIATION',
      'OPERATIONAL_ACCESS',
      'REPORTING_LOW_PRIORITY'
    )
  ),
  constraint worker_heartbeats_worker_instance_unique unique (
    worker_name,
    instance_id
  )
);

create index if not exists worker_heartbeats_worker_name_idx
  on public.worker_heartbeats(worker_name);
create index if not exists worker_heartbeats_workload_category_idx
  on public.worker_heartbeats(workload_category);
create index if not exists worker_heartbeats_status_idx
  on public.worker_heartbeats(status);
create index if not exists worker_heartbeats_last_seen_at_idx
  on public.worker_heartbeats(last_seen_at);

drop trigger if exists set_worker_heartbeats_updated_at on public.worker_heartbeats;
create trigger set_worker_heartbeats_updated_at
  before update on public.worker_heartbeats
  for each row
  execute function public.set_updated_at();

alter table public.worker_heartbeats enable row level security;

create table if not exists public.worker_processing_metrics (
  id uuid primary key default gen_random_uuid(),
  worker_name text not null,
  workload_category text not null,
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
    processed_count >= 0
    and failed_count >= 0
    and retry_count >= 0
    and total_processing_ms >= 0
    and max_processing_ms >= 0
  ),
  constraint worker_processing_metrics_window_check check (window_end >= window_start),
  constraint worker_processing_metrics_workload_category_check check (
    workload_category in (
      'CRITICAL_FINANCIAL',
      'TICKET_LIFECYCLE',
      'SETTLEMENT',
      'ACCOUNTING',
      'COMMISSION',
      'RECONCILIATION',
      'OPERATIONAL_ACCESS',
      'REPORTING_LOW_PRIORITY'
    )
  )
);

create index if not exists worker_processing_metrics_worker_name_idx
  on public.worker_processing_metrics(worker_name);
create index if not exists worker_processing_metrics_workload_category_idx
  on public.worker_processing_metrics(workload_category);
create index if not exists worker_processing_metrics_event_type_idx
  on public.worker_processing_metrics(event_type);
create index if not exists worker_processing_metrics_window_start_idx
  on public.worker_processing_metrics(window_start);

alter table public.worker_processing_metrics enable row level security;

create table if not exists public.worker_failures (
  id uuid primary key default gen_random_uuid(),
  worker_name text not null,
  workload_category text not null,
  event_type text not null,
  entity_id text null,
  correlation_id text null,
  error_code text null,
  error_message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint worker_failures_workload_category_check check (
    workload_category in (
      'CRITICAL_FINANCIAL',
      'TICKET_LIFECYCLE',
      'SETTLEMENT',
      'ACCOUNTING',
      'COMMISSION',
      'RECONCILIATION',
      'OPERATIONAL_ACCESS',
      'REPORTING_LOW_PRIORITY'
    )
  )
);

create index if not exists worker_failures_worker_name_idx
  on public.worker_failures(worker_name);
create index if not exists worker_failures_workload_category_idx
  on public.worker_failures(workload_category);
create index if not exists worker_failures_event_type_idx
  on public.worker_failures(event_type);
create index if not exists worker_failures_correlation_id_idx
  on public.worker_failures(correlation_id);
create index if not exists worker_failures_created_at_idx
  on public.worker_failures(created_at);

alter table public.worker_failures enable row level security;
