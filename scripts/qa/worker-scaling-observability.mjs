import "./load-session-env.mjs";
import { randomUUID } from "node:crypto";

import * as amqp from "amqplib";
import pg from "pg";

const { Pool } = pg;

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.QA_ADMIN_SESSION_TOKEN || process.env.OPS_ADMIN_SESSION_TOKEN;
const privilegedApiChecksEnabled =
  process.env.QA_WORKER_OBSERVABILITY_ADMIN_CHECKS === "true";
const correlationId = `qa-worker-observability-${Date.now()}`;
const assertions = [];
const databaseUrl = process.env.DATABASE_URL;
const rabbitUrl = process.env.RABBITMQ_URL || "amqp://lottery:lottery_dev_password@127.0.0.1:5672";

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

async function waitForProbeMetric(pool, eventType) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await pool.query(
      "select count(*)::int as count from public.worker_processing_metrics where event_type = $1",
      [eventType]
    );
    if (Number(result.rows[0]?.count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail("Worker processing metric probe was not persisted.", { eventType });
}

async function assertCanonicalWorkerPersistence() {
  if (!databaseUrl) fail("DATABASE_URL is required for canonical worker observability QA.");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let connection;
  let channel;
  try {
    const heartbeats = await pool.query(
      "select worker_name, workload_category, status, last_seen_at from public.worker_heartbeats order by last_seen_at desc"
    );
    if (heartbeats.rowCount === 0) fail("Worker heartbeat was not persisted in PostgreSQL.");
    pass("Worker heartbeats persist through canonical PostgreSQL.");

    const eventId = randomUUID();
    const eventType = `report.worker_observability_probe.${eventId}`;
    connection = await amqp.connect(rabbitUrl);
    channel = await connection.createConfirmChannel();
    await channel.assertExchange("lottery.events", "topic", { durable: true });
    channel.publish(
      "lottery.events",
      `reporting.${eventType}`,
      Buffer.from(JSON.stringify({
        id: eventId,
        type: eventType,
        contractVersion: "1.0.0",
        payload: { qa: "worker-observability" },
        idempotencyKey: eventId,
        correlationId,
        causationId: null,
        aggregateType: "worker-observability-qa",
        aggregateId: eventId,
        occurredAt: new Date().toISOString(),
      })),
      { persistent: true, contentType: "application/json", messageId: eventId }
    );
    await channel.waitForConfirms();
    await waitForProbeMetric(pool, eventType);
    pass("Worker processing metrics persist after broker-confirmed processing.");

    const failures = await pool.query(
      "select count(*)::int as count from public.worker_failures"
    );
    if (!Number.isInteger(Number(failures.rows[0]?.count))) {
      fail("Worker structured failure evidence was not queryable.");
    }
    pass("Worker structured failure evidence is queryable.");
  } finally {
    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
    await pool.end();
  }
}

async function main() {
  await assertAuthRequired();
  await assertCanonicalWorkerPersistence();

  if (!privilegedApiChecksEnabled) {
    pass("Privileged dashboard API checks remain credential-gated; canonical persistence was verified directly.");
    console.log(`correlationId: ${correlationId}`);
    console.log(`assertionsPassed: ${assertions.length}`);
    return;
  }

  if (!sessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN is required when privileged dashboard API checks are enabled.");
  }

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
