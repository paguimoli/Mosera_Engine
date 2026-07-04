create table if not exists auth_service.oauth_clients (
  id uuid primary key,
  client_id text not null unique,
  display_name text not null,
  allowed_grant_types jsonb not null default '[]'::jsonb,
  redirect_uris jsonb not null default '[]'::jsonb,
  scopes jsonb not null default '[]'::jsonb,
  requires_pkce boolean not null default true,
  mtls_bound boolean not null default false,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table if not exists auth_service.oauth_client_secrets (
  id uuid primary key,
  oauth_client_id uuid not null references auth_service.oauth_clients(id),
  public_reference text not null,
  secret_hash text,
  secret_material_ref text,
  hash_algorithm text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

create table if not exists auth_service.service_accounts (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  oauth_client_id uuid references auth_service.oauth_clients(id),
  service_name text not null unique,
  mtls_optional boolean not null default true,
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_auth_oauth_client_secrets_client
  on auth_service.oauth_client_secrets(oauth_client_id);

create index if not exists idx_auth_service_accounts_identity
  on auth_service.service_accounts(identity_id);
