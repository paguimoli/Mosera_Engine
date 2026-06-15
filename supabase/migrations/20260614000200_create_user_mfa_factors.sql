create table if not exists public.user_mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.platform_users(id) on delete cascade,
  factor_type text not null,
  secret_encrypted text not null,
  label text,
  is_enabled boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_mfa_factors_factor_type_check check (
    factor_type in ('TOTP')
  ),
  constraint user_mfa_factors_user_factor_type_unique unique (
    user_id,
    factor_type
  )
);

drop trigger if exists set_user_mfa_factors_updated_at
  on public.user_mfa_factors;
create trigger set_user_mfa_factors_updated_at
before update on public.user_mfa_factors
for each row execute function public.set_updated_at();

create index if not exists user_mfa_factors_user_id_idx
  on public.user_mfa_factors(user_id);
create index if not exists user_mfa_factors_factor_type_idx
  on public.user_mfa_factors(factor_type);
create index if not exists user_mfa_factors_is_enabled_idx
  on public.user_mfa_factors(is_enabled);

alter table public.user_mfa_factors enable row level security;
