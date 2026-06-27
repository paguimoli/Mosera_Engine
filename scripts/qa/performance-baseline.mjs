import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.QA_ADMIN_SESSION_TOKEN || process.env.OPS_ADMIN_SESSION_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function authHeaders(extra = {}) {
  if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN or OPS_ADMIN_SESSION_TOKEN is required.");

  return {
    authorization: `Bearer ${sessionToken}`,
    ...extra,
  };
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

async function assertProtected(path) {
  const result = await requestJson(path);

  assert(result.response.status === 401, `${path} should require auth.`, {
    status: result.response.status,
    body: result.body,
  });
}

async function authGet(path) {
  const result = await requestJson(path, { headers: authHeaders() });

  assert(result.response.status === 200 && result.body.success, `${path} failed.`, {
    status: result.response.status,
    body: result.body,
  });

  return result.body;
}

function createQaSupabaseClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    fail("SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket,
    },
  });
}

async function countRows(supabase, table) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true });

  if (error) fail(`Unable to count ${table}.`, { error: error.message });

  return count ?? 0;
}

async function countRowsByStatus(supabase, table, status) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("status", status);

  if (error) fail(`Unable to count ${table} status ${status}.`, { error: error.message });

  return count ?? 0;
}

async function listRecentPublishedOutboxEvents(supabase) {
  const { data, error } = await supabase
    .from("outbox_events")
    .select("id, status, published_at")
    .eq("status", "PUBLISHED")
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(100);

  if (error) fail("Unable to sample published outbox events.", { error: error.message });

  return data ?? [];
}

async function snapshotCounts() {
  const supabase = createQaSupabaseClient();
  const [
    ledgerEntries,
    creditReservations,
    creditSettlementApplications,
    financialWallets,
    outboxEvents,
    authorityApprovals,
  ] = await Promise.all([
    countRows(supabase, "financial_ledger_entries"),
    countRows(supabase, "credit_reservations"),
    countRows(supabase, "credit_settlement_applications"),
    countRows(supabase, "financial_wallets"),
    countRows(supabase, "outbox_events"),
    countRows(supabase, "authority_approval_records"),
  ]);

  return {
    ledgerEntries,
    creditReservations,
    creditSettlementApplications,
    financialWallets,
    outboxEvents,
    authorityApprovals,
  };
}

async function snapshotOutboxStatusCounts() {
  const supabase = createQaSupabaseClient();
  const [pending, published, failed, deadLetter] = await Promise.all([
    countRowsByStatus(supabase, "outbox_events", "PENDING"),
    countRowsByStatus(supabase, "outbox_events", "PUBLISHED"),
    countRowsByStatus(supabase, "outbox_events", "FAILED"),
    countRowsByStatus(supabase, "outbox_events", "DEAD_LETTER"),
  ]);

  return { pending, published, failed, deadLetter };
}

async function snapshotRecentPublishedOutboxEvents() {
  return listRecentPublishedOutboxEvents(createQaSupabaseClient());
}

function assertPlatformState(baseline) {
  for (const domain of ["settlement", "ledger", "credit"]) {
    assert(baseline[domain].authority === "SERVICE", `${domain} authority changed.`, {
      baseline,
    });
    assert(
      baseline[domain].certificationStatus === "CERTIFIED",
      `${domain} certification changed.`,
      { baseline }
    );
    assert(
      baseline[domain].comparisonMode === "ENABLED",
      `${domain} comparison mode changed.`,
      { baseline }
    );
    assert(
      baseline[domain].rollbackReadiness === "READY",
      `${domain} rollback readiness changed.`,
      { baseline }
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freshActiveWorkerCount(baseline) {
  const thresholdSeconds =
    baseline.operationsMetrics.lag.thresholds.heartbeatStaleSeconds ?? 300;
  const generatedAt = new Date(baseline.operationsMetrics.generatedAt).getTime();

  return baseline.operationsMetrics.workers.heartbeats.filter((heartbeat) => {
    const ageSeconds =
      (generatedAt - new Date(heartbeat.lastSeenAt).getTime()) / 1000;

    return heartbeat.status === "ACTIVE" && ageSeconds <= thresholdSeconds;
  }).length;
}

async function pollBaselineUntil(predicate, description, timeoutMs = 90000) {
  const startedAt = Date.now();
  let lastPayload = null;

  while (Date.now() - startedAt <= timeoutMs) {
    const payload = await authGet("/api/operations/performance-baseline");
    lastPayload = payload.performanceBaseline;

    if (predicate(lastPayload)) {
      return lastPayload;
    }

    await sleep(5000);
  }

  fail(`Timed out waiting for ${description}.`, {
    lastBaseline: lastPayload,
  });
}

await Promise.all([
  assertProtected("/api/operations/performance-baseline"),
  assertProtected("/api/operations/system-throughput"),
  assertProtected("/api/operations/runtime-profile"),
]);
pass("Performance baseline APIs require auth.");

const beforeCounts = await snapshotCounts();
const beforeOutboxStatus = await snapshotOutboxStatusCounts();
const baselinePayload = await authGet("/api/operations/performance-baseline");
const throughputPayload = await authGet("/api/operations/system-throughput");
const runtimePayload = await authGet("/api/operations/runtime-profile");

const baseline = baselinePayload.performanceBaseline;
const throughput = throughputPayload.throughput;
const runtimeProfile = runtimePayload.runtimeProfile;

assert(baseline.measurementOnly === true, "Performance baseline must be measurement-only.", {
  baseline,
});
assertPlatformState(baseline.authorityBaseline);
assert(
  JSON.stringify(beforeCounts) === JSON.stringify(await snapshotCounts()),
  "Performance baseline APIs mutated persisted operational or financial counts.",
  { beforeCounts }
);
assert(baseline.http.samples > 0, "HTTP latency samples were not generated.", {
  http: baseline.http,
});
assert(
  baseline.database.sampledQueries.length > 0,
  "Database latency samples were not generated.",
  { database: baseline.database }
);
assert(
  baseline.throughput.generatedAt && throughput.generatedAt,
  "Throughput reports were not generated.",
  { baselineThroughput: baseline.throughput, throughput }
);
assert(
  runtimeProfile.memory.rssBytes > 0 && runtimeProfile.uptime.nodeUptimeSeconds >= 0,
  "Runtime profile was not generated.",
  { runtimeProfile }
);
assert(
  Array.isArray(baseline.bottlenecks) && baseline.bottlenecks.length > 0,
  "Bottleneck ranking was not generated.",
  { bottlenecks: baseline.bottlenecks }
);

const activityBaseline = await pollBaselineUntil(
  (candidate) => {
    const activeWorkers = freshActiveWorkerCount(candidate);
    const publishedIncreased =
      candidate.operationsMetrics.outbox.publishedCount > beforeOutboxStatus.published;
    const pendingDecreased =
      candidate.operationsMetrics.outbox.pendingCount < beforeOutboxStatus.pending;

    if (beforeOutboxStatus.pending > 0) {
      return activeWorkers > 0 && (publishedIncreased || pendingDecreased);
    }

    return activeWorkers > 0;
  },
  "worker activation and outbox dispatcher activity"
);
const afterOutboxStatus = await snapshotOutboxStatusCounts();
const afterCounts = await snapshotCounts();
const recentPublished = await snapshotRecentPublishedOutboxEvents();
const recentPublishedIds = recentPublished.map((event) => event.id);
const uniquePublishedIds = new Set(recentPublishedIds);
const activeWorkers = freshActiveWorkerCount(activityBaseline);
const publishedDelta = afterOutboxStatus.published - beforeOutboxStatus.published;
const pendingDelta = afterOutboxStatus.pending - beforeOutboxStatus.pending;
const queueDepthBefore = baseline.throughput.rabbitmq.queueDepth;
const queueDepthAfter = activityBaseline.throughput.rabbitmq.queueDepth;

assert(activeWorkers > 0, "No fresh active worker heartbeat was observed.", {
  activeWorkers,
  workers: activityBaseline.operationsMetrics.workers,
});
assert(
  beforeOutboxStatus.pending === 0 || publishedDelta > 0 || pendingDelta < 0,
  "Outbox dispatcher did not publish or reduce pending backlog.",
  { beforeOutboxStatus, afterOutboxStatus, publishedDelta, pendingDelta }
);
assert(
  beforeOutboxStatus.failed === afterOutboxStatus.failed,
  "Outbox failed event count changed during performance QA.",
  { beforeOutboxStatus, afterOutboxStatus }
);
assert(
  beforeOutboxStatus.deadLetter === afterOutboxStatus.deadLetter,
  "Outbox dead-letter event count changed during performance QA.",
  { beforeOutboxStatus, afterOutboxStatus }
);
assert(
  uniquePublishedIds.size === recentPublishedIds.length,
  "Duplicate outbox publish identifiers were observed in the recent sample.",
  { recentPublishedIds }
);
assert(
  queueDepthBefore === null ||
    queueDepthAfter === null ||
    queueDepthAfter <= queueDepthBefore + Math.max(10, publishedDelta),
  "RabbitMQ queue depth grew beyond the dispatched activity allowance.",
  { queueDepthBefore, queueDepthAfter, publishedDelta }
);
assertPlatformState(activityBaseline.authorityBaseline);
assert(
  JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
  "Performance baseline worker activity mutated persisted operational or financial counts.",
  { beforeCounts, afterCounts }
);

pass("Performance baseline QA completed.", {
  httpAverageMs: baseline.http.averageMs,
  databaseAverageMs: baseline.database.averageQueryDurationMs,
  settlementPerSecond: baseline.throughput.settlement.perSecond,
  ledgerPerSecond: baseline.throughput.ledger.perSecond,
  creditReservationsPerSecond: baseline.throughput.credit.reservations.perSecond,
  outboxPendingBefore: beforeOutboxStatus.pending,
  outboxPendingAfter: afterOutboxStatus.pending,
  outboxPublishedDelta: publishedDelta,
  freshActiveWorkers: activeWorkers,
  queueDepthBefore,
  queueDepthAfter,
  bottleneckCount: baseline.bottlenecks.length,
  beforeCounts,
  afterCounts,
});
