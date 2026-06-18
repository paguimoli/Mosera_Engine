const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.QA_ADMIN_SESSION_TOKEN || process.env.OPS_ADMIN_SESSION_TOKEN;
const correlationId = `qa-worker-observability-${Date.now()}`;
const assertions = [];

function fail(message, metadata = {}) {
  console.error("QA assertion failed.");
  console.error(`correlationId: ${correlationId}`);
  console.error(`reason: ${message}`);

  for (const [key, value] of Object.entries(metadata)) {
    console.error(`${key}: ${value}`);
  }

  process.exit(1);
}

function pass(message) {
  assertions.push(message);
  console.log(`PASS: ${message}`);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
      ...(options.headers ?? {}),
      "x-correlation-id": correlationId,
    },
  });
  const payload = await response.json().catch(() => ({}));

  return { response, payload };
}

async function assertAuthRequired() {
  const response = await fetch(`${appUrl}/api/operations/metrics`);

  if (response.ok) {
    fail("Metrics API allowed unauthenticated access.");
  }

  pass("Metrics APIs require authentication.");
}

async function assertAdminEndpoint(path, payloadKey) {
  const { response, payload } = await requestJson(path);

  if (!response.ok || !payload.success) {
    fail(`${path} failed with admin token.`, {
      status: response.status,
      error: payload.error ?? "unknown",
    });
  }

  if (!payload[payloadKey]) {
    fail(`${path} did not return ${payloadKey}.`);
  }

  pass(`${path} returned operational data.`);
  return payload[payloadKey];
}

async function triggerWorkerObservation() {
  const { response, payload } = await requestJson("/api/workers/outbox-dispatch", {
    method: "POST",
    body: JSON.stringify({ limit: 1 }),
  });

  if (!response.ok || !payload.success) {
    fail("Unable to trigger outbox dispatcher for worker observation.", {
      status: response.status,
      error: payload.error ?? "unknown",
    });
  }

  pass("Outbox dispatcher executed for worker observation.");
}

async function main() {
  if (!sessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN or OPS_ADMIN_SESSION_TOKEN is required.");
  }

  await assertAuthRequired();
  await triggerWorkerObservation();

  const metrics = await assertAdminEndpoint("/api/operations/metrics", "metrics");
  const workers = await assertAdminEndpoint("/api/operations/workers", "workers");
  const outbox = await assertAdminEndpoint("/api/operations/outbox", "outbox");
  const queues = await assertAdminEndpoint("/api/operations/queues", "queues");

  if (!Array.isArray(metrics.queues) || metrics.queues.length === 0) {
    fail("Metrics summary did not include queue data.");
  }

  if (!metrics.lag?.severity || !Array.isArray(metrics.lag.reasons)) {
    fail("Metrics summary did not include lag status.");
  }

  if (metrics.bestEffortMetrics !== true) {
    fail("Metrics summary did not declare best-effort metrics behavior.");
  }

  pass("Metrics summary includes lag and best-effort status.");

  const expectedCategories = [
    "CRITICAL_FINANCIAL",
    "TICKET_LIFECYCLE",
    "SETTLEMENT",
    "ACCOUNTING",
    "COMMISSION",
    "RECONCILIATION",
    "OPERATIONAL_ACCESS",
    "REPORTING_LOW_PRIORITY",
  ];
  const categories = new Set(
    queues.rabbitmq.map((queue) => queue.category)
  );

  for (const category of expectedCategories) {
    if (!categories.has(category)) {
      fail("Queue category missing from observability.", { category });
    }
  }

  pass("Queue observability includes all workload categories.");

  if (typeof outbox.pendingCount !== "number") {
    fail("Outbox metrics missing pending count.");
  }

  if (!Array.isArray(outbox.workloadDistribution)) {
    fail("Outbox metrics missing workload distribution.");
  }

  pass("Outbox metrics include pending count and workload distribution.");

  if (!Array.isArray(workers.heartbeats) || workers.heartbeats.length === 0) {
    fail("Worker heartbeat was not observed.");
  }

  pass("Worker heartbeat or derived worker observation exists.");

  console.log(`correlationId: ${correlationId}`);
  console.log(`assertionsPassed: ${assertions.length}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Worker observability QA failed.");
});
