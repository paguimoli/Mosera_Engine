import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import "./load-session-env.mjs";
import {
  getQaSupabaseAccessUrl,
  getServiceRoleKey,
  writeQaSessionFile,
} from "./lib/qa-auth-session.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
let sessionToken =
  process.env.QA_ADMIN_SESSION_TOKEN || process.env.OPS_ADMIN_SESSION_TOKEN;
const adminUsername = process.env.QA_ADMIN_USERNAME || "admin2";
const adminPassword = process.env.QA_ADMIN_PASSWORD || "";
const supabaseUrl = getQaSupabaseAccessUrl();
const serviceRoleKey = getServiceRoleKey();

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

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

async function ensureSessionToken() {
  if (sessionToken) {
    const { response } = await requestJson("/api/auth/me", {
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    if (response.ok) return;
  }

  if (!adminPassword) {
    fail("A valid QA admin session token or QA_ADMIN_PASSWORD is required.");
  }

  const { response, body } = await requestJson("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: adminUsername,
      password: adminPassword,
    }),
  });

  assert(response.status === 200 && body?.success === true && body.sessionToken, "Admin login failed.", {
    status: response.status,
    body,
  });

  sessionToken = body.sessionToken;
  writeQaSessionFile({
    sessionToken,
    expiresAt: body.expiresAt,
  });
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

async function countRows(supabase, table) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true });

  if (error) fail(`Unable to count ${table}.`, { error: error.message });

  return count ?? 0;
}

async function snapshotFinancialCounts() {
  const supabase = createQaSupabaseClient();
  const [tickets, reservations, settlements, ledgerEntries, wallets, outboxEvents] =
    await Promise.all([
      countRows(supabase, "tickets"),
      countRows(supabase, "credit_reservations"),
      countRows(supabase, "credit_settlement_applications"),
      countRows(supabase, "financial_ledger_entries"),
      countRows(supabase, "financial_wallets"),
      countRows(supabase, "outbox_events"),
    ]);

  return {
    tickets,
    reservations,
    settlements,
    ledgerEntries,
    wallets,
    outboxEvents,
  };
}

function assertCountsUnchanged(before, after) {
  for (const key of Object.keys(before)) {
    assert(before[key] === after[key], `${key} mutated during bottleneck identification QA.`, {
      before,
      after,
    });
  }
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

await ensureSessionToken();
await assertProtected("/api/operations/concurrency-baseline");
pass("Concurrency bottleneck identification APIs require auth.");

const beforeCounts = await snapshotFinancialCounts();
const baselinePayload = await authGet("/api/operations/concurrency-baseline");
const authorityPayload = await authGet("/api/authority/baseline-status");
const baseline = baselinePayload.concurrencyBaseline;

assert(
  baseline.bottleneckBreakdown &&
    baseline.bottleneckBreakdown.slowestScenario &&
    baseline.bottleneckBreakdown.slowestStep,
  "Baseline bottleneck breakdown is missing slowest scenario or step.",
  { bottleneckBreakdown: baseline.bottleneckBreakdown }
);
assert(
  baseline.scenarios.every(
    (scenario) =>
      Array.isArray(scenario.stepMeasurements) &&
      scenario.stepMeasurements.length >= 1 &&
      scenario.stepMeasurements.every(
        (step) =>
          typeof step.step === "string" &&
          "p95LatencyMs" in step &&
          "p99LatencyMs" in step &&
          typeof step.sampleCount === "number" &&
          typeof step.errorCount === "number"
      )
  ),
  "Step-level timing breakdown is incomplete.",
  { scenarios: baseline.scenarios }
);
assertAuthorityBaseline(authorityPayload.baselineStatus);

const reportResult = spawnSync("npm", ["run", "ops:concurrency-bottleneck-report"], {
  encoding: "utf8",
  env: process.env,
});

if (reportResult.status !== 0) {
  fail("Concurrency bottleneck report failed.", {
    stdout: reportResult.stdout,
    stderr: reportResult.stderr,
  });
}

let report;
try {
  const jsonStart = reportResult.stdout.indexOf("{");
  report = JSON.parse(jsonStart >= 0 ? reportResult.stdout.slice(jsonStart) : reportResult.stdout);
} catch (error) {
  fail("Concurrency bottleneck report did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: reportResult.stdout,
  });
}

const afterCounts = await snapshotFinancialCounts();
assertCountsUnchanged(beforeCounts, afterCounts);

assert(report.measurementOnly === true, "Bottleneck report must be measurement-only.", {
  report,
});
assert(report.slowest?.scenario && report.slowest?.step, "Slowest scenario/step not identified.", {
  report,
});
assert(
  Array.isArray(report.topSlowestScenarioStepPairs) &&
    report.topSlowestScenarioStepPairs.length > 0 &&
    report.topSlowestScenarioStepPairs.every(
      (entry) =>
        typeof entry.scenario === "string" &&
        typeof entry.step === "string" &&
        "p95LatencyMs" in entry &&
        "p99LatencyMs" in entry &&
        typeof entry.likelySource === "string" &&
        typeof entry.optimizationRecommendation === "string"
    ),
  "Top slowest scenario/step report is incomplete.",
  { report }
);

pass("Concurrency bottleneck identification QA completed.", {
  slowest: report.slowest,
  beforeCounts,
  afterCounts,
});
