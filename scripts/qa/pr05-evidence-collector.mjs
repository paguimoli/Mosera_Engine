import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const evidenceRoot = process.env.PR05_EVIDENCE_DIR;
const controlPath = process.env.PR05_COLLECTOR_CONTROL;
const campaignId = process.env.PR05_CAMPAIGN_ID;
const databaseUrl = process.env.DATABASE_URL;
const intervalMs = Number(process.env.PR05_COLLECTOR_INTERVAL_MS ?? 5_000);

if (!evidenceRoot || !controlPath || !campaignId || !databaseUrl || !Number.isFinite(intervalMs)) {
  throw new Error("PR-05 evidence collector configuration is incomplete.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: "pr05-independent-evidence-collector",
  max: 2,
  idleTimeoutMillis: 30_000,
});
const collectorExecutionId = randomUUID();
const startedMonotonic = performance.now();
let sequence = 0;
let collecting = false;
let stopping = false;
let timer;
let cachedDockerStats = [];
let dockerStatsInFlight = false;

function control() {
  try {
    return JSON.parse(readFileSync(controlPath, "utf8"));
  } catch (error) {
    return { tier: "UNAVAILABLE", controlError: error instanceof Error ? error.message : String(error) };
  }
}

function refreshDockerStats() {
  if (dockerStatsInFlight) return;
  dockerStatsInFlight = true;
  execFile(
    "docker",
    ["stats", "--no-stream", "--format", "{{json .}}"],
    { encoding: "utf8", timeout: 10_000 },
    (error, stdout) => {
      cachedDockerStats = error
        ? { error: error.message }
        : stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      dockerStatsInFlight = false;
    }
  );
}

async function rabbitQueues() {
  try {
    const response = await fetch("http://127.0.0.1:15672/api/queues", {
      headers: { authorization: `Basic ${Buffer.from("lottery:lottery_dev_password").toString("base64")}` },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return { status: response.status };
    return (await response.json()).map((queue) => ({
      name: queue.name,
      messages: queue.messages,
      ready: queue.messages_ready,
      unacknowledged: queue.messages_unacknowledged,
      consumers: queue.consumers,
      publishRate: queue.message_stats?.publish_details?.rate ?? 0,
      deliverRate: queue.message_stats?.deliver_get_details?.rate ?? 0,
      acknowledgeRate: queue.message_stats?.ack_details?.rate ?? 0,
    }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function postgresMetrics() {
  try {
    const [connections, database, byApplication, waits] = await Promise.all([
      pool.query(`
select count(*)::int total,
  count(*) filter(where state='active')::int active,
  count(*) filter(where wait_event_type='Lock')::int lock_waiters
from pg_stat_activity where datname=current_database()`),
      pool.query(`select deadlocks::bigint deadlocks,
        xact_commit::bigint commits,xact_rollback::bigint rollbacks
        from pg_stat_database where datname=current_database()`),
      pool.query(`
select coalesce(application_name, '') application_name,
  count(*)::int total,
  count(*) filter(where state='active')::int active,
  count(*) filter(where wait_event_type='Lock')::int lock_waiters
from pg_stat_activity
where datname=current_database()
group by application_name
order by application_name`),
      pool.query(`
select coalesce(wait_event_type, 'CPU') wait_event_type,
  coalesce(wait_event, 'RUNNING') wait_event,
  count(*)::int sessions
from pg_stat_activity
where datname=current_database() and state='active'
group by wait_event_type, wait_event
order by sessions desc, wait_event_type, wait_event`),
    ]);
    return {
      ...connections.rows[0],
      ...database.rows[0],
      byApplication: byApplication.rows,
      waits: waits.rows,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function collect(final = false) {
  if (collecting) return;
  collecting = true;
  const observedAt = new Date().toISOString();
  try {
    const [postgres, rabbit] = await Promise.all([postgresMetrics(), rabbitQueues()]);
    if (sequence === 0 || sequence % 5 === 0 || final) {
      refreshDockerStats();
    }
    const record = {
      schemaVersion: "mosera.pr05d.independent-heartbeat.v1",
      campaignId,
      collectorExecutionId,
      collectorPid: process.pid,
      sequence: ++sequence,
      observedAt,
      monotonicElapsedMs: Number((performance.now() - startedMonotonic).toFixed(3)),
      intervalMs,
      final,
      control: control(),
      postgres,
      rabbit,
      docker: cachedDockerStats,
      host: { freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(), loadAverage: loadavg() },
    };
    appendFileSync(`${evidenceRoot}/independent-metrics.jsonl`, `${JSON.stringify(record)}\n`);
  } finally {
    collecting = false;
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await collect(true).catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
await collect();
timer = setInterval(() => void collect(), intervalMs);
