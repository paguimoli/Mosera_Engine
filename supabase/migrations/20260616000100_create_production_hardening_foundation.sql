create table if not exists public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz null,
  published_at timestamptz null,
  last_error text null,
  correlation_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outbox_events_status_check
    check (status in ('PENDING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER'))
);

create index if not exists outbox_events_event_type_idx
  on public.outbox_events(event_type);
create index if not exists outbox_events_aggregate_idx
  on public.outbox_events(aggregate_type, aggregate_id);
create index if not exists outbox_events_status_idx
  on public.outbox_events(status);
create index if not exists outbox_events_next_attempt_at_idx
  on public.outbox_events(next_attempt_at);
create index if not exists outbox_events_correlation_id_idx
  on public.outbox_events(correlation_id);
create index if not exists outbox_events_created_at_idx
  on public.outbox_events(created_at);

create trigger set_outbox_events_updated_at
before update on public.outbox_events
for each row execute function public.set_updated_at();

alter table public.outbox_events enable row level security;

create table if not exists public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  scope text not null,
  request_hash text null,
  response_payload jsonb null,
  status text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null,
  expires_at timestamptz null,
  constraint idempotency_keys_status_check
    check (status in ('IN_PROGRESS', 'COMPLETED', 'FAILED'))
);

create index if not exists idempotency_keys_scope_idx
  on public.idempotency_keys(scope);
create index if not exists idempotency_keys_status_idx
  on public.idempotency_keys(status);
create index if not exists idempotency_keys_expires_at_idx
  on public.idempotency_keys(expires_at);
create index if not exists idempotency_keys_created_at_idx
  on public.idempotency_keys(created_at);

alter table public.idempotency_keys enable row level security;

create table if not exists public.job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  attempt_count integer not null default 1,
  correlation_id text null,
  metadata jsonb not null default '{}'::jsonb,
  error_message text null,
  constraint job_runs_status_check
    check (status in ('STARTED', 'SUCCEEDED', 'FAILED'))
);

create index if not exists job_runs_job_name_idx
  on public.job_runs(job_name);
create index if not exists job_runs_status_idx
  on public.job_runs(status);
create index if not exists job_runs_started_at_idx
  on public.job_runs(started_at);
create index if not exists job_runs_correlation_id_idx
  on public.job_runs(correlation_id);

alter table public.job_runs enable row level security;
