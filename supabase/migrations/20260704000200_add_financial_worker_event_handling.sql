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
  constraint financial_worker_event_handlers_event_id_check check (event_id <> ''),
  constraint financial_worker_event_handlers_event_type_check check (event_type <> ''),
  constraint financial_worker_event_handlers_idempotency_key_check check (idempotency_key <> ''),
  constraint financial_worker_event_handlers_handler_name_check check (handler_name <> ''),
  constraint financial_worker_event_handlers_status_check
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

alter table public.financial_worker_event_handlers enable row level security;
