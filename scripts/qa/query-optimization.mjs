import { spawnSync } from "node:child_process";
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

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

async function assertProtected(path) {
  const { response, body } = await requestJson(path);

  assert(response.status === 401 || response.status === 403, `${path} should require auth.`, {
    status: response.status,
    body,
  });
}

async function authGet(path) {
  const { response, body } = await requestJson(path, { headers: authHeaders() });

  assert(response.status === 200 && body?.success === true, `${path} failed.`, {
    status: response.status,
    body,
  });

  return body;
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

function assertCountsUnchanged(before, after) {
  for (const key of Object.keys(before)) {
    assert(before[key] === after[key], `${key} mutated during query optimization QA.`, {
      before,
      after,
    });
  }
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
  assertProtected("/api/settlement-shadow/summary"),
  assertProtected("/api/credit-shadow/summary"),
  assertProtected("/api/workers/outbox-events"),
]);
pass("Optimized protected endpoints require auth.");

const beforeCounts = await snapshotFinancialCounts();
const [settlementSummary, creditSummary, outboxEvents, baselinePayload] =
  await Promise.all([
    authGet("/api/settlement-shadow/summary"),
    authGet("/api/credit-shadow/summary"),
    authGet("/api/workers/outbox-events"),
    authGet("/api/authority/baseline-status"),
  ]);

assert(
  typeof settlementSummary.summary?.totalRuns === "number" &&
    typeof settlementSummary.summary?.readiness?.status === "string",
  "Settlement shadow summary response contract changed.",
  { settlementSummary }
);
assert(
  typeof creditSummary.summary?.totalRuns === "number" &&
    typeof creditSummary.summary?.readiness?.status === "string",
  "Credit shadow summary response contract changed.",
  { creditSummary }
);
assert(Array.isArray(outboxEvents.outboxEvents), "Outbox event response contract changed.", {
  outboxEvents,
});
assertAuthorityBaseline(baselinePayload.baselineStatus);

const reportResult = spawnSync("npm", ["run", "ops:query-optimization-report"], {
  encoding: "utf8",
  env: process.env,
});

if (reportResult.status !== 0) {
  fail("Query optimization report failed.", {
    stdout: reportResult.stdout,
    stderr: reportResult.stderr,
  });
}

let report;
try {
  report = JSON.parse(reportResult.stdout);
} catch (error) {
  fail("Query optimization report did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: reportResult.stdout,
  });
}

const afterCounts = await snapshotFinancialCounts();
assertCountsUnchanged(beforeCounts, afterCounts);

assert(report.measurementOnly === true, "Query optimization report must be measurement-only.", {
  report,
});
assert(
  Array.isArray(report.optimizedTargets) && report.optimizedTargets.length >= 1,
  "Before/after optimization report is missing targets.",
  { report }
);
assert(
  report.optimizedTargets.every(
    (target) =>
      typeof target.beforeMs === "number" &&
      typeof target.afterMs === "number" &&
      typeof target.improvementPercent === "number"
  ),
  "Optimization report is missing before/after measurements.",
  { report }
);
assert(
  report.optimizedTargets.some((target) => target.improvementPercent > 0),
  "No measured improvement was demonstrated.",
  { report }
);
assert(
  report.optimizedTargets.every((target) => target.behaviorChanged === false),
  "An optimized target reported a behavior change.",
  { report }
);

pass("Query optimization QA completed.", {
  optimizedTargets: report.optimizedTargets.map((target) => ({
    name: target.name,
    beforeMs: target.beforeMs,
    afterMs: target.afterMs,
    improvementPercent: target.improvementPercent,
  })),
  beforeCounts,
  afterCounts,
});
