import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function check(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

const read = (path) => readFileSync(path, "utf8");
const migration = read("scripts/migrations/local/076_add_authentication_authority_consolidation.sql");
const manifest = JSON.parse(read("scripts/migrations/migration-manifest.json"));
const authority = read("services/auth-service/src/AuthService.Application/Services/AuthenticationAuthorityService.cs");
const passwordService = read("services/auth-service/src/AuthService.Application/Services/Argon2idPasswordService.cs");
const repository = read("services/auth-service/src/AuthService.Infrastructure/PostgresAuthenticationAuthorityRepository.cs");
const provider = read("src/domains/auth/auth-provider.ts");
const runtimeRoutes = [
  "app/api/auth/login/route.ts",
  "app/api/auth/logout/route.ts",
  "app/api/auth/password-reset/request/route.ts",
  "app/api/auth/password-reset/confirm/route.ts",
  "app/api/auth/mfa/challenge/verify/route.ts",
  "app/api/auth/mfa/totp/start/route.ts",
  "app/api/auth/mfa/totp/verify/route.ts",
  "app/api/auth/mfa/totp/disable/route.ts",
].map(read).join("\n");
const apiProgram = read("services/auth-service/src/AuthService.Api/Program.cs");

const migrations = manifest.entries ?? [];
check(migrations.filter((item) => item.id === "076_add_authentication_authority_consolidation").length === 1, "Migration 076 must appear exactly once.");
check(migrations.filter((item) => item.path === "scripts/migrations/local/076_add_authentication_authority_consolidation.sql").length === 1, "Migration 076 path must appear exactly once.");

for (const table of [
  "identity_profiles",
  "external_identity_bindings",
  "password_credential_versions",
  "canonical_sessions",
  "password_reset_requests",
  "password_reset_consumptions",
  "identity_lifecycle_events",
  "authentication_audit_evidence",
  "authentication_login_attempts",
]) {
  check(migration.includes(`auth_service.${table}`), `Migration must define ${table}.`);
}

check(migration.includes("algorithm = 'ARGON2ID'"), "Database must enforce Argon2id-only credentials.");
check(migration.includes("ux_auth_single_active_session"), "Database must enforce one active session.");
check(migration.includes("canonical authentication evidence is append-only"), "Append-only authentication evidence guard is missing.");
check(migration.includes("identity brand must belong to identity tenant"), "Tenant/brand isolation trigger is missing.");
check(migration.includes("at most two governed emergency accounts"), "Emergency account count governance is missing.");
check(passwordService.includes("new Argon2id"), "Argon2id implementation is missing.");
check(!passwordService.includes("PBKDF2"), "Canonical password service must not accept PBKDF2.");
check(authority.includes("password_reuse_rejected"), "Password reuse protection is missing.");
check(authority.includes("ServiceShadow") && authority.includes("ServiceDryRun"), "All AUTH_AUTHORITY modes must be modeled.");
check(authority.includes("service_authority_not_promoted"), "SERVICE authority must fail closed.");
check(repository.includes("BeginTransactionAsync"), "Canonical repository must use database transactions.");
check(repository.includes("InsertTokens") && repository.includes("InsertAudit"), "Session transaction must include tokens and audit evidence.");
check(repository.includes("HasSuperAdminGovernance"), "Super Admin governance enforcement is missing.");
check(repository.includes("AppendAnonymousLoginFailure"), "Unknown-identity login failures must leave evidence.");
check(provider.includes('return "MONOLITH"'), "AUTH_AUTHORITY must default to MONOLITH.");
check(provider.includes("legacyFallbackAvailable") === false, "Authority provider must not model a legacy fallback.");

for (const forbiddenImport of ["auth.controller", "auth.service", "mfa.service", "auth.repository", "api-client.service"]) {
  check(!runtimeRoutes.includes(forbiddenImport), `Reachable authentication mutation routes must not import ${forbiddenImport}.`);
}
check(runtimeRoutes.includes("auth-service.client"), "Legacy-compatible routes must delegate to Auth Service.");

for (const removedMutationPath of [
  "src/domains/auth/auth.controller.ts",
  "src/domains/auth/auth.service.ts",
  "src/domains/auth/mfa.service.ts",
  "src/domains/auth/api-client.service.ts",
  "src/domains/auth/api-client.repository.ts",
]) {
  check(!existsSync(removedMutationPath), `Legacy mutation implementation must be removed: ${removedMutationPath}`);
}
for (const delegatedUtility of [
  "scripts/reset-platform-user-password.ts",
  "scripts/bootstrap-break-glass-accounts.ts",
  "scripts/create-platform-operator.ts",
  "scripts/verify-platform-password.ts",
]) {
  const source = read(delegatedUtility);
  check(source.includes("AUTH_SERVICE_URL"), `${delegatedUtility} must delegate to Auth Service.`);
  check(!source.includes("supabaseServerAdmin"), `${delegatedUtility} must not mutate legacy authentication persistence.`);
}

const endpointRegistrations = [...apiProgram.matchAll(/group\.Map(?:Get|Post|Put|Delete)\("([^"]+)"/g)].map((match) => match[1]);
check(new Set(endpointRegistrations).size === endpointRegistrations.length, "Auth Service contains duplicate endpoint registrations.");
check((apiProgram.match(/AddSingleton<IAuthenticationAuthorityRepository/g) ?? []).length === 2, "Canonical repository DI must have exactly one disabled and one durable branch.");

const gamingDiff = spawnSync("git", ["diff", "--name-only", "--", "services/gaming-engine"], { encoding: "utf8" });
check(gamingDiff.status === 0 && gamingDiff.stdout.trim() === "", "services/gaming-engine must remain unchanged.", { diff: gamingDiff.stdout });

console.log(JSON.stringify({
  status: "PASS",
  authority: "MONOLITH",
  canonicalPasswordAlgorithm: "ARGON2ID",
  legacyMutationRoutesDelegated: true,
  productionPromotionEnabled: false,
  migration: "076_add_authentication_authority_consolidation",
}, null, 2));
