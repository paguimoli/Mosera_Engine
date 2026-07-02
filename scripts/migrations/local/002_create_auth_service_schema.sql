create schema if not exists auth_service;

create table auth_service.identities (
  id uuid primary key,
  login_id text not null unique,
  identity_type text not null,
  lifecycle_state text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (login_id <> ''),
  check (identity_type in ('ADMIN', 'PLAYER', 'AGENT', 'OPERATOR', 'API_CLIENT', 'SERVICE_ACCOUNT', 'PAM_USER')),
  check (lifecycle_state in ('CREATED', 'PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'LOCKED', 'DISABLED', 'DELETED'))
);

create table auth_service.identity_aliases (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  alias_type text not null,
  alias_value text not null,
  verified_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (alias_type, alias_value)
);

create table auth_service.identity_credentials (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  credential_type text not null,
  public_reference text not null,
  metadata jsonb not null default '{}'::jsonb,
  secret_material_ref text,
  password_hash text,
  password_hash_algorithm text,
  password_hash_version text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  expires_at timestamptz,
  check (credential_type in ('PASSWORD', 'TOTP', 'WEBAUTHN', 'OAUTH_FEDERATION', 'PAM_FEDERATION', 'API_KEY', 'CLIENT_SECRET', 'CERTIFICATE'))
);

create table auth_service.roles (
  id uuid primary key,
  code text not null unique,
  display_name text not null,
  system_role boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table auth_service.permissions (
  id uuid primary key,
  code text not null unique,
  display_name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table auth_service.identity_roles (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  role_id uuid not null references auth_service.roles(id),
  scope_type text not null,
  scope_id text not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  unique (identity_id, role_id, scope_type, scope_id, effective_from)
);

create table auth_service.identity_claims (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  claim_type text not null,
  claim_value text not null,
  issuer text not null,
  scope_type text,
  scope_id text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

create table auth_service.memberships (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  scope_type text not null,
  scope_id text not null,
  jurisdiction_code text,
  brand_id text,
  market_id text,
  operator_id text,
  metadata jsonb not null default '{}'::jsonb,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  check (scope_type in ('GLOBAL', 'TENANT', 'BRAND', 'MARKET', 'OPERATOR', 'JURISDICTION', 'PAM'))
);

create table auth_service.sessions (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  state text not null,
  policy_code text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  check (state in ('CREATED', 'ACTIVE', 'EXPIRED', 'REVOKED'))
);

create table auth_service.tokens (
  id uuid primary key,
  identity_id uuid references auth_service.identities(id),
  token_type text not null,
  token_format text not null,
  issuer text not null,
  audience text not null,
  scopes jsonb not null default '[]'::jsonb,
  jwt_id text,
  opaque_reference_hash text,
  signing_key_id uuid,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  check (token_type in ('ACCESS', 'ID', 'REFRESH', 'CLIENT_ASSERTION')),
  check (token_format in ('JWT', 'OPAQUE_REFERENCE'))
);

create table auth_service.audit_events (
  id uuid primary key,
  category text not null,
  actor_identity_id uuid,
  subject_identity_id uuid,
  action text not null,
  correlation_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_auth_identities_login_id on auth_service.identities(login_id);
create index idx_auth_credentials_identity on auth_service.identity_credentials(identity_id);
create index idx_auth_sessions_identity on auth_service.sessions(identity_id);
create index idx_auth_tokens_identity on auth_service.tokens(identity_id);
create index idx_auth_memberships_identity_scope on auth_service.memberships(identity_id, scope_type, scope_id);
create index idx_auth_audit_correlation on auth_service.audit_events(correlation_id);
