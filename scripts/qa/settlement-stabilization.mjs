import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;

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

function authHeaders(extra = {}) {
  if (!sessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN is required.");
  }

  return {
    authorization: `Bearer ${sessionToken}`,
    ...extra,
  };
}

const unauthenticated = await requestJson(
  "/api/authority/settlement-stabilization-status"
);
assert(
  unauthenticated.response.status === 401,
  "Settlement stabilization endpoint should require authentication.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Settlement stabilization endpoint requires auth.");

const statusResult = await requestJson(
  "/api/authority/settlement-stabilization-status?window=7d",
  {
    headers: authHeaders(),
  }
);
assert(
  statusResult.response.status === 200 && statusResult.body.success,
  "Settlement stabilization endpoint failed.",
  { status: statusResult.response.status, body: statusResult.body }
);

const status = statusResult.body.stabilizationStatus;
assert(status.window === "7d", "Default requested window should be returned.", {
  status,
});
assert(status.authority === "SERVICE", "Settlement authority must remain SERVICE.", {
  status,
});
assert(
  status.comparisonMode === "ENABLED",
  "Settlement comparison mode must remain ENABLED.",
  { status }
);
assert(status.rollbackReadiness === "READY", "Rollback readiness must be READY.", {
  status,
});
assert(
  typeof status.settlementsProcessed === "number" &&
    typeof status.mismatchCount === "number" &&
    typeof status.failureCount === "number" &&
    typeof status.criticalMismatchCount === "number",
  "Stabilization metrics are missing.",
  { status }
);
assert(status.serviceHealth?.available === true, "Settlement Service health failed.", {
  status,
});
assert(
  ["STABILIZING", "STABLE", "REVIEW_REQUIRED", "ROLLBACK_RECOMMENDED"].includes(
    status.stabilizationStatus
  ),
  "Unknown stabilization status.",
  { status }
);
assert(status.recommendation, "Stabilization recommendation missing.", { status });
assert(
  ["NOT_READY", "READY_FOR_CERTIFICATION", "CERTIFIED", "REVIEW_REQUIRED"].includes(
    status.certificationStatus
  ),
  "Unknown certification status.",
  { status }
);
assert(
  Array.isArray(status.certificationBlockers) &&
    Array.isArray(status.certificationWarnings),
  "Certification details missing.",
  { status }
);
pass("Settlement stabilization status generated.", {
  stabilizationStatus: status.stabilizationStatus,
  certificationStatus: status.certificationStatus,
  recommendation: status.recommendation,
  metrics: {
    settlementsProcessed: status.settlementsProcessed,
    mismatchCount: status.mismatchCount,
    failureCount: status.failureCount,
    criticalMismatchCount: status.criticalMismatchCount,
  },
});

const invalidWindow = await requestJson(
  "/api/authority/settlement-stabilization-status?window=bad-window",
  {
    headers: authHeaders(),
  }
);
assert(
  invalidWindow.response.status === 400,
  "Invalid stabilization window should be rejected.",
  { status: invalidWindow.response.status, body: invalidWindow.body }
);
pass("Settlement stabilization validates window input.");

pass("Settlement stabilization QA completed.", {
  stabilizationStatus: status.stabilizationStatus,
  recommendation: status.recommendation,
});
