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

await Promise.all([
  assertProtected("/api/operations/performance-baseline"),
  assertProtected("/api/operations/system-throughput"),
  assertProtected("/api/operations/runtime-profile"),
]);
pass("Performance baseline APIs require auth.");

const beforeCounts = await snapshotCounts();
const baselinePayload = await authGet("/api/operations/performance-baseline");
const throughputPayload = await authGet("/api/operations/system-throughput");
const runtimePayload = await authGet("/api/operations/runtime-profile");
const afterCounts = await snapshotCounts();

const baseline = baselinePayload.performanceBaseline;
const throughput = throughputPayload.throughput;
const runtimeProfile = runtimePayload.runtimeProfile;

assert(baseline.measurementOnly === true, "Performance baseline must be measurement-only.", {
  baseline,
});
assertPlatformState(baseline.authorityBaseline);
assert(
  JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
  "Performance baseline APIs mutated persisted operational or financial counts.",
  { beforeCounts, afterCounts }
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

pass("Performance baseline QA completed.", {
  httpAverageMs: baseline.http.averageMs,
  databaseAverageMs: baseline.database.averageQueryDurationMs,
  settlementPerSecond: baseline.throughput.settlement.perSecond,
  ledgerPerSecond: baseline.throughput.ledger.perSecond,
  creditReservationsPerSecond: baseline.throughput.credit.reservations.perSecond,
  outboxPending: baseline.throughput.outbox.pending,
  bottleneckCount: baseline.bottlenecks.length,
  beforeCounts,
  afterCounts,
});
