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
run("npm", ["run", "game-engine:evaluation-rabbitmq-test"]);

if (existsSync("services/game-engine")) {
  for (const path of [
    "services/game-engine/src/GameEngine.Application/Services/EvaluationRabbitMqServices.cs",
    "services/game-engine/src/GameEngine.Domain/Model/EvaluationOrchestrationModels.cs",
    "docs/architecture/phase-22-6h-distributed-evaluation-rabbitmq.md",
    "docs/architecture/adr/ADR-015-distributed-evaluation-rabbitmq.md",
  ]) {
    assert(existsSync(path), "Required evaluation RabbitMQ artifact missing.", { path });
  }
}

const runsResult = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-runs`);
assert(runsResult.response.status === 200 && runsResult.body?.success === true, "Evaluation runs endpoint failed.", {
  status: runsResult.response.status,
  body: runsResult.body,
});
const runs = runsResult.body.evaluationRuns;
assert(Array.isArray(runs) && runs.length > 0, "Evaluation runs must be visible.", { runs });
const runId = runs[0].id;

const queuesBefore = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-queues`);
assert(queuesBefore.response.status === 200 && queuesBefore.body?.success === true, "Evaluation queues endpoint failed.", {
  status: queuesBefore.response.status,
  body: queuesBefore.body,
});
assert(Array.isArray(queuesBefore.body.evaluationQueues) && queuesBefore.body.evaluationQueues.length >= 7, "Evaluation queue diagnostics are incomplete.", {
  body: queuesBefore.body,
});
assert(queuesBefore.body.externalBrokerMutationPerformed === false, "Queue diagnostics must not mutate the broker.", {
  body: queuesBefore.body,
});

const workers = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-workers`);
assert(workers.response.status === 200 && workers.body?.success === true, "Evaluation workers endpoint failed.", {
  status: workers.response.status,
  body: workers.body,
});
assert(Array.isArray(workers.body.evaluationWorkers) && workers.body.evaluationWorkers.length > 0, "Evaluation workers must expose placeholder heartbeats.", {
  body: workers.body,
});

const heartbeats = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-worker-heartbeats`);
assert(heartbeats.response.status === 200 && heartbeats.body?.success === true, "Evaluation worker heartbeat endpoint failed.", {
  status: heartbeats.response.status,
  body: heartbeats.body,
});
assert(Array.isArray(heartbeats.body.evaluationWorkerHeartbeats) && heartbeats.body.evaluationWorkerHeartbeats.length > 0, "Worker heartbeat evidence must be visible.", {
  body: heartbeats.body,
});

const publish = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-runs/${runId}/publish-batches`, {
  method: "POST",
});
assert(publish.response.status === 202 && publish.body?.success === true, "Publish batches endpoint failed.", {
  status: publish.response.status,
  body: publish.body,
});
assert(publish.body.productionRabbitMqPublishingEnabled === false, "Production RabbitMQ publishing must remain disabled.", {
  body: publish.body,
});
assert(
  publish.body.externalBrokerMutationPerformed === false &&
    publish.body.financialMutationPerformed === false &&
    publish.body.settlementIntegrationTriggered === false,
  "Publish batches endpoint must remain safe and in-memory.",
  { body: publish.body }
);
assert(Array.isArray(publish.body.publishResult.workItems) && publish.body.publishResult.workItems.length > 0, "Publish result must expose work item contracts.", {
  body: publish.body,
});
assert(
  publish.body.publishResult.workItems.every((item) => item.routingKey === "game.evaluation.batch.requested" && item.idempotencyKey),
  "Work item contracts must include routing and idempotency fields.",
  { workItems: publish.body.publishResult.workItems }
);

const requeue = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-batches/${publish.body.publishResult.workItems[0].batchId}/requeue`, {
  method: "POST",
});
assert(requeue.response.status === 202 && requeue.body?.success === true, "Evaluation batch requeue endpoint failed.", {
  status: requeue.response.status,
  body: requeue.body,
});
assert(
  requeue.body.destructiveQueueOperationPerformed === false &&
    requeue.body.financialMutationPerformed === false &&
    requeue.body.settlementIntegrationTriggered === false,
  "Batch requeue must be diagnostic-only.",
  { body: requeue.body }
);

const deadLetter = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-dead-letter`);
assert(deadLetter.response.status === 200 && deadLetter.body?.success === true, "Evaluation dead-letter endpoint failed.", {
  status: deadLetter.response.status,
  body: deadLetter.body,
});
assert(deadLetter.body.destructiveQueueOperationPerformed === false, "Dead-letter diagnostics must not perform destructive queue operations.", {
  body: deadLetter.body,
});

const review = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-dead-letter/${crypto.randomUUID()}/review`, {
  method: "POST",
});
assert(review.response.status === 202 && review.body?.success === true, "Dead-letter review endpoint failed.", {
  status: review.response.status,
  body: review.body,
});
assert(
  review.body.destructiveQueueOperationPerformed === false &&
    review.body.financialMutationPerformed === false &&
    review.body.settlementIntegrationTriggered === false,
  "Dead-letter review must remain diagnostic-only.",
  { body: review.body }
);

const processingStatus = await requestJson(`${gameEngineUrl}/api/game-engine/evaluation-processing-status`);
assert(processingStatus.response.status === 200 && processingStatus.body?.success === true, "Evaluation processing status endpoint failed.", {
  status: processingStatus.response.status,
  body: processingStatus.body,
});
assert(
  processingStatus.body.evaluationProcessingStatus.productionGameLogicEnabled === false &&
    processingStatus.body.evaluationProcessingStatus.ticketDbIntegrationEnabled === false &&
    processingStatus.body.evaluationProcessingStatus.settlementIntegrationEnabled === false,
  "Evaluation processing must not enable production game logic, ticket DB integration, or settlement integration.",
  { body: processingStatus.body }
);

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

pass("Evaluation RabbitMQ QA completed.", {
  gameEngineUrl,
  queueCount: queuesBefore.body.evaluationQueues.length,
  workerHeartbeatCount: heartbeats.body.evaluationWorkerHeartbeats.length,
  publishedWorkItems: publish.body.publishResult.workItems.length,
  productionRabbitMqPublishingEnabled: publish.body.productionRabbitMqPublishingEnabled,
});
