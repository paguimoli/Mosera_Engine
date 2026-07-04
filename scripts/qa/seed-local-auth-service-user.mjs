import { pbkdf2Sync } from "node:crypto";
import { printJson, requireGuardrails, runPsql } from "../migrations/lib/local-migration-utils.mjs";

export const localAuthSeed = {
  loginId: "local-auth-admin@example.com",
  password: "LocalAuth-QA-2026!",
  allowedPermission: "auth.local.allowed",
  deniedPermission: "system.admin",
  serviceName: "local-settlement-service",
  serviceClientId: "local-settlement-service-client",
  serviceClientSecret: "LocalService-QA-2026!",
  serviceAllowedScope: "settlement.run",
  serviceDeniedScope: "ledger.write",
};

const guardrails = requireGuardrails({ requireConfirmation: true });
const salt = Buffer.from("lottery-local-auth-service-seed-v1", "utf8");
const hash = pbkdf2Sync(localAuthSeed.password, salt, 100_000, 32, "sha256");
const passwordHash = `pbkdf2-sha256$100000$${salt.toString("base64")}$${hash.toString("base64")}`;
const serviceSalt = Buffer.from("lottery-local-auth-service-client-seed-v1", "utf8");
const serviceHash = pbkdf2Sync(localAuthSeed.serviceClientSecret, serviceSalt, 100_000, 32, "sha256");
const serviceSecretHash = `pbkdf2-sha256$100000$${serviceSalt.toString("base64")}$${serviceHash.toString("base64")}`;

runPsql(
  ["-q"],
  {
    input: `
insert into auth_service.identities (id, login_id, identity_type, lifecycle_state, metadata, created_at, updated_at)
values (
  '11111111-1111-4111-8111-111111111111',
  '${localAuthSeed.loginId}',
  'ADMIN',
  'ACTIVE',
  '{"localSeed": true, "seedName": "P0-001.4"}'::jsonb,
  '2026-07-01T00:00:00Z',
  now()
)
on conflict (id) do update set
  login_id = excluded.login_id,
  identity_type = excluded.identity_type,
  lifecycle_state = excluded.lifecycle_state,
  metadata = excluded.metadata,
  updated_at = now();

insert into auth_service.identity_credentials (
  id,
  identity_id,
  credential_type,
  public_reference,
  metadata,
  password_hash,
  password_hash_algorithm,
  password_hash_version,
  enabled,
  created_at,
  disabled_at,
  expires_at
)
values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'PASSWORD',
  'local-auth-seed-password',
  '{"localSeed": true, "hashAlgorithm": "PBKDF2-SHA256", "hashVersion": "1"}'::jsonb,
  '${passwordHash}',
  'PBKDF2-SHA256',
  '1',
  true,
  '2026-07-01T00:00:00Z',
  null,
  null
)
on conflict (id) do update set
  metadata = excluded.metadata,
  password_hash = excluded.password_hash,
  password_hash_algorithm = excluded.password_hash_algorithm,
  password_hash_version = excluded.password_hash_version,
  enabled = true,
  disabled_at = null,
  expires_at = null;

insert into auth_service.roles (id, code, display_name, system_role, metadata)
values (
  '33333333-3333-4333-8333-333333333333',
  'LOCAL_AUTH_QA_ADMIN',
  'Local Auth QA Admin',
  false,
  '{"localSeed": true}'::jsonb
)
on conflict (code) do update set
  display_name = excluded.display_name,
  system_role = excluded.system_role,
  metadata = excluded.metadata,
  disabled_at = null;

insert into auth_service.identity_roles (id, identity_id, role_id, scope_type, scope_id, effective_from, effective_to)
values (
  '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333',
  'GLOBAL',
  'local',
  '2026-07-01T00:00:00Z',
  null
)
on conflict (id) do update set
  effective_to = null;

insert into auth_service.permissions (id, code, display_name, description)
values (
  '55555555-5555-4555-8555-555555555555',
  '${localAuthSeed.allowedPermission}',
  'Local Auth Allowed Permission',
  'Local-only seeded permission for Auth Service cutover QA.'
)
on conflict (code) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  disabled_at = null;

insert into auth_service.identity_claims (id, identity_id, claim_type, claim_value, issuer, issued_at, expires_at, revoked_at)
values (
  '66666666-6666-4666-8666-666666666666',
  '11111111-1111-4111-8111-111111111111',
  'permission',
  '${localAuthSeed.allowedPermission}',
  'local-auth-seed',
  '2026-07-01T00:00:00Z',
  null,
  null
)
on conflict (id) do update set
  claim_value = excluded.claim_value,
  issuer = excluded.issuer,
  expires_at = null,
  revoked_at = null;

insert into auth_service.memberships (id, identity_id, scope_type, scope_id, metadata, effective_from, effective_to)
values (
  '77777777-7777-4777-8777-777777777777',
  '11111111-1111-4111-8111-111111111111',
  'GLOBAL',
  'local',
  '{"localSeed": true}'::jsonb,
  '2026-07-01T00:00:00Z',
  null
)
on conflict (id) do update set
  effective_to = null;

insert into auth_service.identities (id, login_id, identity_type, lifecycle_state, metadata, created_at, updated_at)
values (
  '88888888-8888-4888-8888-888888888888',
  '${localAuthSeed.serviceName}',
  'SERVICE_ACCOUNT',
  'ACTIVE',
  '{"localSeed": true, "seedName": "P0-001.7"}'::jsonb,
  '2026-07-01T00:00:00Z',
  now()
)
on conflict (id) do update set
  login_id = excluded.login_id,
  identity_type = excluded.identity_type,
  lifecycle_state = excluded.lifecycle_state,
  metadata = excluded.metadata,
  updated_at = now();

insert into auth_service.oauth_clients (
  id,
  client_id,
  display_name,
  allowed_grant_types,
  redirect_uris,
  scopes,
  requires_pkce,
  mtls_bound,
  active
)
values (
  '99999999-9999-4999-8999-999999999999',
  '${localAuthSeed.serviceClientId}',
  'Local Settlement Service Client',
  '["client_credentials"]'::jsonb,
  '[]'::jsonb,
  '["${localAuthSeed.serviceAllowedScope}"]'::jsonb,
  false,
  false,
  true
)
on conflict (client_id) do update set
  display_name = excluded.display_name,
  allowed_grant_types = excluded.allowed_grant_types,
  scopes = excluded.scopes,
  active = true,
  disabled_at = null;

insert into auth_service.oauth_client_secrets (
  id,
  oauth_client_id,
  public_reference,
  secret_hash,
  hash_algorithm,
  created_at,
  expires_at,
  revoked_at
)
values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '99999999-9999-4999-8999-999999999999',
  'local-service-client-secret',
  '${serviceSecretHash}',
  'PBKDF2-SHA256',
  '2026-07-01T00:00:00Z',
  null,
  null
)
on conflict (id) do update set
  secret_hash = excluded.secret_hash,
  hash_algorithm = excluded.hash_algorithm,
  expires_at = null,
  revoked_at = null;

insert into auth_service.service_accounts (
  id,
  identity_id,
  oauth_client_id,
  service_name,
  mtls_optional,
  active
)
values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '88888888-8888-4888-8888-888888888888',
  '99999999-9999-4999-8999-999999999999',
  '${localAuthSeed.serviceName}',
  true,
  true
)
on conflict (service_name) do update set
  identity_id = excluded.identity_id,
  oauth_client_id = excluded.oauth_client_id,
  mtls_optional = excluded.mtls_optional,
  active = true;
`,
  }
);

printJson({
  status: "PASS",
  localOnly: true,
  guardrails,
  loginId: localAuthSeed.loginId,
  password: localAuthSeed.password,
  allowedPermission: localAuthSeed.allowedPermission,
  deniedPermission: localAuthSeed.deniedPermission,
  serviceName: localAuthSeed.serviceName,
  serviceClientSecret: localAuthSeed.serviceClientSecret,
  serviceAllowedScope: localAuthSeed.serviceAllowedScope,
  serviceDeniedScope: localAuthSeed.serviceDeniedScope,
});
