-- Phase 23.2 Auth Service schema draft only. Do not apply automatically.
-- Auth Service owns identity and security relationship data only.
-- Business hierarchy, financial hierarchy, settlement, ledger, and credit data are excluded.

create schema if not exists auth_service;

create table if not exists auth_service.identities (
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

comment on table auth_service.identities is
  'Global identity store. login_id is immutable and unique; no business hierarchy is stored here.';
comment on column auth_service.identities.deleted_at is
  'Soft-delete marker only. Hard deletes are prohibited by policy.';

create table if not exists auth_service.identity_aliases (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  alias_type text not null,
  alias_value text not null,
  verified_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (alias_type, alias_value)
);

create table if not exists auth_service.identity_credentials (
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

comment on table auth_service.identity_credentials is
  'Credential metadata and secret material references are separated from identities. Secrets are not returned by normal query models.';
comment on column auth_service.identity_credentials.password_hash is
  'Password hash storage field only. Phase 23.2 does not implement hashing or verification.';

create table if not exists auth_service.identity_lifecycle_events (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  previous_state text,
  new_state text not null,
  reason text not null,
  actor_identity_id uuid,
  correlation_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table auth_service.identity_lifecycle_events is
  'Append-only lifecycle evidence. No updates or deletes are allowed by policy.';

create table if not exists auth_service.roles (
  id uuid primary key,
  code text not null unique,
  display_name text not null,
  system_role boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table if not exists auth_service.permissions (
  id uuid primary key,
  code text not null unique,
  display_name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table if not exists auth_service.identity_roles (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  role_id uuid not null references auth_service.roles(id),
  scope_type text not null,
  scope_id text not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  unique (identity_id, role_id, scope_type, scope_id, effective_from)
);

create table if not exists auth_service.identity_claims (
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

create table if not exists auth_service.policies (
  id uuid primary key,
  code text not null unique,
  display_name text not null,
  expression text not null,
  required_roles jsonb not null default '[]'::jsonb,
  required_claims jsonb not null default '[]'::jsonb,
  enforced_locally_by_services boolean not null default true,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table if not exists auth_service.memberships (
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

comment on table auth_service.memberships is
  'Memberships scope global identities to tenant, brand, market, operator, jurisdiction, or PAM contexts. Business hierarchy remains external.';

create table if not exists auth_service.sessions (
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

create table if not exists auth_service.tokens (
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

comment on table auth_service.tokens is
  'Token metadata for JWT and opaque reference tokens. Phase 23.2 does not issue tokens.';

create table if not exists auth_service.refresh_tokens (
  id uuid primary key,
  identity_id uuid references auth_service.identities(id),
  token_id uuid references auth_service.tokens(id),
  family_id uuid not null,
  rotation_counter integer not null default 0,
  previous_refresh_token_id uuid,
  opaque_reference_hash text not null unique,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  check (rotation_counter >= 0)
);

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

comment on table auth_service.oauth_client_secrets is
  'OAuth client secrets are isolated from client metadata and are never exposed through normal query models.';

create table if not exists auth_service.service_accounts (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  oauth_client_id uuid references auth_service.oauth_clients(id),
  service_name text not null,
  mtls_optional boolean not null default true,
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists auth_service.api_clients (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  oauth_client_id uuid references auth_service.oauth_clients(id),
  owner_scope text not null,
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists auth_service.security_relationships (
  id uuid primary key,
  relationship_type text not null,
  subject_identity_id uuid not null references auth_service.identities(id),
  resource_type text not null,
  resource_id text not null,
  policy_codes jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table if not exists auth_service.audit_events (
  id uuid primary key,
  category text not null,
  actor_identity_id uuid,
  subject_identity_id uuid,
  action text not null,
  correlation_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table auth_service.audit_events is
  'Append-only auth/security audit trail. No updates or deletes are allowed by policy.';

create table if not exists auth_service.signing_keys (
  id uuid primary key,
  key_id text not null unique,
  algorithm text not null,
  public_jwk jsonb not null,
  private_key_material_ref text,
  status text not null,
  version integer not null,
  created_at timestamptz not null default now(),
  activates_at timestamptz not null,
  expires_at timestamptz,
  retired_at timestamptz,
  check (version > 0),
  check (status in ('PLANNED', 'ACTIVE', 'ROTATING', 'RETIRED', 'REVOKED'))
);

comment on table auth_service.signing_keys is
  'Versioned signing key metadata and public JWKS material. Rotation is modeled only in Phase 23.2.';

create index if not exists idx_auth_identities_login_id on auth_service.identities(login_id);
create index if not exists idx_auth_credentials_identity on auth_service.identity_credentials(identity_id);
create index if not exists idx_auth_sessions_identity on auth_service.sessions(identity_id);
create index if not exists idx_auth_tokens_identity on auth_service.tokens(identity_id);
create index if not exists idx_auth_refresh_token_family on auth_service.refresh_tokens(family_id);
create index if not exists idx_auth_memberships_identity_scope on auth_service.memberships(identity_id, scope_type, scope_id);
create index if not exists idx_auth_audit_correlation on auth_service.audit_events(correlation_id);

-- Trigger enforcement is deferred. Future migrations should add immutable login_id guards,
-- append-only audit/lifecycle triggers, and hard-delete prevention after production DBA review.
