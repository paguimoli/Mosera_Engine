import { existsSync, readFileSync } from "node:fs";
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
run("npm", ["run", "game-engine:settlement-prep-test"]);

const schemaPath = "services/game-engine/database/002_durable_evaluation_storage.sql";
assert(existsSync(schemaPath), "Durable evaluation storage schema artifact missing.", { schemaPath });
const schema = readFileSync(schemaPath, "utf8");
for (const token of [
  "game_engine.evaluation_runs",
  "game_engine.evaluation_batches",
  "game_engine.evaluation_records",
  "game_engine.evaluation_checkpoints",
  "idempotency_key text not null unique",
  "settlement_consumer_status",
  "prevent_evaluation_record_mutation",
]) {
  assert(schema.toLowerCase().includes(token.toLowerCase()), "Durable schema artifact missing required token.", { token });
}

for (const path of [
  "services/game-engine/src/GameEngine.Application/Services/SettlementEvaluationPreparationServices.cs",
  "docs/architecture/phase-22-6l-durable-evaluation-settlement-prep.md",
  "docs/architecture/adr/ADR-019-settlement-consumes-game-evaluations.md",
]) {
  assert(existsSync(path), "Required settlement preparation artifact missing.", { path });
}

const storageStatus = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-storage-status`);
assert(storageStatus.response.status === 200 && storageStatus.body?.success === true, "Evaluation storage status endpoint failed.", {
  status: storageStatus.response.status,
  body: storageStatus.body,
});
assert(storageStatus.body.evaluationStorageStatus.durableSchemaArtifactPresent === true, "Durable schema artifact must be reported.", {
  body: storageStatus.body,
});
assert(storageStatus.body.evaluationStorageStatus.settlementConsumerIntegrationEnabled === false, "Settlement integration must remain disabled.", {
  body: storageStatus.body,
});

const readiness = await requestJson(`${gameEngineUrl}/api/game-engine/settlement-readiness`);
assert(readiness.response.status === 200 && readiness.body?.success === true, "Settlement readiness endpoint failed.", {
  status: readiness.response.status,
  body: readiness.body,
});
assert(readiness.body.status === "BLOCKED", "Settlement readiness must remain blocked.", { body: readiness.body });
assert(readiness.body.settlementReadiness.enabled === false && readiness.body.settlementReadiness.activationAllowed === false, "Settlement consumer must be disabled.", {
  body: readiness.body,
});

const activation = await requestJson(`${gameEngineUrl}/api/game-engine/settlement-consumer/activate`, {
  method: "POST",
});
assert(activation.response.status === 400 && activation.body?.success === false, "Settlement consumer activation must be rejected.", {
  status: activation.response.status,
  body: activation.body,
});
assert(activation.body.settlementIntegrationEnabled === false && activation.body.financialPostingEnabled === false, "Rejected activation must remain mutation-free.", {
  body: activation.body,
});

const executionResult = await requestJson(`${gameEngineUrl}/api/game-engine/module-execution/run`, {
  method: "POST",
});
assert(executionResult.response.status === 202 && executionResult.body?.success === true, "Module execution run failed.", {
  status: executionResult.response.status,
  body: executionResult.body,
});
const execution = executionResult.body.moduleExecution;
assert(execution.settlementIntegrationTriggered === false && execution.financialMutationPerformed === false, "Execution must remain settlement/financial disabled.", {
  execution,
});

const settlementRecords = await requestJson(`${gameEngineUrl}/api/game-engine/settlement-evaluation-records`);
assert(settlementRecords.response.status === 200 && settlementRecords.body?.success === true, "Settlement evaluation records endpoint failed.", {
  status: settlementRecords.response.status,
  body: settlementRecords.body,
});
assert(Array.isArray(settlementRecords.body.settlementEvaluationRecords), "Settlement evaluation records must be a list.", {
  body: settlementRecords.body,
});
assert(settlementRecords.body.settlementIntegrationEnabled === false && settlementRecords.body.financialPostingEnabled === false, "Settlement query must not activate financial behavior.", {
  body: settlementRecords.body,
});
assert(!settlementRecords.body.settlementEvaluationRecords.some((record) => record.outcome === "Rejected" || record.consumerStatus === "Consumed"), "Settlement read model must exclude rejected and consumed records.", {
  body: settlementRecords.body,
});

const consumerStatus = await requestJson(`${gameEngineUrl}/api/game-engine/settlement-consumer-status`);
assert(consumerStatus.response.status === 200 && consumerStatus.body?.success === true, "Settlement consumer status endpoint failed.", {
  status: consumerStatus.response.status,
  body: consumerStatus.body,
});
assert(consumerStatus.body.settlementConsumerStatus.enabled === false, "Settlement consumer status must remain disabled.", {
  body: consumerStatus.body,
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

pass("Evaluation Settlement preparation QA completed.", {
  gameEngineUrl,
  durableSchemaArtifactPresent: storageStatus.body.evaluationStorageStatus.durableSchemaArtifactPresent,
  settlementConsumerEnabled: consumerStatus.body.settlementConsumerStatus.enabled,
  readinessStatus: readiness.body.status,
  settlementReadyRecords: settlementRecords.body.settlementEvaluationRecords.length,
  settlementIntegrationEnabled: settlementRecords.body.settlementIntegrationEnabled,
  financialPostingEnabled: settlementRecords.body.financialPostingEnabled,
});
