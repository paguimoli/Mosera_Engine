import { spawnSync } from "node:child_process";
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
  if (!sessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN or OPS_ADMIN_SESSION_TOKEN is required.");
  }

  return {
    authorization: `Bearer ${sessionToken}`,
    ...extra,
  };
}

async function ensureSessionToken() {
  if (sessionToken) {
    const response = await fetch(`${appUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    if (response.ok) {
      return;
    }
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

  assert(response.status === 200 && body?.success === true && body.sessionToken, "Admin login flow failed.", {
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

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
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

async function snapshotCounts() {
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
    assert(before[key] === after[key], `${key} changed during auth/worker query QA.`, {
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

const unauthenticated = await requestJson("/api/auth/me");
assert(unauthenticated.response.status === 401, "Auth session endpoint should require auth.", {
  status: unauthenticated.response.status,
  body: unauthenticated.body,
});

await ensureSessionToken();

const beforeCounts = await snapshotCounts();
const [me, permission, workers, baselinePayload] = await Promise.all([
  authGet("/api/auth/me"),
  authGet("/api/auth/check-permission?permission=system.admin"),
  authGet("/api/operations/workers"),
  authGet("/api/authority/baseline-status"),
]);

assert(typeof me.user?.id === "string", "Session validation response changed.", { me });
assert(Array.isArray(me.groups), "Authenticated groups response changed.", { me });
assert(Array.isArray(me.permissions), "Authenticated permissions response changed.", { me });
assert(permission.allowed === true, "System admin permission check failed.", {
  permission,
});
assertAuthorityBaseline(baselinePayload.baselineStatus);

assert(Array.isArray(workers.workers?.heartbeats), "Worker heartbeat report changed.", {
  workers,
});
assert(
  Array.isArray(workers.workers?.freshHeartbeats),
  "Fresh worker heartbeat report is missing.",
  { workers }
);
assert(
  Array.isArray(workers.workers?.staleHeartbeatEvidence),
  "Stale worker heartbeat evidence is missing.",
  { workers }
);
assert(
  workers.workers.freshHeartbeats.length > 0 ||
    workers.workers.heartbeats.length > 0,
  "Worker heartbeat evidence was not observed.",
  { workers }
);

const reportResult = spawnSync(
  "npm",
  ["run", "ops:auth-worker-query-efficiency-report"],
  {
    encoding: "utf8",
    env: process.env,
  }
);

if (reportResult.status !== 0) {
  fail("Auth/worker query efficiency report failed.", {
    stdout: reportResult.stdout,
    stderr: reportResult.stderr,
  });
}

let report;
try {
  report = JSON.parse(reportResult.stdout);
} catch (error) {
  fail("Auth/worker query efficiency report did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: reportResult.stdout,
  });
}

assert(report.measurementOnly === true, "Efficiency report must be measurement-only.", {
  report,
});
assert(
  Array.isArray(report.optimizedTargets) && report.optimizedTargets.length >= 1,
  "Efficiency report is missing optimized targets.",
  { report }
);
assert(
  report.optimizedTargets.every(
    (target) =>
      typeof target.beforeMs === "number" &&
      typeof target.afterMs === "number" &&
      typeof target.improvementPercent === "number" &&
      target.behaviorChanged === false
  ),
  "Efficiency report is missing before/after measurements.",
  { report }
);
assert(
  report.optimizedTargets.some((target) => target.improvementPercent > 0),
  "No measured auth/worker query improvement was demonstrated.",
  { report }
);

const afterCounts = await snapshotCounts();
assertCountsUnchanged(beforeCounts, afterCounts);

pass("Auth and worker query efficiency QA completed.", {
  optimizedTargets: report.optimizedTargets.map((target) => ({
    name: target.name,
    beforeMs: target.beforeMs,
    afterMs: target.afterMs,
    improvementPercent: target.improvementPercent,
  })),
  workerHeartbeatCount: workers.workers.heartbeats.length,
  freshHeartbeatCount: workers.workers.freshHeartbeats.length,
  staleHeartbeatEvidenceCount: workers.workers.staleHeartbeatEvidence.length,
  beforeCounts,
  afterCounts,
});
