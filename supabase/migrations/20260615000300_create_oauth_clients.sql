create table if not exists public.oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  client_name text not null,
  client_secret_hash text not null,
  status text not null,
  allowed_scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint oauth_clients_status_check check (status in ('ACTIVE', 'DISABLED'))
);

create table if not exists public.oauth_access_tokens (
  id uuid primary key default gen_random_uuid(),
  oauth_client_id uuid not null references public.oauth_clients(id) on delete cascade,
  access_token_hash text not null unique,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists oauth_clients_client_id_idx
  on public.oauth_clients(client_id);

create index if not exists oauth_clients_status_idx
  on public.oauth_clients(status);

create index if not exists oauth_access_tokens_oauth_client_id_idx
  on public.oauth_access_tokens(oauth_client_id);

create index if not exists oauth_access_tokens_expires_at_idx
  on public.oauth_access_tokens(expires_at);

create index if not exists oauth_access_tokens_revoked_at_idx
  on public.oauth_access_tokens(revoked_at);

drop trigger if exists set_oauth_clients_updated_at on public.oauth_clients;
create trigger set_oauth_clients_updated_at
before update on public.oauth_clients
for each row execute function public.set_updated_at();

alter table public.oauth_clients enable row level security;
alter table public.oauth_access_tokens enable row level security;
