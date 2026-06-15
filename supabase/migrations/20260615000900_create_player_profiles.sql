create table if not exists public.player_profiles (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null unique references public.accounts(id) on delete cascade,
  first_name text null,
  last_name text null,
  display_name text not null,
  email text null,
  phone text null,
  date_of_birth date null,
  external_player_id text null,
  external_platform text null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint player_profiles_status_check check (
    status in ('ACTIVE', 'SUSPENDED', 'DISABLED')
  )
);

create index if not exists player_profiles_account_id_idx
  on public.player_profiles (account_id);

create index if not exists player_profiles_email_idx
  on public.player_profiles (email);

create index if not exists player_profiles_phone_idx
  on public.player_profiles (phone);

create index if not exists player_profiles_external_player_id_idx
  on public.player_profiles (external_player_id);

create index if not exists player_profiles_external_platform_idx
  on public.player_profiles (external_platform);

create index if not exists player_profiles_status_idx
  on public.player_profiles (status);

drop trigger if exists set_player_profiles_updated_at on public.player_profiles;

create trigger set_player_profiles_updated_at
  before update on public.player_profiles
  for each row
  execute function public.set_updated_at();

alter table public.player_profiles enable row level security;
