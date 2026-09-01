import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import process from "node:process";

import amqp from "amqplib";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const rabbitUrl = process.env.RABBITMQ_URL ??
  "amqp://lottery:lottery_dev_password@127.0.0.1:5672";
const managementUrl = process.env.RABBITMQ_MANAGEMENT_URL ??
  "http://127.0.0.1:15672";
const campaignId = process.env.PR05J_CAMPAIGN_ID ??
  `pr05j-${new Date().toISOString().replaceAll(/[-:.]/g, "").slice(0, 15)}Z`;
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const checks = [];

function now() {
  return new Date().toISOString();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, name, evidence = {}) {
  checks.push({ name, status: condition ? "PASS" : "FAIL", evidence });
  if (!condition) throw new Error(`${name}: ${JSON.stringify(evidence)}`);
}

function command(name, args, timeout = 120_000) {
  return spawnSync(name, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function requireCommand(name, args, timeout) {
  const result = command(name, args, timeout);
  if (result.status !== 0) {
    throw new Error(
      `${[name, ...args].join(" ")} failed: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}

async function waitFor(name, probe, timeoutMs = 180_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`${name} timed out: ${JSON.stringify(last)}`);
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]
      .toFixed(2)
  );
}

function latencySummary(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.length ? Number(Math.max(...values).toFixed(2)) : null,
  };
}

async function tcpReady() {
  const result = command("docker", [
    "compose", "exec", "-T", "outbox-dispatcher", "node", "-e",
    "const n=require('node:net');const s=n.createConnection({host:'rabbitmq',port:5672});" +
      "const f=c=>{s.destroy();process.exit(c)};s.setTimeout(500);" +
      "s.once('connect',()=>f(0));s.once('timeout',()=>f(1));s.once('error',()=>f(1));",
  ], 2_000);
  return result.status === 0;
}

async function amqpTransportProbe() {
  const connection = await amqp.connect(rabbitUrl, { timeout: 1_000 });
  const handshakeAt = now();
  const channel = await connection.createConfirmChannel();
  try {
    await channel.checkExchange("lottery.events");
    await channel.checkQueue("lottery.settlement.events");
    await channel.checkQueue("lottery.settlement.events.dlq");
    return { handshakeAt, topologyAt: now() };
  } finally {
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

async function settlementQueue() {
  const authorization = Buffer.from("lottery:lottery_dev_password").toString("base64");
  const response = await fetch(
    `${managementUrl}/api/queues/%2F/lottery.settlement.events`,
    { headers: { authorization: `Basic ${authorization}` } }
  );
  if (!response.ok) throw new Error(`RabbitMQ management returned ${response.status}.`);
  return response.json();
}

async function effectCounts() {
  return (await pool.query(`
select
  (select count(*)::int from settlement_service.authoritative_settlement_records) settlements,
  (select count(*)::int from ledger_service.ledger_transactions) ledger_transactions,
  (select count(*)::int from credit_wallet_service.wallet_operation_terminal_results) wallet_results
`)).rows[0];
}

async function createProbeBatch(label, size) {
  const correlationId = `${campaignId}:${label}`;
  const result = await pool.query(`
insert into public.outbox_events(
  event_type,aggregate_type,aggregate_id,payload,status,correlation_id)
select 'settlement.transport.probe','pr05j_transport_probe',
  $1 || ':' || sequence::text,
  jsonb_build_object('campaignId',$2::text,'label',$3::text,'sequence',sequence),
  'PENDING',$1
from generate_series(1,$4::int) sequence
returning id::text
`, [correlationId, campaignId, label, size]);
  assert(result.rowCount === size, `${label} durable probe creation`, {
    expected: size,
    actual: result.rowCount,
  });
  return { correlationId, ids: result.rows.map((row) => row.id) };
}

async function createStaleBackoffProbe(label) {
  const correlationId = `${campaignId}:${label}`;
  const row = (await pool.query(`
insert into public.outbox_events(
  event_type,aggregate_type,aggregate_id,payload,status,correlation_id,
  attempt_count,next_attempt_at,last_error)
values (
  'settlement.transport.probe','pr05j_transport_probe',$1,
  jsonb_build_object('campaignId',$2::text,'label',$3::text,'sequence',1),
  'FAILED',$1,5,now() + interval '30 seconds','PR05J_STALE_BROKER_BACKOFF')
returning id::text,next_attempt_at
`, [correlationId, campaignId, label])).rows[0];
  return { correlationId, id: row.id, originalNextAttemptAt: row.next_attempt_at };
}

async function batchState(correlationId) {
  return (await pool.query(`
select
  count(*)::int total,
  count(*) filter(where outbox.status='PUBLISHED')::int published,
  count(*) filter(where outbox.status='FAILED')::int failed,
  count(handler.event_id)::int consumed,
  count(*) filter(where handler.handling_status='NO_OP')::int no_op,
  min(outbox.published_at) first_published_at,
  max(outbox.published_at) last_published_at,
  max(outbox.attempt_count)::int max_attempt_count
from public.outbox_events outbox
left join public.financial_worker_event_handlers handler
  on handler.event_id=outbox.id::text
where outbox.correlation_id=$1
`, [correlationId])).rows[0];
}

async function waitForBatch(correlationId, size, timeoutMs = 180_000) {
  return waitFor(`${correlationId} publication and consumption`, async () => {
    const state = await batchState(correlationId);
    return Number(state.published) === size && Number(state.consumed) === size &&
      Number(state.no_op) === size ? state : null;
  }, timeoutMs, 100);
}

async function batchPublicationLatencies(correlationId, origin) {
  const rows = (await pool.query(`
select extract(epoch from (published_at-$2::timestamptz))*1000 latency_ms
from public.outbox_events
where correlation_id=$1 and published_at is not null
order by published_at,id
`, [correlationId, origin])).rows;
  return rows.map((row) => Number(row.latency_ms));
}

function containerId() {
  return requireCommand("docker", ["compose", "ps", "-q", "rabbitmq"]);
}

function containerStartedAt(id) {
  return requireCommand("docker", ["inspect", "--format", "{{.State.StartedAt}}", id]);
}

function rabbitLogsSince(since) {
  return requireCommand(
    "docker",
    ["compose", "logs", "--no-color", "--timestamps", "--since", since, "rabbitmq"],
    120_000,
  );
}

function firstLogTimestamp(logs, pattern) {
  const line = logs.split("\n").find((entry) => pattern.test(entry));
  return line?.match(/\|\s+(\d{4}-\d{2}-\d{2}T[^\s]+)/)?.[1] ??
    line?.match(/(\d{4}-\d{2}-\d{2}T[^\s]+)/)?.[1] ?? null;
}

async function normalAvailableProbe() {
  await amqpTransportProbe();
  const batch = await createProbeBatch("normal-available", 1);
  const state = await waitForBatch(batch.correlationId, 1, 30_000);
  assert(Number(state.max_attempt_count) === 0, "normal broker publication needs no retry", state);
  return state;
}

async function shortApplicationInterruption() {
  requireCommand("docker", ["compose", "exec", "-T", "rabbitmq", "rabbitmqctl", "stop_app"]);
  await waitFor("AMQP listener stops", async () => !(await tcpReady()), 30_000);
  const batch = await createProbeBatch("short-interruption", 20);
  const brokerBackoff = await waitFor("bounded broker retry evidence", async () => {
    const row = (await pool.query(`
select status,metadata,last_seen_at
from public.worker_heartbeats
where worker_name='outbox_dispatcher'
order by last_seen_at desc
limit 1
`)).rows[0];
    return Number(row?.metadata?.consecutiveFailures ?? 0) >= 2 ? row : null;
  }, 30_000, 100);
  const staleBackoff = await createStaleBackoffProbe("short-interruption-stale-backoff");
  const beforeRecovery = await batchState(batch.correlationId);
  const restartInitiatedAt = now();
  requireCommand("docker", ["compose", "exec", "-T", "rabbitmq", "rabbitmqctl", "start_app"]);
  const transport = await waitFor("short interruption AMQP recovery", amqpTransportProbe, 90_000);
  const state = await waitForBatch(batch.correlationId, 20, 60_000);
  const staleState = await waitForBatch(staleBackoff.correlationId, 1, 60_000);
  const publisherConfirmedReadyAt = new Date(state.first_published_at) <
    new Date(transport.topologyAt)
    ? state.first_published_at
    : transport.topologyAt;
  const latencies = await batchPublicationLatencies(
    batch.correlationId,
    publisherConfirmedReadyAt,
  );
  const firstResumeMs = Math.min(...latencies);
  assert(firstResumeMs < 2_000, "short interruption publication resumes promptly", {
    firstResumeMs,
    transport,
    state,
  });
  assert(Number(beforeRecovery.published) === 0 &&
    Number(beforeRecovery.max_attempt_count) <= 1,
  "broker circuit breaker preserves rows without retry churn", {
    brokerBackoff,
    beforeRecovery,
  });
  assert(Number(staleState.max_attempt_count) === 5,
    "broker recovery wakes stale per-row backoff without another failed attempt", {
      originalNextAttemptAt: staleBackoff.originalNextAttemptAt,
      recoveredAt: staleState.first_published_at,
      staleState,
    });
  assert(new Date(staleState.first_published_at) < new Date(staleBackoff.originalNextAttemptAt),
    "stale retry timer does not delay recovered publication", {
      originalNextAttemptAt: staleBackoff.originalNextAttemptAt,
      recoveredAt: staleState.first_published_at,
    });
  return {
    restartInitiatedAt,
    transport,
    publisherConfirmedReadyAt,
    externalProbeObservationLagMs: Math.max(
      0,
      new Date(transport.topologyAt) - new Date(publisherConfirmedReadyAt),
    ),
    firstResumeMs,
    publication: latencySummary(latencies),
    state,
    staleBackoff: {
      eventId: staleBackoff.id,
      originalNextAttemptAt: staleBackoff.originalNextAttemptAt,
      recoveredAt: staleState.first_published_at,
      attemptCount: Number(staleState.max_attempt_count),
    },
  };
}

async function fullRestartForensics() {
  const id = containerId();
  const oldStartedAt = containerStartedAt(id);
  const restartInitiatedAt = now();
  const child = spawn("docker", ["compose", "restart", "rabbitmq"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childExit = once(child, "close");
  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += chunk; });
  child.stderr.on("data", (chunk) => { childOutput += chunk; });

  await waitFor("RabbitMQ listener interruption", async () => !(await tcpReady()), 30_000, 50);
  const tcpUnavailableAt = now();
  const batches = [];
  for (const size of [100, 500, 2_000]) {
    batches.push({ size, ...await createProbeBatch(`restart-${size}`, size) });
  }

  const containerRunningAt = await waitFor("RabbitMQ container restart", async () => {
    const startedAt = containerStartedAt(id);
    return startedAt !== oldStartedAt ? now() : null;
  }, 60_000, 100);

  const tcpAcceptAt = await waitFor("RabbitMQ TCP 5672", async () =>
    await tcpReady() ? now() : null, 120_000, 50);
  const transport = await waitFor("RabbitMQ AMQP/topology", amqpTransportProbe, 30_000, 50);
  const queue = await waitFor("Settlement consumer reconnect", async () => {
    const current = await settlementQueue();
    return Number(current.consumers ?? 0) > 0 ? current : null;
  }, 30_000, 100);
  const settlementConsumerAt = now();
  const [exitCode] = await childExit;
  assert(exitCode === 0, "controlled RabbitMQ restart command", { exitCode, childOutput });

  const batchResults = [];
  const combinedLatencies = [];
  for (const batch of batches) {
    const state = await waitForBatch(batch.correlationId, batch.size, 180_000);
    const latencies = await batchPublicationLatencies(
      batch.correlationId,
      transport.topologyAt,
    );
    combinedLatencies.push(...latencies);
    batchResults.push({ size: batch.size, state, publication: latencySummary(latencies) });
  }
  const drainedAt = await waitFor("Settlement queue drain", async () => {
    const current = await settlementQueue();
    return Number(current.messages_ready ?? 0) === 0 &&
      Number(current.messages_unacknowledged ?? 0) === 0 ? now() : null;
  });

  const logs = rabbitLogsSince(restartInitiatedAt);
  const timeline = {
    restartInitiatedAt,
    shutdownSignalAt: firstLogTimestamp(logs, /SIGTERM received/),
    tcpUnavailableAt,
    containerRunningAt,
    erlangVmAvailableAt: firstLogTimestamp(logs, /Logging: configured log handlers are now ACTIVE/),
    rabbitApplicationStartedAt: firstLogTimestamp(logs, /Starting RabbitMQ [0-9]/),
    rabbitNodeReportsRunningAt: firstLogTimestamp(logs, /Server startup complete/),
    listenersInitializedAt: firstLogTimestamp(logs, /Ready to start client connection listeners/),
    tcpAcceptAt,
    amqpHandshakeAt: transport.handshakeAt,
    settlementTopologyUsableAt: transport.topologyAt,
    settlementConsumerAt,
    drainedAt,
  };
  const firstResumeMs = Math.min(...combinedLatencies);
  const sorted = [...combinedLatencies].sort((left, right) => left - right);
  const recovery = {
    firstPublicationMs: firstResumeMs,
    fiftyPercentRepublishedMs: percentile(sorted, 0.5),
    ninetyFivePercentRepublishedMs: percentile(sorted, 0.95),
    oneHundredPercentRepublishedMs: Math.max(...sorted),
    publication: latencySummary(sorted),
  };
  assert(firstResumeMs < 2_000, "full restart publication resumes promptly", {
    timeline,
    recovery,
  });
  assert(batchResults.every((result) => Number(result.state.max_attempt_count) <= 2),
    "full restart keeps row retry churn bounded", { batchResults });
  assert(Number(queue.consumers ?? 0) > 0, "Settlement consumer reconnects", {
    consumers: Number(queue.consumers ?? 0),
  });
  return { timeline, recovery, batchResults, logs };
}

async function main() {
  const beforeEffects = await effectCounts();
  const initialQueue = await settlementQueue();
  assert(Number(initialQueue.messages_ready ?? 0) === 0 &&
    Number(initialQueue.messages_unacknowledged ?? 0) === 0,
  "Settlement queue starts drained", initialQueue);

  const normal = await normalAvailableProbe();
  const shortInterruption = await shortApplicationInterruption();
  const fullRestart = await fullRestartForensics();
  const afterEffects = await effectCounts();
  assert(JSON.stringify(afterEffects) === JSON.stringify(beforeEffects),
    "transport probes create no financial effects", { beforeEffects, afterEffects });

  console.log(JSON.stringify({
    status: "PR05J_RABBITMQ_RECOVERY_PASS",
    campaignId,
    normal,
    shortInterruption,
    fullRestart: {
      timeline: fullRestart.timeline,
      recovery: fullRestart.recovery,
      batchResults: fullRestart.batchResults,
    },
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
