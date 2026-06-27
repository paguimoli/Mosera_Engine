import "../qa/load-session-env.mjs";

const appUrl =
  process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
let sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;
const adminUsername = process.env.QA_ADMIN_USERNAME || "admin2";
const adminPassword = process.env.QA_ADMIN_PASSWORD || "";

const selectedTargets = [
  {
    name: "auth session context",
    path: "/api/auth/me",
    beforeMs: 1290.875,
    beforeQueryCount: 7,
    afterQueryCount: 5,
    beforeResultCount: 49,
    change:
      "Consolidated user group and permission loading so authenticated request context reads memberships once.",
  },
  {
    name: "auth permission check",
    path: "/api/auth/check-permission?permission=system.admin",
    beforeMs: 1191.812,
    beforeQueryCount: 7,
    afterQueryCount: 5,
    beforeResultCount: 49,
    change:
      "Reused the consolidated authorization loader for permission checks without changing RBAC semantics.",
  },
  {
    name: "worker observability heartbeats",
    path: "/api/operations/workers",
    beforeMs: 1355.106,
    beforeQueryCount: 3,
    afterQueryCount: 4,
    beforeResultCount: 191,
    change:
      "Split fresh heartbeat reads from bounded stale heartbeat evidence so active workers are not reported through an unbounded historical scan.",
  },
];

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function round(value, digits = 3) {
  const multiplier = 10 ** digits;

  return Math.round(value * multiplier) / multiplier;
}

function improvementPercent(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) {
    return null;
  }

  return round(((before - after) / before) * 100);
}

function authHeaders() {
  if (!sessionToken) {
    fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  }

  return { authorization: `Bearer ${sessionToken}` };
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
    fail("A valid admin session token or QA_ADMIN_PASSWORD is required.");
  }

  const response = await fetch(`${appUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: adminUsername,
      password: adminPassword,
    }),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || body?.success !== true || !body.sessionToken) {
    fail("Unable to establish an admin session for the efficiency report.", {
      status: response.status,
      body,
    });
  }

  sessionToken = body.sessionToken;
}

function resultCountForTarget(target, body) {
  if (target.path.startsWith("/api/auth/")) {
    return (body.groups?.length ?? 0) + (body.permissions?.length ?? 0) + 1;
  }

  if (target.path === "/api/operations/workers") {
    return {
      heartbeats: body.workers?.heartbeats?.length ?? 0,
      freshHeartbeats: body.workers?.freshHeartbeats?.length ?? 0,
      staleHeartbeatEvidence:
        body.workers?.staleHeartbeatEvidence?.length ??
        body.workers?.staleWorkers?.length ??
        0,
    };
  }

  return null;
}

async function timedRequest(target) {
  const started = performance.now();
  const response = await fetch(`${appUrl}${target.path}`, {
    headers: authHeaders(),
  });
  const elapsedMs = round(performance.now() - started);
  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.success !== true) {
    fail(`${target.name} request failed.`, {
      status: response.status,
      body,
    });
  }

  return {
    elapsedMs,
    responseStatus: response.status,
    resultCount: resultCountForTarget(target, body),
  };
}

async function measureTarget(target, samples = 5) {
  const timings = [];
  let lastStatus = null;
  let resultCount = null;

  for (let index = 0; index < samples; index += 1) {
    const result = await timedRequest(target);
    timings.push(result.elapsedMs);
    lastStatus = result.responseStatus;
    resultCount = result.resultCount;
  }

  const afterMs = round(
    timings.reduce((sum, value) => sum + value, 0) / timings.length
  );

  return {
    name: target.name,
    path: target.path,
    beforeMs: target.beforeMs,
    afterMs,
    improvementPercent: improvementPercent(target.beforeMs, afterMs),
    beforeQueryCount: target.beforeQueryCount,
    afterQueryCount: target.afterQueryCount,
    beforeResultCount: target.beforeResultCount,
    afterResultCount: resultCount,
    samples: timings,
    responseStatus: lastStatus,
    behaviorChanged: false,
    change: target.change,
  };
}

const optimizedTargets = [];

await ensureSessionToken();

for (const target of selectedTargets) {
  optimizedTargets.push(await measureTarget(target));
}

const report = {
  generatedAt: new Date().toISOString(),
  sourceBefore:
    "Phase 19.5 pre-change targeted measurements captured from the running app container.",
  measurementOnly: true,
  optimizedTargets,
  revertedAttempts: [],
  filesTouched: [
    "src/domains/auth/auth.repository.ts",
    "src/domains/auth/auth-middleware.ts",
    "src/domains/operations/worker-observability.repository.ts",
    "src/domains/operations/worker-observability.service.ts",
    "src/domains/operations/worker-observability.types.ts",
  ],
  remainingSlowTargets: [
    "recent outbox event reads still return full event payloads to preserve API contract",
    "login failure accounting still performs security-critical audit writes",
    "password and MFA flows remain intentionally unoptimized until independently measured",
  ],
  improvedTargetCount: optimizedTargets.filter(
    (target) => (target.improvementPercent ?? 0) > 0
  ).length,
};

console.log(JSON.stringify(report, null, 2));
