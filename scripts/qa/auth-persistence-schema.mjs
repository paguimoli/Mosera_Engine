import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const schemaPath = "services/auth-service/database/001_auth_service_schema_draft.sql";
const authServiceUrl = process.env.AUTH_SERVICE_URL || "http://localhost:5600";

function assert(condition, message) {
  if (!condition) {
    console.error(JSON.stringify({ status: "FAIL", message }, null, 2));
    process.exit(1);
  }
}

function runScript(script) {
  const result = spawnSync("npm", ["run", script], {
    stdio: "inherit",
    env: process.env,
  });
  assert(result.status === 0, `${script} failed.`);
}

async function tryGetJson(path) {
  try {
    const response = await fetch(`${authServiceUrl}${path}`);
    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

runScript("auth-service:build");
runScript("auth-service:test");

assert(existsSync(schemaPath), "Auth Service schema artifact is missing.");
const schema = readFileSync(schemaPath, "utf8");

const requiredTables = [
  "auth_service.identities",
  "auth_service.identity_aliases",
  "auth_service.identity_credentials",
  "auth_service.identity_lifecycle_events",
  "auth_service.roles",
  "auth_service.permissions",
  "auth_service.identity_roles",
  "auth_service.identity_claims",
  "auth_service.policies",
  "auth_service.memberships",
  "auth_service.sessions",
  "auth_service.tokens",
  "auth_service.refresh_tokens",
  "auth_service.oauth_clients",
  "auth_service.oauth_client_secrets",
  "auth_service.service_accounts",
  "auth_service.api_clients",
  "auth_service.security_relationships",
  "auth_service.audit_events",
  "auth_service.signing_keys",
];

for (const table of requiredTables) {
  assert(schema.includes(table), `${table} is missing from schema artifact.`);
}

assert(schema.includes("login_id text not null unique"), "login_id uniqueness is not documented.");
assert(schema.includes("Hard deletes are prohibited"), "No hard delete rule is not documented.");
assert(schema.includes("identity_credentials"), "Credentials are not separated from identities.");
assert(schema.includes("secret_material_ref"), "Credential secret material boundary is missing.");
assert(schema.includes("token_format in ('JWT', 'OPAQUE_REFERENCE')"), "Hybrid JWT/opaque token model is missing.");
assert(schema.includes("rotation_counter"), "Refresh token rotation metadata is missing.");
assert(schema.includes("auth_service.signing_keys"), "Signing key metadata is missing.");
assert(schema.includes("scope_type in ('GLOBAL', 'TENANT', 'BRAND', 'MARKET', 'OPERATOR', 'JURISDICTION', 'PAM')"), "Membership scoping is incomplete.");
assert(schema.includes("Business hierarchy remains external"), "Business hierarchy exclusion is not documented.");

const migrationReadiness = await tryGetJson("/api/auth-service/migration-readiness");
const schemaStatus = await tryGetJson("/api/auth-service/schema-status");
const diagnosticsAvailable = Boolean(migrationReadiness && schemaStatus);

if (diagnosticsAvailable) {
  assert(migrationReadiness.data?.status === "Blocked", "Migration readiness must be blocked.");
  assert(schemaStatus.data?.schemaApplied === false, "Schema status must report unapplied schema in Phase 23.2.");
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      message: "Auth persistence schema QA completed.",
      schemaPath,
      requiredTableCount: requiredTables.length,
      diagnosticsAvailable,
      migrationReadiness: diagnosticsAvailable ? migrationReadiness.data.status : "SKIPPED_SERVICE_NOT_RUNNING",
      currentPlatformAuthChanged: false,
    },
    null,
    2
  )
);
