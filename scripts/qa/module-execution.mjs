import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const gameEngineUrl =
  process.env.QA_GAME_ENGINE_URL ||
  (existsSync("/.dockerenv") || appUrl.includes("app:3000")
    ? "http://game-engine:8080"
    : "http://localhost:5500");
let sessionToken = process.env.QA_ADMIN_SESSION_TOKEN || process.env.OPS_ADMIN_SESSION_TOKEN;
const adminUsername = process.env.QA_ADMIN_USERNAME || "admin2";
const adminPassword = process.env.QA_ADMIN_PASSWORD || "";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function pass(message, metadata = {}) {
  console.log(JSON.stringify({ status: "PASS", message, ...metadata }, null, 2));
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

function run(command, args, metadata = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });

  assert(result.status === 0, `${command} ${args.join(" ")} failed.`, {
    ...metadata,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

async function ensureSessionToken() {
  if (sessionToken) return;
  if (!adminPassword) return;

  const login = await requestJson(`${appUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: adminUsername,
      password: adminPassword,
    }),
  });

  assert(login.response.status === 200 && login.body?.success === true && login.body.sessionToken, "Admin login failed.", {
    status: login.response.status,
    body: login.body,
  });

  sessionToken = login.body.sessionToken;
}

run("npm", ["run", "game-engine:build"]);
run("npm", ["run", "game-engine:test"]);
run("npm", ["run", "game-engine:module-execution-test"]);

for (const path of [
  "services/game-engine/src/GameEngine.Application/Services/GameModuleExecutionService.cs",
  "services/game-engine/src/GameEngine.Domain/Model/EvaluationOrchestrationModels.cs",
  "docs/architecture/phase-22-6j-game-module-execution.md",
  "docs/architecture/adr/ADR-017-game-module-execution-framework.md",
]) {
  assert(existsSync(path), "Required module execution artifact missing.", { path });
}

const diagnosticsBefore = await requestJson(`${gameEngineUrl}/api/game-engine/module-execution`);
assert(diagnosticsBefore.response.status === 200 && diagnosticsBefore.body?.success === true, "Module execution diagnostics endpoint failed.", {
  status: diagnosticsBefore.response.status,
  body: diagnosticsBefore.body,
});
assert(diagnosticsBefore.body.ticketDatabaseReadsEnabled === true, "Ticket database reader must be active for execution storage.", {
  body: diagnosticsBefore.body,
});
assert(diagnosticsBefore.body.settlementIntegrationEnabled === false, "Settlement integration must remain disabled.", {
  body: diagnosticsBefore.body,
});

const resolution = await requestJson(`${gameEngineUrl}/api/game-engine/module-resolution`);
assert(resolution.response.status === 200 && resolution.body?.success === true, "Module resolution endpoint failed.", {
  status: resolution.response.status,
  body: resolution.body,
});
assert(resolution.body.moduleResolution.some((item) => item.moduleId === "KENO_GENERIC" && item.resolved === true), "Keno module must resolve.", {
  body: resolution.body,
});
assert(resolution.body.moduleResolution.some((item) => item.moduleId === "HOT_SPOT" && item.resolved === false), "Development lifecycle module should be rejected for execution.", {
  body: resolution.body,
});

const readers = await requestJson(`${gameEngineUrl}/api/game-engine/ticket-readers`);
assert(readers.response.status === 200 && readers.body?.success === true, "Ticket readers endpoint failed.", {
  status: readers.response.status,
  body: readers.body,
});
assert(readers.body.databaseTicketReaderEnabled === true, "Database ticket reader must be enabled.", {
  body: readers.body,
});
assert(readers.body.ticketReaders.some((reader) => reader.name === "DatabaseTicketReader"), "Database ticket reader must be registered.", {
  body: readers.body,
});

const executionResult = await requestJson(`${gameEngineUrl}/api/game-engine/module-execution/run`, {
  method: "POST",
});
assert(executionResult.response.status === 202 && executionResult.body?.success === true, "Module execution run failed.", {
  status: executionResult.response.status,
  body: executionResult.body,
});
const execution = executionResult.body.moduleExecution;
assert(execution.moduleId === "KENO_GENERIC", "Keno module must execute through the framework.", { execution });
assert(execution.ticketsRead > 0, "Placeholder tickets must be read.", { execution });
assert(execution.evaluationRecords.length > 0, "Immutable evaluation records must be available.", { execution });
assert(execution.ticketFailures > 0, "Single-ticket validation failure evidence must be present.", { execution });
assert(execution.settlementIntegrationTriggered === false, "Settlement integration must not run.", { execution });
assert(execution.financialMutationPerformed === false, "Financial behavior must not change.", { execution });
assert(execution.evaluationRecords.every((record) => record.moduleId === "KENO_GENERIC" && record.reasonCode && record.paytableVersion), "Evaluation records must include immutable module metadata.", {
  execution,
});

const executionDetail = await requestJson(`${gameEngineUrl}/api/game-engine/module-execution/${execution.runId}`);
assert(executionDetail.response.status === 200 && executionDetail.body?.success === true, "Module execution detail endpoint failed.", {
  status: executionDetail.response.status,
  body: executionDetail.body,
});

await ensureSessionToken();
if (sessionToken) {
  const authority = await requestJson(`${appUrl}/api/authority/status`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert(authority.response.status === 200 && authority.body?.success === true, "Authority status failed.", {
    status: authority.response.status,
    body: authority.body,
  });
  assert(authority.body.authority.settlement.authority === "SERVICE", "Settlement authority changed.", {
    authority: authority.body.authority,
  });
  assert(authority.body.authority.ledger.authority === "SERVICE", "Ledger authority changed.", {
    authority: authority.body.authority,
  });
  assert(authority.body.authority.credit.authority === "SERVICE", "Credit authority changed.", {
    authority: authority.body.authority,
  });
}

pass("Game Module execution QA completed.", {
  gameEngineUrl,
  runId: execution.runId,
  batchId: execution.batchId,
  moduleId: execution.moduleId,
  ticketsRead: execution.ticketsRead,
  recordsCreated: execution.recordsCreated,
  ticketFailures: execution.ticketFailures,
  settlementIntegrationTriggered: execution.settlementIntegrationTriggered,
  financialMutationPerformed: execution.financialMutationPerformed,
});
