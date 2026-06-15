create table if not exists public.auth_mfa_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.platform_users(id) on delete cascade,
  challenge_token_hash text not null unique,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists auth_mfa_challenges_user_id_idx
  on public.auth_mfa_challenges(user_id);

create index if not exists auth_mfa_challenges_expires_at_idx
  on public.auth_mfa_challenges(expires_at);

create index if not exists auth_mfa_challenges_consumed_at_idx
  on public.auth_mfa_challenges(consumed_at);

alter table public.auth_mfa_challenges enable row level security;
