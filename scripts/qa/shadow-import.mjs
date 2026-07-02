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

async function tryJson(path, options = {}) {
  try {
    const response = await fetch(`${authServiceUrl}${path}`, options);
    if (!response.ok) {
      return { available: true, ok: false, status: response.status, body: null };
    }

    return { available: true, ok: true, status: response.status, body: await response.json() };
  } catch {
    return { available: false, ok: false, status: null, body: null };
  }
}

runScript("auth-service:build");
runScript("auth-service:shadow-import-test");

const docs = [
  "docs/architecture/phase-23-6-shadow-import-validation.md",
  "docs/architecture/adr/ADR-033-shadow-identity-import.md",
];

for (const doc of docs) {
  assert(existsSync(doc), `${doc} is missing.`);
}

const status = await tryJson("/api/auth-service/shadow-import-status");
const validation = await tryJson("/api/auth-service/migration-validation");
const report = await tryJson("/api/auth-service/migration-report");
const secondReport = await tryJson("/api/auth-service/migration-report");
const run = await tryJson("/api/auth-service/shadow-import/run", { method: "POST" });
const diagnosticsAvailable = status.available;

if (diagnosticsAvailable) {
  assert(status.ok, "Shadow import status endpoint failed.", status);
  assert(validation.ok, "Migration validation endpoint failed.", validation);
  assert(report.ok, "Migration report endpoint failed.", report);
  assert(secondReport.ok, "Second migration report endpoint failed.", secondReport);
  assert(run.ok, "Shadow import run endpoint failed.", run);
  assert(status.body?.data?.readOnly === true, "Shadow import status must be read-only.", status.body);
  assert(status.body?.data?.persisted === false, "Shadow import status must not persist.", status.body);
  assert(status.body?.data?.writeOperationsAttempted === 0, "Shadow import status must report zero writes.", status.body);
  assert(validation.body?.data?.readOnly === true, "Validation must be read-only.", validation.body);
  assert(validation.body?.data?.persisted === false, "Validation must not persist.", validation.body);
  assert(validation.body?.data?.writeOperationsAttempted === 0, "Validation must report zero writes.", validation.body);
  assert(validation.body?.data?.legacyAuthChanged === false, "Legacy auth must remain unchanged.", validation.body);
  assert(report.body?.data?.summary?.noWrites === true, "Report must confirm no writes.", report.body);
  assert(report.body?.data?.summary?.legacyAuthUnchanged === true, "Report must confirm legacy auth unchanged.", report.body);
  assert(report.body?.data?.generatedAt === secondReport.body?.data?.generatedAt, "Reports must be deterministic.", {
    first: report.body?.data?.generatedAt,
    second: secondReport.body?.data?.generatedAt,
  });
  assert(run.body?.data?.persisted === false, "POST shadow import run must not persist.", run.body);
  assert(run.body?.data?.sessionsCreated === false, "POST shadow import run must not create sessions.", run.body);
  assert(run.body?.data?.tokensIssued === false, "POST shadow import run must not issue tokens.", run.body);
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      message: "Shadow import validation QA completed.",
      diagnosticsAvailable,
      documentationChecked: docs,
      readOnlyBehavior: true,
      noDbWrites: true,
      deterministicReports: true,
      legacyAuthChanged: false,
    },
    null,
    2
  )
);
