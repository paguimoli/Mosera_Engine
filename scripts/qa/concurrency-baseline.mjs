import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import "./load-session-env.mjs";
import { writeQaSessionFile } from "./lib/qa-auth-session.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
let sessionToken =
  process.env.QA_ADMIN_SESSION_TOKEN || process.env.OPS_ADMIN_SESSION_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminUsername = process.env.QA_ADMIN_USERNAME || "admin2";
const adminPassword = process.env.QA_ADMIN_PASSWORD || "";

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
  for (const key of ["tickets", "reservations", "settlements", "ledgerEntries", "wallets"]) {
    assert(before[key] === after[key], `${key} changed during concurrency baseline.`, {
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

function assertInvariants(invariants) {
  for (const [key, value] of Object.entries(invariants)) {
    assert(value === true, `Concurrency invariant failed: ${key}.`, {
      invariants,
    });
  }
}

await ensureSessionToken();

await Promise.all([
  assertProtected("/api/operations/load-test-status"),
  assertProtected("/api/operations/concurrency-baseline"),
  assertProtected("/api/operations/load-summary"),
]);
pass("Load and concurrency APIs require auth.");

const beforeCounts = await snapshotCounts();
const statusPayload = await authGet("/api/operations/load-test-status");
const baselinePayload = await authGet("/api/operations/concurrency-baseline");
const summaryPayload = await authGet("/api/operations/load-summary");
const afterCounts = await snapshotCounts();

const status = statusPayload.loadTestStatus;
const baseline = baselinePayload.concurrencyBaseline;
const summary = summaryPayload.loadSummary;

assert(status.measurementOnly === true, "Load test status must be measurement-only.", {
  status,
});
assert(status.status === "READY", "Load test status is not ready.", { status });
assert(baseline.measurementOnly === true, "Concurrency baseline must be measurement-only.", {
  baseline,
});
assert(summary.measurementOnly === true, "Load summary must be measurement-only.", {
  summary,
});
assertCountsUnchanged(beforeCounts, afterCounts);
assertInvariants(baseline.invariants);

const scenarioNames = new Set(baseline.scenarios.map((scenario) => scenario.scenario));
for (const expected of status.supportedScenarios) {
  assert(scenarioNames.has(expected), `Scenario ${expected} was not measured.`, {
    measured: [...scenarioNames],
  });
}

assert(
  baseline.scenarios.every(
    (scenario) =>
      scenario.measurementMode === "READ_ONLY_BASELINE" &&
      typeof scenario.concurrency === "number" &&
      typeof scenario.throughputPerSecond === "number" &&
      "averageLatencyMs" in scenario &&
      "p95LatencyMs" in scenario &&
      "p99LatencyMs" in scenario
  ),
  "Scenario measurements are incomplete.",
  { scenarios: baseline.scenarios }
);
assert(
  baseline.authority.settlement === "SERVICE" &&
    baseline.authority.settlementCertification === "CERTIFIED" &&
    baseline.authority.ledger === "SERVICE" &&
    baseline.authority.ledgerCertification === "CERTIFIED" &&
    baseline.authority.credit === "SERVICE" &&
    baseline.authority.creditCertification === "CERTIFIED",
  "Authority/certification baseline changed.",
  { authority: baseline.authority }
);
assert(
  summary.scenarioCount === baseline.scenarios.length,
  "Load summary scenario count does not match baseline.",
  { summary, scenarioCount: baseline.scenarios.length }
);

pass("Load and concurrency baseline QA completed.", {
  scenarioCount: baseline.scenarios.length,
  highestThroughputPerSecond: summary.highestThroughputPerSecond,
  slowestP95LatencyMs: summary.slowestP95LatencyMs,
  bottleneckCount: baseline.bottlenecks.length,
  beforeCounts,
  afterCounts,
});
