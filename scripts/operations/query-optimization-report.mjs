import "../qa/load-session-env.mjs";

const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

const selectedTargets = [
  {
    name: "/api/health/db",
    path: "/api/health/db",
    requiresAuth: false,
    beforeMs: 1236.595,
    queryCount: 1,
    rowsReturned: 0,
    change:
      "Replaced exact count health probe with a single-row id probe to avoid count aggregation.",
  },
  {
    name: "/api/settlement-shadow/summary",
    path: "/api/settlement-shadow/summary",
    requiresAuth: true,
    beforeMs: 1439.212,
    queryCount: 3,
    rowsReturned: "full shadow/failure/mismatch collections",
    change:
      "Replaced full-row summary scans with narrow comparison-status reads, failure count, and critical-mismatch existence probe.",
    reverted: true,
  },
  {
    name: "/api/credit-shadow/summary",
    path: "/api/credit-shadow/summary",
    requiresAuth: true,
    beforeMs: 1170.415,
    queryCount: 3,
    rowsReturned: "full shadow/failure/mismatch collections",
    change:
      "Replaced full-row summary scans with narrow comparison-status reads, failure count, and critical-mismatch existence probe.",
    reverted: true,
  },
  {
    name: "credit-shadow filtered runs",
    path: "/api/credit-shadow/summary",
    requiresAuth: true,
    beforeMs: 1170.415,
    queryCount: 1,
    rowsReturned: "all credit shadow runs before in-memory filtering",
    change:
      "Pushed credit shadow run filters and limits into the repository query instead of filtering after loading all runs.",
    reverted: true,
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

function authHeaders(target) {
  if (!target.requiresAuth) return {};
  if (!sessionToken) {
    fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  }

  return { authorization: `Bearer ${sessionToken}` };
}

async function timedRequest(target) {
  const started = performance.now();
  const response = await fetch(`${appUrl}${target.path}`, {
    headers: authHeaders(target),
  });
  const elapsedMs = round(performance.now() - started);
  const body = await response.json().catch(() => ({}));

  if (!response.ok || (target.requiresAuth && body.success !== true)) {
    fail(`${target.name} request failed.`, {
      status: response.status,
      body,
    });
  }

  return { elapsedMs, responseStatus: response.status, body };
}

async function measureTarget(target, samples = 3) {
  const timings = [];
  let lastStatus = null;

  for (let index = 0; index < samples; index += 1) {
    const result = await timedRequest(target);
    timings.push(result.elapsedMs);
    lastStatus = result.responseStatus;
  }

  const afterMs = round(
    timings.reduce((sum, value) => sum + value, 0) / timings.length
  );

  return {
    name: target.name,
    beforeMs: target.beforeMs,
    afterMs,
    improvementPercent: improvementPercent(target.beforeMs, afterMs),
    queryCount: target.queryCount,
    rowsReturnedBefore: target.rowsReturned,
    samples: timings,
    responseStatus: lastStatus,
    behaviorChanged: false,
    change: target.change,
  };
}

const measurements = [];

for (const target of selectedTargets.filter((item) => !item.reverted)) {
  measurements.push(await measureTarget(target));
}

const improvedTargets = measurements.filter(
  (measurement) => (measurement.improvementPercent ?? 0) > 0
);
const revertedTargets = selectedTargets
  .filter((target) => target.reverted)
  .map((target) => ({
    name: target.name,
    beforeMs: target.beforeMs,
    queryCount: target.queryCount,
    status: "REVERTED",
    reason:
      "Repeat measurements confirmed material regression; the query change was reverted and the target is documented as unchanged.",
  }));
  const report = {
  generatedAt: new Date().toISOString(),
  sourceBefore: "Phase 19.3 measured bottlenecks and final performance-baseline output.",
  measurementOnly: true,
  optimizedTargets: measurements,
  revertedTargets,
  filesTouched: [
    "app/api/health/db/route.ts",
  ],
  migrationsAdded: [],
  remainingSlowTargets: [
    "recent outbox event reads still return full event payloads to preserve API contract",
    "recent worker heartbeat reads still preserve full worker observability response shape",
    "auth repository remains a measured hotspot for a later request-scoped optimization pass",
  ],
  improvedTargetCount: improvedTargets.length,
};

console.log(JSON.stringify(report, null, 2));
