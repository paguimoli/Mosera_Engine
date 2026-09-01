import { spawnSync } from "node:child_process";
import process from "node:process";
import amqp from "amqplib";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const rabbitUrl = process.env.RABBITMQ_URL ??
  "amqp://lottery:lottery_dev_password@127.0.0.1:5672";
const rabbitManagementUrl = process.env.RABBITMQ_MANAGEMENT_URL ??
  "http://127.0.0.1:15672";
const campaignId = process.env.PR05I_CAMPAIGN_ID ??
  `pr05i-transport-${new Date().toISOString().replaceAll(/[-:.]/g, "").slice(0, 15)}Z`;
const tierSizes = (process.env.PR05I_TRANSPORT_TIERS ?? "1,20,100,500,2000")
  .split(",")
  .map((value) => Number(value));
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const checks = [];
const tierResults = [];
let readyHighWater = 0;
let unackedHighWater = 0;

function assert(condition, name, evidence = {}) {
  checks.push({ name, status: condition ? "PASS" : "FAIL", evidence });
  if (!condition) throw new Error(`${name}: ${JSON.stringify(evidence)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)].toFixed(2));
}

function summary(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.length ? Number(Math.max(...values).toFixed(2)) : null,
  };
}

async function rabbitQueue() {
  const authorization = Buffer.from("lottery:lottery_dev_password").toString("base64");
  const response = await fetch(
    `${rabbitManagementUrl}/api/queues/%2F/lottery.settlement.events`,
    { headers: { authorization: `Basic ${authorization}` } }
  );
  if (!response.ok) throw new Error(`RabbitMQ management returned HTTP ${response.status}.`);
  const queue = await response.json();
  readyHighWater = Math.max(readyHighWater, Number(queue.messages_ready ?? 0));
  unackedHighWater = Math.max(unackedHighWater, Number(queue.messages_unacknowledged ?? 0));
  return queue;
}

async function rabbitSettlementTransportReady() {
  const connection = await amqp.connect(rabbitUrl, { timeout: 2_000 });
  const channel = await connection.createConfirmChannel();
  try {
    await channel.checkExchange("lottery.events");
    await channel.checkQueue("lottery.settlement.events");
    await channel.checkQueue("lottery.settlement.events.dlq");
    return true;
  } finally {
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

async function waitFor(name, probe, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      await rabbitQueue().catch(() => undefined);
      if (last) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(`${name} timed out: ${JSON.stringify(last)}`);
}

async function effectCounts() {
  return (await pool.query(`
select
  (select count(*)::int from settlement_service.authoritative_settlement_records) settlements,
  (select count(*)::int from ledger_service.ledger_transactions) ledger_transactions,
  (select count(*)::int from credit_wallet_service.wallet_operation_terminal_results) wallet_results
`)).rows[0];
}

async function postgresRuntime() {
  const rows = (await pool.query(`
select
  count(*)::int total_connections,
  count(*) filter (where state = 'active')::int active_connections,
  count(*) filter (where wait_event_type = 'Lock')::int lock_waiters,
  count(*) filter (where application_name like 'worker-settlement%')::int settlement_worker_connections,
  count(*) filter (where application_name = 'settlement-service')::int settlement_service_connections
from pg_stat_activity
where datname = current_database()
`)).rows[0];
  return Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, Number(value)]));
}

async function createTier(size) {
  const correlationId = `${campaignId}:tier:${size}`;
  const tierStartedAt = performance.now();
  let tierReadyHighWater = 0;
  let tierUnackedHighWater = 0;
  let idleSamplesWhileReady = 0;
  let peakConnections = 0;
  let peakActiveConnections = 0;
  let peakLockWaiters = 0;
  let peakSettlementWorkerConnections = 0;
  let peakSettlementServiceConnections = 0;
  const inserted = await pool.query(`
insert into public.outbox_events (
  event_type, aggregate_type, aggregate_id, payload, status, correlation_id)
select 'settlement.transport.probe', 'pr05i_transport_probe',
  $1 || ':' || sequence::text,
  jsonb_build_object('campaignId', $2::text, 'tierSize', $3, 'sequence', sequence),
  'PENDING', $1
from generate_series(1, $3::int) sequence
returning id::text,created_at
`, [correlationId, campaignId, size]);
  const insertedAt = performance.now();
  assert(inserted.rowCount === size, `tier ${size} durable outbox creation`, {
    expected: size,
    actual: inserted.rowCount,
  });

  await waitFor(`tier ${size} publication and consumption`, async () => {
    const [queue, postgres] = await Promise.all([rabbitQueue(), postgresRuntime()]);
    tierReadyHighWater = Math.max(tierReadyHighWater, Number(queue.messages_ready ?? 0));
    tierUnackedHighWater = Math.max(tierUnackedHighWater, Number(queue.messages_unacknowledged ?? 0));
    if (Number(queue.messages_ready ?? 0) > 0 && Number(queue.messages_unacknowledged ?? 0) === 0) {
      idleSamplesWhileReady += 1;
    }
    peakConnections = Math.max(peakConnections, postgres.total_connections);
    peakActiveConnections = Math.max(peakActiveConnections, postgres.active_connections);
    peakLockWaiters = Math.max(peakLockWaiters, postgres.lock_waiters);
    peakSettlementWorkerConnections = Math.max(
      peakSettlementWorkerConnections,
      postgres.settlement_worker_connections,
    );
    peakSettlementServiceConnections = Math.max(
      peakSettlementServiceConnections,
      postgres.settlement_service_connections,
    );
    const row = (await pool.query(`
select
  count(*) filter(where outbox.status='PUBLISHED')::int published,
  count(handler.event_id)::int consumed,
  count(*) filter(where handler.handling_status='NO_OP')::int no_op
from public.outbox_events outbox
left join public.financial_worker_event_handlers handler on handler.event_id=outbox.id::text
where outbox.correlation_id=$1
`, [correlationId])).rows[0];
    return Number(row.published) === size && Number(row.consumed) === size &&
      Number(row.no_op) === size ? row : null;
  });

  const timings = (await pool.query(`
select
  extract(epoch from (outbox.published_at-outbox.created_at))*1000 ready_to_published_ms,
  extract(epoch from (handler.first_seen_at-outbox.published_at))*1000 published_to_consumer_claim_ms,
  extract(epoch from (handler.handled_at-handler.first_seen_at))*1000 consumer_processing_ms
from public.outbox_events outbox
join public.financial_worker_event_handlers handler on handler.event_id=outbox.id::text
where outbox.correlation_id=$1
order by outbox.created_at,outbox.id
`, [correlationId])).rows;
  const completedAt = performance.now();
  const arrivalDurationMs = Math.max(insertedAt - tierStartedAt, 0.01);
  const drainDurationMs = Math.max(completedAt - insertedAt, 0.01);
  const result = {
    size,
    arrivalRatePerSecond: Number((size * 1_000 / arrivalDurationMs).toFixed(3)),
    drainRatePerSecond: Number((size * 1_000 / drainDurationMs).toFixed(3)),
    arrivalDurationMs: Number(arrivalDurationMs.toFixed(2)),
    drainDurationMs: Number(drainDurationMs.toFixed(2)),
    queue: {
      readyHighWater: tierReadyHighWater,
      unackedHighWater: tierUnackedHighWater,
      idleSamplesWhileReady,
    },
    postgres: {
      peakConnections,
      peakActiveConnections,
      peakLockWaiters,
      peakSettlementWorkerConnections,
      peakSettlementServiceConnections,
    },
    outboxReadyToPublished: summary(timings.map((row) => Number(row.ready_to_published_ms))),
    publishedToConsumerClaim: summary(timings.map((row) => Number(row.published_to_consumer_claim_ms))),
    consumerProcessing: summary(timings.map((row) => Number(row.consumer_processing_ms))),
  };
  tierResults.push(result);
  console.log(`[pr05i] tier ${size} PASS ${JSON.stringify(result)}`);
  return { correlationId, eventId: inserted.rows[0].id };
}

async function publishDuplicate(eventId) {
  const row = (await pool.query(`
select id::text,event_type,aggregate_type,aggregate_id,payload,correlation_id,created_at
from public.outbox_events where id=$1::uuid
`, [eventId])).rows[0];
  const connection = await amqp.connect(rabbitUrl);
  const channel = await connection.createConfirmChannel();
  try {
    await channel.assertExchange("lottery.events", "topic", { durable: true });
    channel.publish(
      "lottery.events",
      row.event_type,
      Buffer.from(JSON.stringify({
        id: row.id,
        type: row.event_type,
        contractVersion: "1.0.0",
        payload: row.payload,
        idempotencyKey: row.id,
        correlationId: row.correlation_id,
        causationId: null,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        occurredAt: row.created_at.toISOString(),
      })),
      { persistent: true, messageId: row.id, type: row.event_type }
    );
    await channel.waitForConfirms();
  } finally {
    await channel.close();
    await connection.close();
  }
  await sleep(500);
  const count = Number((await pool.query(
    "select count(*)::int from public.financial_worker_event_handlers where event_id=$1",
    [eventId]
  )).rows[0].count);
  assert(count === 1, "duplicate delivery is idempotent", { eventId, handlerRows: count });
}

function dockerCompose(...args) {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

async function restartWorkerAndVerify() {
  dockerCompose("restart", "worker-settlement");
  await waitFor("settlement worker restart", async () => {
    const result = spawnSync("docker", ["compose", "ps", "--status", "running", "--services"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    return result.status === 0 && result.stdout.split("\n").includes("worker-settlement");
  });
  await sleep(1_000);
}

async function verifyBrokerRetryRecovery() {
  const correlationId = `${campaignId}:broker-retry`;
  dockerCompose("stop", "rabbitmq");
  let inserted;
  let outageEvidence;
  let preserved;
  try {
    inserted = (await pool.query(`
insert into public.outbox_events (
  event_type,aggregate_type,aggregate_id,payload,status,correlation_id)
values ('settlement.transport.probe','pr05i_transport_probe',$1,
  jsonb_build_object('campaignId',$2::text,'scenario','broker-retry'),
  'PENDING',$3)
returning id::text
`, [correlationId, campaignId, correlationId])).rows[0];
    outageEvidence = await waitFor("broker outage retry evidence", async () => {
      const row = (await pool.query(`
select status,metadata,last_seen_at
from public.worker_heartbeats
where worker_name='outbox_dispatcher'
order by last_seen_at desc
limit 1
`)).rows[0];
      return Number(row?.metadata?.consecutiveFailures ?? 0) >= 2 ? row : null;
    }, 30_000);
    preserved = (await pool.query(`
select status,attempt_count,next_attempt_at,created_at
from public.outbox_events where id=$1::uuid
`, [inserted.id])).rows[0];
    assert(preserved.status !== "PUBLISHED" && Number(preserved.attempt_count) <= 1,
      "broker circuit breaker preserves outbox row without retry churn", preserved);
  } finally {
    dockerCompose("start", "rabbitmq");
  }
  await waitFor(
    "RabbitMQ Settlement AMQP/topology recovery",
    rabbitSettlementTransportReady,
    90_000,
  );
  await waitFor("broker retry publication and consumption", async () => {
    const row = (await pool.query(`
select outbox.status,outbox.attempt_count,handler.handling_status
from public.outbox_events outbox
left join public.financial_worker_event_handlers handler on handler.event_id=outbox.id::text
where outbox.id=$1::uuid
`, [inserted.id])).rows[0];
    return row.status === "PUBLISHED" && row.handling_status === "NO_OP" ? row : null;
  }, 60_000);
  assert(true, "bounded broker retry and automatic recovery", {
    eventId: inserted.id,
    outageConsecutiveFailures: Number(outageEvidence.metadata.consecutiveFailures),
    brokerRetryAfterMs: Number(outageEvidence.metadata.retryAfterMs),
    preservedAttemptCount: Number(preserved.attempt_count),
  });
}

async function main() {
  assert(tierSizes.every((size) => Number.isInteger(size) && size > 0 && size <= 2_500),
    "focused tier configuration is bounded", { tierSizes });
  const beforeEffects = await effectCounts();
  const initialQueue = await rabbitQueue();
  assert(Number(initialQueue.messages_ready ?? 0) === 0 &&
    Number(initialQueue.messages_unacknowledged ?? 0) === 0,
    "settlement queue starts drained", {
      ready: Number(initialQueue.messages_ready ?? 0),
      unacked: Number(initialQueue.messages_unacknowledged ?? 0),
      consumers: Number(initialQueue.consumers ?? 0),
      prefetch: Number(initialQueue.consumer_details?.[0]?.prefetch_count ?? 0),
    });

  let duplicateCandidate;
  for (const size of tierSizes) {
    if (size === 2_000 && process.env.PR05I_SKIP_WORKER_RESTART !== "true") {
      await restartWorkerAndVerify();
    }
    const tier = await createTier(size);
    duplicateCandidate ??= tier.eventId;
  }
  await publishDuplicate(duplicateCandidate);
  if (process.env.PR05I_SKIP_BROKER_RETRY !== "true") {
    await verifyBrokerRetryRecovery();
  }

  const finalQueue = await waitFor("settlement queue drain", async () => {
    const queue = await rabbitQueue();
    return Number(queue.messages_ready ?? 0) === 0 &&
      Number(queue.messages_unacknowledged ?? 0) === 0 ? queue : null;
  });
  const afterEffects = await effectCounts();
  assert(JSON.stringify(afterEffects) === JSON.stringify(beforeEffects),
    "transport probes create no financial effects", { beforeEffects, afterEffects });
  assert(Number(finalQueue.messages_ready ?? 0) === 0 &&
    Number(finalQueue.messages_unacknowledged ?? 0) === 0,
    "settlement queue drains to zero", {
      ready: Number(finalQueue.messages_ready ?? 0),
      unacked: Number(finalQueue.messages_unacknowledged ?? 0),
      consumers: Number(finalQueue.consumers ?? 0),
    });

  console.log(JSON.stringify({
    status: "PR05I_SETTLEMENT_TRANSPORT_PASS",
    campaignId,
    tierResults,
    rabbitMq: { readyHighWater, unackedHighWater, finalReady: 0, finalUnacked: 0 },
    effects: { before: beforeEffects, after: afterEffects },
    checks,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
