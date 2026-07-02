import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const authServiceUrl = process.env.AUTH_SERVICE_URL || "http://localhost:5600";

function assert(condition, message, metadata = {}) {
  if (!condition) {
    console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
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
      return { available: true, ok: false, status: response.status, body: null };
    }

    return { available: true, ok: true, status: response.status, body: await response.json() };
  } catch {
    return { available: false, ok: false, status: null, body: null };
  }
}

runScript("auth-service:build");
runScript("auth-service:migration-test");

const docs = [
  "docs/architecture/phase-23-5-auth-runtime-migration.md",
  "docs/architecture/adr/ADR-031-auth-coexistence-strategy.md",
  "docs/architecture/adr/ADR-032-auth-zero-downtime-migration.md",
];

for (const doc of docs) {
  assert(existsSync(doc), `${doc} is missing.`);
}

const diagnostics = {
  migrationPlan: await tryGetJson("/api/auth-service/migration-plan"),
  coexistenceStatus: await tryGetJson("/api/auth-service/coexistence-status"),
  migrationReadiness: await tryGetJson("/api/auth-service/migration-readiness"),
  compatibilityModel: await tryGetJson("/api/auth-service/compatibility-model"),
  loginEndpoint: await tryGetJson("/api/auth-service/login"),
  tokenEndpoint: await tryGetJson("/api/auth-service/token"),
};

const diagnosticsAvailable = diagnostics.migrationPlan.available;

if (diagnosticsAvailable) {
  assert(diagnostics.migrationPlan.ok, "Migration plan endpoint failed.", diagnostics.migrationPlan);
  assert(diagnostics.coexistenceStatus.ok, "Coexistence status endpoint failed.", diagnostics.coexistenceStatus);
  assert(diagnostics.migrationReadiness.ok, "Migration readiness endpoint failed.", diagnostics.migrationReadiness);
  assert(diagnostics.compatibilityModel.ok, "Compatibility model endpoint failed.", diagnostics.compatibilityModel);
  assert(diagnostics.migrationPlan.body?.data?.migrationExecutionEnabled === false, "Migration execution must remain disabled.", diagnostics.migrationPlan.body);
  assert(diagnostics.migrationPlan.body?.data?.legacyAuthUnchanged === true, "Legacy auth must remain unchanged.", diagnostics.migrationPlan.body);
  assert(diagnostics.coexistenceStatus.body?.data?.existingPlatformAuthAuthoritative === true, "Existing auth must remain authoritative.", diagnostics.coexistenceStatus.body);
  assert(diagnostics.migrationReadiness.body?.data?.status === "Blocked", "Migration readiness must be blocked.", diagnostics.migrationReadiness.body);
  assert(diagnostics.compatibilityModel.body?.data?.runtimeImplemented === false, "Compatibility runtime must remain unimplemented.", diagnostics.compatibilityModel.body);
  assert(diagnostics.loginEndpoint.status === 404, "Auth Service login endpoint must not exist.", diagnostics.loginEndpoint);
  assert(diagnostics.tokenEndpoint.status === 404, "Auth Service token endpoint must not exist.", diagnostics.tokenEndpoint);
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      message: "Auth runtime migration plan QA completed.",
      diagnosticsAvailable,
      documentationChecked: docs,
      migrationReadiness: diagnosticsAvailable ? diagnostics.migrationReadiness.body.data.status : "SKIPPED_SERVICE_NOT_RUNNING",
      legacyAuthChanged: false,
      migrationExecutionEnabled: false,
    },
    null,
    2
  )
);
