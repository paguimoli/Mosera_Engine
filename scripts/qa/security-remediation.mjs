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
    assert(before[key] === after[key], `${key} mutated during security remediation QA.`, {
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

  return { response, body };
}

function assertSecurityHeaders(response) {
  assert(Boolean(response.headers.get("content-security-policy")), "Content-Security-Policy header missing.");
  assert(response.headers.get("x-content-type-options") === "nosniff", "nosniff header missing.");
  assert(response.headers.get("x-frame-options") === "DENY", "frame denial header missing.");
}

function assertPlatformState(platformState) {
  assert(platformState.settlement.authority === "SERVICE", "Settlement authority changed.", {
    platformState,
  });
  assert(platformState.settlement.certificationStatus === "CERTIFIED", "Settlement certification changed.", {
    platformState,
  });
  assert(platformState.ledger.authority === "SERVICE", "Ledger authority changed.", {
    platformState,
  });
  assert(platformState.ledger.certificationStatus === "CERTIFIED", "Ledger certification changed.", {
    platformState,
  });
  assert(platformState.credit.authority === "SERVICE", "Credit authority changed.", {
    platformState,
  });
  assert(platformState.credit.certificationStatus === "CERTIFIED", "Credit certification changed.", {
    platformState,
  });
  assert(platformState.settlement.rollbackReadiness === "READY", "Settlement rollback changed.", {
    platformState,
  });
  assert(platformState.ledger.rollbackReadiness === "READY", "Ledger rollback changed.", {
    platformState,
  });
  assert(platformState.credit.rollbackReadiness === "READY", "Credit rollback changed.", {
    platformState,
  });
}

function runDependencyAudit() {
  const result = spawnSync("npm", ["run", "security:audit"], {
    encoding: "utf8",
    env: {
      ...process.env,
      SECURITY_AUDIT_LEVEL: process.env.SECURITY_AUDIT_LEVEL || "critical",
    },
  });

  assert(result.status === 0, "Dependency audit script failed.", {
    stdout: result.stdout,
    stderr: result.stderr,
  });

  const jsonStart = result.stdout.indexOf("{");
  const audit = JSON.parse(result.stdout.slice(jsonStart));

  assert(audit.threshold === (process.env.SECURITY_AUDIT_LEVEL || "critical"), "Audit threshold mismatch.", {
    audit,
  });

  return audit;
}

async function assertLoginRateLimit() {
  const username = `qa-rate-limit-${Date.now()}`;
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  let limitedResponse = null;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { response, body } = await requestJson("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({
        username,
        password: "not-the-password",
      }),
    });

    if (response.status === 429) {
      limitedResponse = { response, body };
      break;
    }

    assert(response.status === 401, "Invalid login should fail generically before rate limit.", {
      status: response.status,
      body,
    });
    assert(body?.error === "Invalid username or password.", "Invalid login leaked a non-generic message.", {
      body,
    });
  }

  assert(limitedResponse, "Login rate limit did not trigger.", { username, ip });
  assert(
    limitedResponse.body?.error === "Too many authentication attempts. Try again later.",
    "Rate-limited login returned unsafe message.",
    { body: limitedResponse.body }
  );
}

async function assertAuthFailureStillWorks() {
  const { response, body } = await requestJson("/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify({
      username: `qa-auth-failure-${Date.now()}`,
      password: "not-the-password",
    }),
  });

  assert(response.status === 401, "Auth failure did not preserve current behavior.", {
    status: response.status,
    body,
  });
  assert(body?.error === "Invalid username or password.", "Auth failure leaked a non-generic message.", {
    body,
  });
}

async function assertOAuthAndMfaDoNotRegress() {
  const oauth = await requestJson("/api/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `192.0.2.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: `qa-client-${Date.now()}`,
      client_secret: "not-the-secret",
    }),
  });

  assert(oauth.response.status === 401, "OAuth invalid client behavior regressed.", {
    status: oauth.response.status,
    body: oauth.body,
  });
  assert(oauth.body?.error === "invalid_client", "OAuth failure contract changed.", {
    body: oauth.body,
  });

  const mfa = await requestJson("/api/auth/mfa/challenge/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `192.0.2.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify({
      challengeToken: `qa-challenge-${Date.now()}`,
      code: "000000",
    }),
  });

  assert(mfa.response.status === 401, "MFA invalid challenge behavior regressed.", {
    status: mfa.response.status,
    body: mfa.body,
  });
  assert(mfa.body?.error === "Invalid MFA challenge.", "MFA failure contract changed.", {
    body: mfa.body,
  });
}

await ensureSessionToken();

await Promise.all([
  assertProtected("/api/operations/security-status"),
  assertProtected("/api/operations/security-findings"),
  assertProtected("/api/operations/security-summary"),
]);
pass("Security remediation APIs require auth.");

const beforeCounts = await snapshotCounts();
await assertLoginRateLimit();
await assertAuthFailureStillWorks();
await assertOAuthAndMfaDoNotRegress();

const statusPayload = await authGet("/api/operations/security-status");
const summaryPayload = await authGet("/api/operations/security-summary");
assertSecurityHeaders(statusPayload.response);

const securityStatus = statusPayload.body.securityStatus;
const securitySummary = summaryPayload.body.securitySummary;

assertPlatformState(securityStatus.platformState);
assert(securityStatus.controlStatus.authRateLimit.enabled === true, "Auth rate limit status missing.", {
  securityStatus,
});
assert(
  securityStatus.controlStatus.rabbitmqSecrets.posture === "WARNING" ||
    securityStatus.controlStatus.rabbitmqSecrets.posture === "READY",
  "RabbitMQ secret posture was not reported safely.",
  { securityStatus }
);
assert(securityStatus.controlStatus.csp.tightened === true, "CSP tightening status missing.", {
  securityStatus,
});
assert(
  securitySummary.riskRegister.find((finding) => finding.id === "SEC-AUTH-RATE-LIMIT-001")?.status ===
    "IMPLEMENTED",
  "Auth rate limit finding was not marked implemented.",
  { securitySummary }
);
assert(
  securitySummary.riskRegister.find((finding) => finding.id === "SEC-INFRA-RABBITMQ-001")?.status ===
    "IMPLEMENTED",
  "RabbitMQ secret finding was not marked implemented.",
  { securitySummary }
);
assert(
  securitySummary.riskRegister.find((finding) => finding.id === "SEC-DEPENDENCY-AUDIT-001")?.status ===
    "IMPLEMENTED",
  "Dependency audit finding was not marked implemented.",
  { securitySummary }
);

const dependencyAudit = runDependencyAudit();
const afterCounts = await snapshotCounts();
assertCountsUnchanged(beforeCounts, afterCounts);

pass("Security remediation QA completed.", {
  securityStatus: securityStatus.status,
  openCriticalCount: securityStatus.openCriticalCount,
  openHighCount: securityStatus.openHighCount,
  openMediumCount: securityStatus.openMediumCount,
  rabbitmqPosture: securityStatus.controlStatus.rabbitmqSecrets.posture,
  dependencyAudit,
});
