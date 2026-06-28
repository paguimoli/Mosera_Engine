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
  for (const key of Object.keys(before)) {
    assert(before[key] === after[key], `${key} mutated during resilience baseline QA.`, {
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

function assertAuthorityBaseline(status) {
  assert(status.authority.settlement === "SERVICE", "Settlement authority changed.", { status });
  assert(status.authority.ledger === "SERVICE", "Ledger authority changed.", { status });
  assert(status.authority.credit === "SERVICE", "Credit authority changed.", { status });
  assert(status.certification.settlement === "CERTIFIED", "Settlement certification changed.", { status });
  assert(status.certification.ledger === "CERTIFIED", "Ledger certification changed.", { status });
  assert(status.certification.credit === "CERTIFIED", "Credit certification changed.", { status });
  assert(status.comparison.settlement === "ENABLED", "Settlement comparison changed.", { status });
  assert(status.comparison.ledger === "ENABLED", "Ledger comparison changed.", { status });
  assert(status.comparison.credit === "ENABLED", "Credit comparison changed.", { status });
  assert(status.rollback.settlement === "READY", "Settlement rollback readiness changed.", { status });
  assert(status.rollback.ledger === "READY", "Ledger rollback readiness changed.", { status });
  assert(status.rollback.credit === "READY", "Credit rollback readiness changed.", { status });
  assert(status.rollback.overall === "READY", "Overall rollback readiness changed.", { status });
}

await ensureSessionToken();

await Promise.all([
  assertProtected("/api/operations/resilience-status"),
  assertProtected("/api/operations/failure-recovery-baseline"),
  assertProtected("/api/operations/retry-idempotency-status"),
  assertProtected("/api/operations/service-recovery-summary"),
]);
pass("Resilience baseline APIs require auth.");

const beforeCounts = await snapshotCounts();
const [statusPayload, baselinePayload, retryPayload, recoveryPayload] =
  await Promise.all([
    authGet("/api/operations/resilience-status"),
    authGet("/api/operations/failure-recovery-baseline"),
    authGet("/api/operations/retry-idempotency-status"),
    authGet("/api/operations/service-recovery-summary"),
  ]);
const resilienceStatus = statusPayload.resilienceStatus;
const baseline = baselinePayload.failureRecoveryBaseline;
const retryStatus = retryPayload.retryIdempotencyStatus;
const recovery = recoveryPayload.serviceRecoverySummary;

assert(resilienceStatus.measurementOnly === true, "Resilience status must be measurement-only.", {
  resilienceStatus,
});
assert(baseline.measurementOnly === true, "Failure recovery baseline must be measurement-only.", {
  baseline,
});
assert(baseline.destructiveTestsPerformed === false, "Destructive tests must not run.", {
  baseline,
});
assertAuthorityBaseline(resilienceStatus);
assert(
  Array.isArray(baseline.scenarios) && baseline.scenarios.length >= 8,
  "Resilience scenarios are incomplete.",
  { scenarios: baseline.scenarios }
);
assert(
  baseline.scenarios.every(
    (scenario) => scenario.simulatedOnly === true && scenario.destructiveTest === false
  ),
  "All resilience scenarios must be simulated/non-destructive.",
  { scenarios: baseline.scenarios }
);
assert(
  recovery.rabbitmq.length > 0,
  "RabbitMQ health report was not generated.",
  { recovery }
);
assert(
  typeof recovery.redisHealth.available === "boolean",
  "Redis health report was not generated.",
  { recovery }
);
assert(
  recovery.workers.heartbeats.length > 0,
  "Worker heartbeat report was not generated.",
  { recovery }
);
assert(
  typeof recovery.outbox.pendingCount === "number" &&
    typeof recovery.outbox.publishedCount === "number",
  "Outbox dispatcher recovery evidence was not generated.",
  { outbox: recovery.outbox }
);
assert(
  retryStatus.duplicatePrevention.duplicateTickets === 0 &&
    retryStatus.duplicatePrevention.duplicateSettlements === 0 &&
    retryStatus.duplicatePrevention.duplicateLedgerReferences === 0 &&
    retryStatus.duplicatePrevention.duplicateCreditReservations === 0,
  "Duplicate prevention evidence reported duplicates.",
  { retryStatus }
);

const afterCounts = await snapshotCounts();
assertCountsUnchanged(beforeCounts, afterCounts);

pass("Resilience baseline QA completed.", {
  status: baseline.status,
  scenarioCount: baseline.scenarios.length,
  rabbitmqVisible: resilienceStatus.rabbitmqVisible,
  redisVisible: resilienceStatus.redisVisible,
  workersVisible: resilienceStatus.workersVisible,
  dispatcherVisible: resilienceStatus.dispatcherVisible,
  retryStatus: retryStatus.status,
  duplicatePrevention: retryStatus.duplicatePrevention,
  blockers: baseline.blockers,
  warnings: baseline.warnings.slice(0, 10),
  beforeCounts,
  afterCounts,
});
