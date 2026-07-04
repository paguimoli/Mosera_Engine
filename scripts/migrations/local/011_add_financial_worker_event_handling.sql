create table if not exists public.financial_worker_event_handlers (
  event_id text primary key,
  event_type text not null,
  aggregate_type text,
  aggregate_id text,
  idempotency_key text not null unique,
  handling_status text not null,
  handler_name text not null,
  correlation_id text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  handled_at timestamptz,
  updated_at timestamptz not null default now(),
  check (event_id <> ''),
  check (event_type <> ''),
  check (idempotency_key <> ''),
  check (handler_name <> ''),
  check (handling_status in ('IN_PROGRESS', 'HANDLED', 'NO_OP', 'FAILED'))
);

create index if not exists financial_worker_event_handlers_event_type_idx
  on public.financial_worker_event_handlers (event_type);

create index if not exists financial_worker_event_handlers_status_idx
  on public.financial_worker_event_handlers (handling_status);

create index if not exists financial_worker_event_handlers_aggregate_idx
  on public.financial_worker_event_handlers (aggregate_type, aggregate_id);

drop trigger if exists set_financial_worker_event_handlers_updated_at
  on public.financial_worker_event_handlers;
create trigger set_financial_worker_event_handlers_updated_at
before update on public.financial_worker_event_handlers
for each row execute function public.set_updated_at();
