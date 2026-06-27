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

async function snapshotFinancialCounts() {
  const supabase = createQaSupabaseClient();
  const [
    ledgerEntries,
    creditReservations,
    creditSettlementApplications,
    financialWallets,
    authorityApprovals,
  ] = await Promise.all([
    countRows(supabase, "financial_ledger_entries"),
    countRows(supabase, "credit_reservations"),
    countRows(supabase, "credit_settlement_applications"),
    countRows(supabase, "financial_wallets"),
    countRows(supabase, "authority_approval_records"),
  ]);

  return {
    ledgerEntries,
    creditReservations,
    creditSettlementApplications,
    financialWallets,
    authorityApprovals,
  };
}

function assertAuthorityBaseline(baseline) {
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
  assertProtected("/api/operations/database-native-status"),
  assertProtected("/api/operations/database-explain-plans"),
  assertProtected("/api/operations/database-lock-analysis"),
  assertProtected("/api/operations/database-session-analysis"),
]);
pass("Database observability APIs require auth.");

const beforeCounts = await snapshotFinancialCounts();
const [
  nativeStatusPayload,
  explainPlansPayload,
  lockAnalysisPayload,
  sessionAnalysisPayload,
  baselinePayload,
] = await Promise.all([
  authGet("/api/operations/database-native-status"),
  authGet("/api/operations/database-explain-plans"),
  authGet("/api/operations/database-lock-analysis"),
  authGet("/api/operations/database-session-analysis"),
  authGet("/api/operations/performance-baseline"),
]);
const afterCounts = await snapshotFinancialCounts();

const nativeStatus = nativeStatusPayload.nativeStatus;
const explainPlans = explainPlansPayload.explainPlans;
const lockAnalysis = lockAnalysisPayload.lockAnalysis;
const sessionAnalysis = sessionAnalysisPayload.sessionAnalysis;
const baseline = baselinePayload.performanceBaseline;
const observability = baseline.databaseObservability;

assert(nativeStatus.measurementOnly === true, "Native status must be measurement-only.", {
  nativeStatus,
});
assert(
  ["READY", "WARNING", "UNAVAILABLE"].includes(nativeStatus.status),
  "Native telemetry status is invalid.",
  { nativeStatus }
);
assert(
  nativeStatus.status !== "UNAVAILABLE" || nativeStatus.limitations.length > 0,
  "Unsupported native telemetry was not explicitly reported.",
  { nativeStatus }
);
assert(explainPlans.measurementOnly === true, "Explain plans must be measurement-only.", {
  explainPlans,
});
assert(
  Array.isArray(explainPlans.plans) && explainPlans.plans.length > 0,
  "Explain plan candidates were not generated.",
  { explainPlans }
);
assert(
  explainPlans.plans.every((plan) => plan.statementTemplate.startsWith("EXPLAIN")),
  "Explain plan statement templates are not read-only EXPLAIN templates.",
  { explainPlans }
);
assert(
  explainPlans.status !== "UNAVAILABLE" || explainPlans.limitations.length > 0,
  "Unsupported explain plans were not explicitly reported.",
  { explainPlans }
);
assert(lockAnalysis.measurementOnly === true, "Lock analysis must be measurement-only.", {
  lockAnalysis,
});
assert(
  lockAnalysis.status !== "UNAVAILABLE" || lockAnalysis.limitations.length > 0,
  "Unsupported lock metrics were not explicitly reported.",
  { lockAnalysis }
);
assert(sessionAnalysis.measurementOnly === true, "Session analysis must be measurement-only.", {
  sessionAnalysis,
});
assert(
  sessionAnalysis.status !== "UNAVAILABLE" || sessionAnalysis.limitations.length > 0,
  "Unsupported session metrics were not explicitly reported.",
  { sessionAnalysis }
);
assert(
  observability?.measurementOnly === true,
  "Performance baseline did not include database observability.",
  { observability }
);
assert(
  Array.isArray(observability.timing.repositoryTiming) &&
    observability.timing.repositoryTiming.length > 0,
  "Repository timing was not generated.",
  { timing: observability.timing }
);
assert(
  Array.isArray(observability.timing.endpointTiming) &&
    observability.timing.endpointTiming.length > 0,
  "Endpoint timing was not generated.",
  { timing: observability.timing }
);
assert(
  Array.isArray(observability.recommendations) &&
    observability.recommendations.length > 0,
  "Database observability recommendations were not generated.",
  { recommendations: observability.recommendations }
);
assertAuthorityBaseline(baseline.authorityBaseline);
assert(
  JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
  "Database observability mutated financial or authority records.",
  { beforeCounts, afterCounts }
);

pass("Database observability QA completed.", {
  nativeStatus: nativeStatus.status,
  nativeSource: nativeStatus.source,
  lockStatus: lockAnalysis.status,
  sessionStatus: sessionAnalysis.status,
  explainStatus: explainPlans.status,
  explainPlanCount: explainPlans.plans.length,
  repositoryTimingTop: observability.timing.repositoryTiming[0],
  endpointTimingTop: observability.timing.endpointTiming[0],
  beforeCounts,
  afterCounts,
});
