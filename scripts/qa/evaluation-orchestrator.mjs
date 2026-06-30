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
run("npm", ["run", "game-engine:evaluation-test"]);

if (existsSync("services/game-engine")) {
  for (const path of [
    "services/game-engine/src/GameEngine.Domain/Model/EvaluationOrchestrationModels.cs",
    "services/game-engine/src/GameEngine.Application/Services/EvaluationBatchServices.cs",
    "services/game-engine/src/GameEngine.Application/Services/EvaluationOrchestrator.cs",
    "docs/architecture/phase-22-6g-evaluation-orchestrator.md",
    "docs/architecture/adr/ADR-014-evaluation-orchestrator-batch-processing.md",
  ]) {
    assert(existsSync(path), "Required evaluation orchestrator artifact missing.", { path });
  }
}

const statusResult = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-orchestrator-status`);
assert(statusResult.response.status === 200 && statusResult.body?.success === true, "Evaluation orchestrator status endpoint failed.", {
  status: statusResult.response.status,
  body: statusResult.body,
});
const orchestratorStatus = statusResult.body.evaluationOrchestratorStatus;
assert(orchestratorStatus.productionRabbitMqWiringEnabled === false, "Production RabbitMQ wiring must remain disabled.", {
  orchestratorStatus,
});
assert(orchestratorStatus.settlementIntegrationEnabled === false, "Settlement integration must remain disabled.", {
  orchestratorStatus,
});

const runsResult = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-runs`);
assert(runsResult.response.status === 200 && runsResult.body?.success === true, "Evaluation runs endpoint failed.", {
  status: runsResult.response.status,
  body: runsResult.body,
});
const runs = runsResult.body.evaluationRuns;
assert(Array.isArray(runs) && runs.length > 0, "Seed evaluation run must be visible.", { runs });
const seedRun = runs[0];

const runDetail = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-runs/${seedRun.id}`);
assert(runDetail.response.status === 200 && runDetail.body?.success === true, "Evaluation run detail endpoint failed.", {
  status: runDetail.response.status,
  body: runDetail.body,
});

const batchesResult = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-runs/${seedRun.id}/batches`);
assert(batchesResult.response.status === 200 && batchesResult.body?.success === true, "Evaluation run batches endpoint failed.", {
  status: batchesResult.response.status,
  body: batchesResult.body,
});
const batches = batchesResult.body.evaluationBatches;
assert(Array.isArray(batches) && batches.length > 0, "Evaluation batches must be visible.", { batches });
assert(Array.isArray(batchesResult.body.workItems) && batchesResult.body.workItems.length === batches.length, "Work item diagnostics must mirror planned batches.", {
  body: batchesResult.body,
});

const batchDetail = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-batches/${batches[0].id}`);
assert(batchDetail.response.status === 200 && batchDetail.body?.success === true, "Evaluation batch detail endpoint failed.", {
  status: batchDetail.response.status,
  body: batchDetail.body,
});

const progressResult = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-progress/${seedRun.id}`);
assert(progressResult.response.status === 200 && progressResult.body?.success === true, "Evaluation progress endpoint failed.", {
  status: progressResult.response.status,
  body: progressResult.body,
});
assert(Array.isArray(progressResult.body.checkpoints) && progressResult.body.checkpoints.length === batches.length, "Checkpoint diagnostics must be visible.", {
  progress: progressResult.body,
});

const planResult = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-runs/plan`, {
  method: "POST",
});
assert(planResult.response.status === 202 && planResult.body?.success === true, "Evaluation planning endpoint failed.", {
  status: planResult.response.status,
  body: planResult.body,
});
assert(planResult.body.financialMutationPerformed === false, "Evaluation planning must not mutate financial state.", {
  body: planResult.body,
});
assert(Array.isArray(planResult.body.evaluationBatches) && planResult.body.evaluationBatches.length > 0, "Planning must create deterministic batches.", {
  body: planResult.body,
});

const plannedRun = planResult.body.evaluationRun;
const startResult = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-runs/${plannedRun.id}/start`, {
  method: "POST",
});
assert(startResult.response.status === 202 && startResult.body?.success === true, "Evaluation start endpoint failed.", {
  status: startResult.response.status,
  body: startResult.body,
});
assert(
  startResult.body.productionRabbitMqWiringEnabled === false && startResult.body.settlementIntegrationTriggered === false,
  "Evaluation start must remain in-memory and settlement-disconnected.",
  { body: startResult.body }
);

const retryRun = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-runs/${plannedRun.id}/retry`, {
  method: "POST",
});
assert(retryRun.response.status === 202 && retryRun.body?.success === true, "Evaluation run retry endpoint failed.", {
  status: retryRun.response.status,
  body: retryRun.body,
});
assert(retryRun.body.mutationPerformed === false, "Evaluation run retry must not mutate financial state.", {
  body: retryRun.body,
});

const retryBatch = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-batches/${planResult.body.evaluationBatches[0].id}/retry`, {
  method: "POST",
});
assert(retryBatch.response.status === 202 && retryBatch.body?.success === true, "Evaluation batch retry endpoint failed.", {
  status: retryBatch.response.status,
  body: retryBatch.body,
});
assert(retryBatch.body.mutationPerformed === false, "Evaluation batch retry must not mutate financial state.", {
  body: retryBatch.body,
});

const engineStatus = await requestJson(`${gameEngineUrl}/api/game-engine/status`);
assert(engineStatus.response.status === 200 && engineStatus.body?.data?.productionGameLogicEnabled === false, "Production game logic must remain disabled.", {
  body: engineStatus.body,
});
assert(engineStatus.body.data.settlementIntegrationEnabled === false, "Game Engine settlement integration must remain disabled.", {
  body: engineStatus.body,
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

pass("Evaluation orchestrator QA completed.", {
  gameEngineUrl,
  runCount: runs.length,
  plannedBatchCount: planResult.body.evaluationBatches.length,
  productionRabbitMqWiringEnabled: orchestratorStatus.productionRabbitMqWiringEnabled,
  settlementIntegrationEnabled: orchestratorStatus.settlementIntegrationEnabled,
});
