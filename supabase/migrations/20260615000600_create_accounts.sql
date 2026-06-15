create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  account_type text not null,
  account_code text not null unique,
  display_name text not null,
  parent_account_id uuid references public.accounts(id),
  market_id uuid not null references public.markets(id),
  brand_id uuid not null references public.brands(id),
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_account_type_check check (
    account_type in (
      'SUPER_MASTER',
      'MASTER_AGENT',
      'AGENT',
      'PLAYER'
    )
  ),
  constraint accounts_status_check check (
    status in (
      'ACTIVE',
      'DISABLED'
    )
  )
);

create index if not exists accounts_account_code_idx
  on public.accounts (account_code);

create index if not exists accounts_account_type_idx
  on public.accounts (account_type);

create index if not exists accounts_parent_account_id_idx
  on public.accounts (parent_account_id);

create index if not exists accounts_market_id_idx
  on public.accounts (market_id);

create index if not exists accounts_brand_id_idx
  on public.accounts (brand_id);

create index if not exists accounts_status_idx
  on public.accounts (status);

drop trigger if exists set_accounts_updated_at on public.accounts;

create trigger set_accounts_updated_at
  before update on public.accounts
  for each row
  execute function public.set_updated_at();

alter table public.accounts enable row level security;
