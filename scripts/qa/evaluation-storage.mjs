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
run("npm", ["run", "game-engine:evaluation-storage-test"]);

for (const path of [
  "services/game-engine/src/GameEngine.Application/Services/EvaluationPersistenceServices.cs",
  "services/game-engine/src/GameEngine.Application/Services/GameModuleExecutionService.cs",
  "services/game-engine/src/GameEngine.Domain/Model/EvaluationOrchestrationModels.cs",
  "docs/architecture/phase-22-6k-persistent-evaluation-storage.md",
  "docs/architecture/adr/ADR-018-persistent-evaluation-storage.md",
]) {
  assert(existsSync(path), "Required evaluation storage artifact missing.", { path });
}

const recordsBefore = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-records`);
assert(recordsBefore.response.status === 200 && recordsBefore.body?.success === true, "Evaluation records endpoint failed before execution.", {
  status: recordsBefore.response.status,
  body: recordsBefore.body,
});
const beforeCount = recordsBefore.body.evaluationRecords.length;

const readers = await requestJson(`${gameEngineUrl}/api/game-engine/ticket-readers`);
assert(readers.response.status === 200 && readers.body?.success === true, "Ticket readers endpoint failed.", {
  status: readers.response.status,
  body: readers.body,
});
assert(readers.body.databaseTicketReaderEnabled === true, "Database ticket reader must be enabled.", { body: readers.body });
assert(readers.body.ticketReaders.some((reader) => reader.name === "DatabaseTicketReader" && reader.supportsReadByCursor), "Database ticket reader cursor support must be exposed.", {
  body: readers.body,
});

const executionResult = await requestJson(`${gameEngineUrl}/api/game-engine/module-execution/run`, {
  method: "POST",
});
assert(executionResult.response.status === 202 && executionResult.body?.success === true, "Evaluation execution run failed.", {
  status: executionResult.response.status,
  body: executionResult.body,
});
const execution = executionResult.body.moduleExecution;
assert(execution.evaluationRecords.length > 0, "Execution must return persistent evaluation records.", { execution });
assert(execution.settlementIntegrationTriggered === false, "Settlement integration must remain disabled.", { execution });
assert(execution.financialMutationPerformed === false, "Financial mutation must remain disabled.", { execution });

const recordsAfter = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-records`);
assert(recordsAfter.response.status === 200 && recordsAfter.body?.success === true, "Evaluation records endpoint failed after execution.", {
  status: recordsAfter.response.status,
  body: recordsAfter.body,
});
assert(recordsAfter.body.evaluationRecords.length >= beforeCount, "Persistent record count must not shrink.", {
  beforeCount,
  afterCount: recordsAfter.body.evaluationRecords.length,
  execution,
});
if (execution.recordsCreated > 0) {
  assert(recordsAfter.body.evaluationRecords.length >= beforeCount + execution.recordsCreated, "Persistent record count did not increase by created records.", {
    beforeCount,
    afterCount: recordsAfter.body.evaluationRecords.length,
    execution,
  });
}
assert(recordsAfter.body.diagnostics.replaySafePersistenceEnabled === true, "Replay-safe persistence must be reported.", {
  diagnostics: recordsAfter.body.diagnostics,
});
assert(recordsAfter.body.diagnostics.settlementIntegrationEnabled === false, "Settlement integration must stay disabled in storage diagnostics.", {
  diagnostics: recordsAfter.body.diagnostics,
});

const firstRecord = execution.evaluationRecords[0];
assert(firstRecord.id && firstRecord.idempotencyKey, "Execution records must expose ids and idempotency keys.", { firstRecord });

const recordDetail = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-records/${firstRecord.id}`);
assert(recordDetail.response.status === 200 && recordDetail.body?.success === true, "Evaluation record detail endpoint failed.", {
  status: recordDetail.response.status,
  body: recordDetail.body,
});
assert(recordDetail.body.evaluationRecord.idempotencyKey === firstRecord.idempotencyKey, "Evaluation record detail idempotency key mismatch.", {
  recordDetail: recordDetail.body,
  firstRecord,
});

const runRecords = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-runs/${execution.runId}/records`);
assert(runRecords.response.status === 200 && runRecords.body?.success === true, "Evaluation run records endpoint failed.", {
  status: runRecords.response.status,
  body: runRecords.body,
});
assert(runRecords.body.evaluationRecords.length === execution.evaluationRecords.length, "Run record query must return execution records.", {
  runRecords: runRecords.body,
  execution,
});

const checkpoints = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-checkpoints`);
assert(checkpoints.response.status === 200 && checkpoints.body?.success === true, "Evaluation checkpoints endpoint failed.", {
  status: checkpoints.response.status,
  body: checkpoints.body,
});
assert(checkpoints.body.evaluationCheckpoints.some((checkpoint) => checkpoint.runId === execution.runId && checkpoint.status === "Completed"), "Completed persistent checkpoint missing.", {
  checkpoints: checkpoints.body,
  execution,
});

const resume = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-runs/${execution.runId}/resume`, {
  method: "POST",
});
assert(resume.response.status === 202 && resume.body?.success === true, "Evaluation run resume endpoint failed.", {
  status: resume.response.status,
  body: resume.body,
});
assert(resume.body.moduleExecution.recordsCreated === 0, "Resume of completed run must not create duplicate records.", {
  resume: resume.body,
});
assert(resume.body.moduleExecution.financialMutationPerformed === false && resume.body.moduleExecution.settlementIntegrationTriggered === false, "Resume must not trigger financial or settlement behavior.", {
  resume: resume.body,
});

const recordsAfterResume = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-records`);
assert(recordsAfterResume.body.evaluationRecords.length === recordsAfter.body.evaluationRecords.length, "Resume must not duplicate persistent records.", {
  after: recordsAfter.body.evaluationRecords.length,
  afterResume: recordsAfterResume.body.evaluationRecords.length,
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
  assert(authority.body.authority.settlement.authority === "SERVICE", "Settlement authority changed.", { authority: authority.body.authority });
  assert(authority.body.authority.ledger.authority === "SERVICE", "Ledger authority changed.", { authority: authority.body.authority });
  assert(authority.body.authority.credit.authority === "SERVICE", "Credit authority changed.", { authority: authority.body.authority });
}

pass("Evaluation storage QA completed.", {
  gameEngineUrl,
  runId: execution.runId,
  recordsBefore: beforeCount,
  recordsAfter: recordsAfter.body.evaluationRecords.length,
  recordsCreated: execution.recordsCreated,
  checkpoints: checkpoints.body.evaluationCheckpoints.length,
  settlementIntegrationTriggered: execution.settlementIntegrationTriggered,
  financialMutationPerformed: execution.financialMutationPerformed,
});
