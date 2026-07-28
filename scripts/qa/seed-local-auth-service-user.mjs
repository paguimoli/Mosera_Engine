import { pbkdf2Sync } from "node:crypto";
import {
  printJson,
  queryScalar,
  requireGuardrails,
  runPsql,
} from "../migrations/lib/local-migration-utils.mjs";

export const localAuthSeed = {
  identityId: "11111111-1111-4111-8111-111111111111",
  organizationId: "10101010-1010-4010-8010-101010101010",
  tenantId: "12121212-1212-4212-8212-121212121212",
  brandId: "13131313-1313-4313-8313-131313131313",
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

const authServiceUrl = (process.env.AUTH_SERVICE_URL || "http://localhost:5600").replace(/\/$/, "");
const guardrails = requireGuardrails({ requireConfirmation: true });
const serviceSalt = Buffer.from("lottery-local-auth-service-client-seed-v1", "utf8");
const serviceHash = pbkdf2Sync(localAuthSeed.serviceClientSecret, serviceSalt, 100_000, 32, "sha256");
const serviceSecretHash = `pbkdf2-sha256$100000$${serviceSalt.toString("base64")}$${serviceHash.toString("base64")}`;

function seedPlatformHierarchy() {
  runPsql(["-q"], {
    input: `
insert into platform.organizations (
  id, organization_code, name, status, version, content_hash, audit_metadata
) values (
  '${localAuthSeed.organizationId}', 'local-auth-qa', 'Local Auth QA', 'Active', '1.0.0',
  'sha256:local-auth-qa-organization-v1', '{"localSeed": true}'::jsonb
) on conflict (id) do nothing;

insert into platform.tenants (
  id, organization_id, tenant_code, name, status, default_language, default_currency,
  default_timezone, credit_enabled, cashier_enabled, version, content_hash, audit_metadata
) values (
  '${localAuthSeed.tenantId}', '${localAuthSeed.organizationId}', 'local-auth-qa',
  'Local Auth QA Tenant', 'Active', 'en', 'USD', 'UTC', true, false, '1.0.0',
  'sha256:local-auth-qa-tenant-v1', '{"localSeed": true}'::jsonb
) on conflict (id) do nothing;

insert into platform.brands (
  id, tenant_id, brand_code, name, display_name, status, version, content_hash, audit_metadata
) values (
  '${localAuthSeed.brandId}', '${localAuthSeed.tenantId}', 'local-auth-qa',
  'Local Auth QA Brand', 'Local Auth QA Brand', 'Active', '1.0.0',
  'sha256:local-auth-qa-brand-v1', '{"localSeed": true}'::jsonb
) on conflict (id) do nothing;
`,
  });
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${authServiceUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { response, body };
}

async function ensureCanonicalIdentity() {
  const exists = queryScalar(`
select exists (
  select 1
  from auth_service.identity_profiles
  where identity_id = '${localAuthSeed.identityId}'
    and normalized_username = lower('${localAuthSeed.loginId}')
);
`);

  if (exists === "t") {
    return "existing";
  }

  const created = await requestJson("/api/auth-service/authority/identities", {
    method: "POST",
    body: JSON.stringify({
      identityId: localAuthSeed.identityId,
      tenantId: localAuthSeed.tenantId,
      brandId: localAuthSeed.brandId,
      username: localAuthSeed.loginId,
      email: localAuthSeed.loginId,
      accountType: "ADMIN",
      initialStatus: "Active",
      password: localAuthSeed.password,
      actorIdentityId: null,
      correlationId: "ci-auth-seed-create",
    }),
  });

  if (created.response.status !== 201) {
    throw new Error(
      `Canonical Auth Service seed failed (${created.response.status}): ${JSON.stringify(created.body)}`
    );
  }

  return "created";
}

function seedAuthorizationAndServiceAccount() {
  runPsql(["-q"], {
    input: `
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
  '${localAuthSeed.identityId}',
  '33333333-3333-4333-8333-333333333333',
  'GLOBAL',
  'local',
  '2026-07-01T00:00:00Z',
  null
)
on conflict (id) do update set effective_to = null;

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

insert into auth_service.identity_claims (
  id, identity_id, claim_type, claim_value, issuer, issued_at, expires_at, revoked_at
)
values (
  '66666666-6666-4666-8666-666666666666',
  '${localAuthSeed.identityId}',
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

insert into auth_service.memberships (
  id, identity_id, scope_type, scope_id, metadata, effective_from, effective_to
)
values (
  '77777777-7777-4777-8777-777777777777',
  '${localAuthSeed.identityId}',
  'GLOBAL',
  'local',
  '{"localSeed": true}'::jsonb,
  '2026-07-01T00:00:00Z',
  null
)
on conflict (id) do update set effective_to = null;

insert into auth_service.identities (
  id, login_id, identity_type, lifecycle_state, metadata, created_at, updated_at
)
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
  lifecycle_state = excluded.lifecycle_state,
  updated_at = now();

insert into auth_service.oauth_clients (
  id, client_id, display_name, allowed_grant_types, redirect_uris, scopes,
  requires_pkce, mtls_bound, active
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
  scopes = excluded.scopes,
  active = true,
  disabled_at = null;

insert into auth_service.oauth_client_secrets (
  id, oauth_client_id, public_reference, secret_hash, hash_algorithm, created_at, expires_at, revoked_at
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
  expires_at = null,
  revoked_at = null;

insert into auth_service.service_accounts (
  id, identity_id, oauth_client_id, service_name, mtls_optional, active
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
  active = true;
`,
  });
}

seedPlatformHierarchy();
const canonicalIdentity = await ensureCanonicalIdentity();
seedAuthorizationAndServiceAccount();

printJson({
  status: "PASS",
  localOnly: true,
  guardrails,
  canonicalIdentity,
  loginId: localAuthSeed.loginId,
  password: localAuthSeed.password,
  allowedPermission: localAuthSeed.allowedPermission,
  deniedPermission: localAuthSeed.deniedPermission,
  serviceName: localAuthSeed.serviceName,
  serviceClientSecret: localAuthSeed.serviceClientSecret,
  serviceAllowedScope: localAuthSeed.serviceAllowedScope,
  serviceDeniedScope: localAuthSeed.serviceDeniedScope,
});
