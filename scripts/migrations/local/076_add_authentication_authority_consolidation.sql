create or replace function auth_service.prevent_canonical_auth_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'canonical authentication evidence is append-only';
end;
$$;

create or replace function auth_service.prevent_auth_physical_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'authentication records cannot be physically deleted';
end;
$$;

create or replace function auth_service.validate_identity_profile()
returns trigger
language plpgsql
as $$
declare
  linked_tenant uuid;
  emergency_count integer;
begin
  if new.normalized_username <> lower(btrim(new.normalized_username)) or new.normalized_username = '' then
    raise exception 'normalized username is required and must be lowercase';
  end if;
  if new.normalized_email is not null and new.normalized_email <> lower(btrim(new.normalized_email)) then
    raise exception 'normalized email must be lowercase';
  end if;
  if not exists (select 1 from platform.tenants where id = new.tenant_id) then
    raise exception 'identity tenant does not exist';
  end if;
  if new.brand_id is not null then
    select tenant_id into linked_tenant from platform.brands where id = new.brand_id;
    if linked_tenant is null or linked_tenant <> new.tenant_id then
      raise exception 'identity brand must belong to identity tenant';
    end if;
  end if;
  if new.account_status = 'EMERGENCY' then
    select count(*) into emergency_count
    from auth_service.identity_profiles
    where tenant_id = new.tenant_id
      and account_status = 'EMERGENCY'
      and identity_id <> new.identity_id;
    if emergency_count >= 2 then
      raise exception 'at most two governed emergency accounts are allowed per tenant';
    end if;
  end if;
  return new;
end;
$$;

create table auth_service.identity_profiles (
  identity_id uuid primary key references auth_service.identities(id),
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid references platform.brands(id),
  username text not null,
  normalized_username text not null,
  email text,
  normalized_email text,
  account_type text not null,
  account_status text not null,
  credential_status text not null,
  mfa_status text not null,
  created_at timestamptz not null,
  disabled_at timestamptz,
  review_due_at timestamptz not null,
  constraint ck_auth_identity_profile_status check (account_status in ('ACTIVE', 'DISABLED', 'LOCKED', 'COMPROMISED', 'EMERGENCY', 'DELETED')),
  constraint ck_auth_identity_profile_credential_status check (credential_status in ('ACTIVE', 'RESET_REQUIRED', 'COMPROMISED', 'DISABLED')),
  constraint ck_auth_identity_profile_mfa_status check (mfa_status in ('NOT_ENROLLED', 'ENROLLED', 'REQUIRED', 'DISABLED')),
  constraint ck_auth_identity_profile_deleted_logical check (account_status <> 'DELETED' or disabled_at is not null),
  constraint ux_auth_identity_profile_username unique (tenant_id, normalized_username),
  constraint ux_auth_identity_profile_email unique (tenant_id, normalized_email)
);

create table auth_service.external_identity_bindings (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  tenant_id uuid not null references platform.tenants(id),
  provider text not null,
  external_subject text not null,
  created_at timestamptz not null default now(),
  constraint ux_auth_external_identity_subject unique (tenant_id, provider, external_subject)
);

create table auth_service.password_credential_versions (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  version integer not null,
  password_hash text not null,
  algorithm text not null,
  memory_cost_kib integer not null,
  iterations integer not null,
  parallelism integer not null,
  compromised boolean not null default false,
  created_at timestamptz not null,
  rotated_at timestamptz,
  retired_at timestamptz,
  constraint ck_auth_password_algorithm check (algorithm = 'ARGON2ID'),
  constraint ck_auth_password_hash_format check (password_hash like '$argon2id$v=19$%'),
  constraint ck_auth_password_memory check (memory_cost_kib >= 32768),
  constraint ck_auth_password_iterations check (iterations >= 2),
  constraint ck_auth_password_parallelism check (parallelism >= 1),
  constraint ux_auth_password_credential_version unique (identity_id, version)
);

create table auth_service.canonical_sessions (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  session_token_hash text not null unique,
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  ip_address text,
  user_agent text,
  device_metadata text,
  constraint ck_auth_session_hash check (session_token_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_auth_session_expiry check (idle_expires_at <= absolute_expires_at and created_at < absolute_expires_at),
  constraint ck_auth_session_revocation check (revoked_at is null or revoked_reason is not null)
);

create table auth_service.password_reset_requests (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  constraint ck_auth_reset_token_hash check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_auth_reset_expiry check (expires_at > created_at)
);

create table auth_service.password_reset_consumptions (
  id uuid primary key,
  reset_request_id uuid not null unique references auth_service.password_reset_requests(id),
  identity_id uuid not null references auth_service.identities(id),
  consumed_at timestamptz not null
);

create unique index ux_auth_single_active_session
  on auth_service.canonical_sessions(identity_id)
  where revoked_at is null;

create table auth_service.identity_lifecycle_events (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid references platform.brands(id),
  identity_id uuid not null references auth_service.identities(id),
  previous_status text not null,
  target_status text not null,
  reason text not null,
  actor_identity_id uuid references auth_service.identities(id),
  correlation_id text not null,
  occurred_at timestamptz not null,
  constraint ck_auth_lifecycle_previous check (previous_status in ('ACTIVE', 'DISABLED', 'LOCKED', 'COMPROMISED', 'EMERGENCY', 'DELETED')),
  constraint ck_auth_lifecycle_target check (target_status in ('ACTIVE', 'DISABLED', 'LOCKED', 'COMPROMISED', 'EMERGENCY', 'DELETED'))
);

create table auth_service.authentication_audit_evidence (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid references platform.brands(id),
  actor_identity_id uuid references auth_service.identities(id),
  subject_identity_id uuid references auth_service.identities(id),
  action text not null,
  result text not null,
  reason text not null,
  correlation_id text not null,
  occurred_at timestamptz not null,
  ip_address text,
  user_agent text,
  authority text not null,
  constraint ck_auth_audit_authority check (authority = 'AUTH_SERVICE')
);

create table auth_service.authentication_login_attempts (
  id uuid primary key,
  identifier_hash text not null,
  result text not null,
  reason text not null,
  correlation_id text not null,
  occurred_at timestamptz not null,
  ip_address text,
  user_agent text,
  authority text not null,
  constraint ck_auth_login_attempt_identifier_hash check (identifier_hash ~ '^[0-9a-f]{64}$'),
  constraint ck_auth_login_attempt_result check (result = 'FAILURE'),
  constraint ck_auth_login_attempt_authority check (authority = 'AUTH_SERVICE')
);

create index idx_auth_identity_profiles_brand on auth_service.identity_profiles(tenant_id, brand_id);
create index idx_auth_password_history_identity on auth_service.password_credential_versions(identity_id, version desc);
create index idx_auth_canonical_sessions_identity on auth_service.canonical_sessions(identity_id, created_at desc);
create index idx_auth_password_reset_identity on auth_service.password_reset_requests(identity_id, created_at desc);
create index idx_auth_lifecycle_events_identity on auth_service.identity_lifecycle_events(identity_id, occurred_at desc);
create index idx_auth_audit_subject_time on auth_service.authentication_audit_evidence(subject_identity_id, occurred_at desc);
create index idx_auth_audit_correlation_v2 on auth_service.authentication_audit_evidence(correlation_id);
create index idx_auth_login_attempt_correlation on auth_service.authentication_login_attempts(correlation_id, occurred_at desc);

create trigger auth_identity_profile_validation
before insert or update on auth_service.identity_profiles
for each row execute function auth_service.validate_identity_profile();

create trigger auth_identity_profiles_delete_guard
before delete on auth_service.identity_profiles
for each row execute function auth_service.prevent_auth_physical_delete();

create trigger auth_external_bindings_update_guard
before update or delete on auth_service.external_identity_bindings
for each row execute function auth_service.prevent_canonical_auth_evidence_mutation();

create trigger auth_password_versions_update_guard
before update or delete on auth_service.password_credential_versions
for each row execute function auth_service.prevent_canonical_auth_evidence_mutation();

create trigger auth_lifecycle_events_update_guard
before update or delete on auth_service.identity_lifecycle_events
for each row execute function auth_service.prevent_canonical_auth_evidence_mutation();

create trigger auth_audit_evidence_update_guard
before update or delete on auth_service.authentication_audit_evidence
for each row execute function auth_service.prevent_canonical_auth_evidence_mutation();

create trigger auth_login_attempts_update_guard
before update or delete on auth_service.authentication_login_attempts
for each row execute function auth_service.prevent_canonical_auth_evidence_mutation();

create trigger auth_canonical_sessions_delete_guard
before delete on auth_service.canonical_sessions
for each row execute function auth_service.prevent_auth_physical_delete();

create trigger auth_password_reset_requests_update_guard
before update or delete on auth_service.password_reset_requests
for each row execute function auth_service.prevent_canonical_auth_evidence_mutation();

create trigger auth_password_reset_consumptions_update_guard
before update or delete on auth_service.password_reset_consumptions
for each row execute function auth_service.prevent_canonical_auth_evidence_mutation();

create trigger auth_identities_delete_guard
before delete on auth_service.identities
for each row execute function auth_service.prevent_auth_physical_delete();
