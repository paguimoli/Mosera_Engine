create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  display_name text not null,
  status text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brands_status_check check (status in ('ACTIVE', 'DISABLED'))
);

create index if not exists brands_code_idx
  on public.brands(code);

create index if not exists brands_status_idx
  on public.brands(status);

create index if not exists brands_is_default_idx
  on public.brands(is_default);

drop trigger if exists set_brands_updated_at on public.brands;
create trigger set_brands_updated_at
before update on public.brands
for each row execute function public.set_updated_at();

alter table public.brands enable row level security;
