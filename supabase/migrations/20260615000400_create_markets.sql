create table if not exists public.markets (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  currency_code text not null,
  language_code text not null,
  timezone text not null,
  brand_code text not null,
  status text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint markets_status_check check (status in ('ACTIVE', 'DISABLED'))
);

create index if not exists markets_code_idx
  on public.markets(code);

create index if not exists markets_status_idx
  on public.markets(status);

create index if not exists markets_is_default_idx
  on public.markets(is_default);

drop trigger if exists set_markets_updated_at on public.markets;
create trigger set_markets_updated_at
before update on public.markets
for each row execute function public.set_updated_at();

alter table public.markets enable row level security;
