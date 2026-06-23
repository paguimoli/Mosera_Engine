import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const correlationId = `qa-settlement-rollback-drill-${Date.now()}`;

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

const protectedPaths = [
  {
    path: "/api/authority/settlement-post-promotion-status",
    method: "GET",
  },
  {
    path: "/api/authority/rollback/drill",
    method: "POST",
    body: { domain: "SETTLEMENT", mode: "SIMULATION" },
  },
];

for (const protectedPath of protectedPaths) {
  const unauthenticated = await requestJson(protectedPath.path, {
    method: protectedPath.method,
    headers:
      protectedPath.method === "POST"
        ? { "content-type": "application/json" }
        : undefined,
    body: protectedPath.body ? JSON.stringify(protectedPath.body) : undefined,
  });

  assert(
    unauthenticated.response.status === 401,
    "Post-promotion authority API should require authentication.",
    {
      path: protectedPath.path,
      status: unauthenticated.response.status,
      body: unauthenticated.body,
    }
  );
}
pass("Post-promotion monitoring and rollback drill APIs require auth.");

const [authorityBefore, postPromotionStatus] = await Promise.all([
  requestJson("/api/authority/status", { headers: authHeaders() }),
  requestJson("/api/authority/settlement-post-promotion-status", {
    headers: authHeaders(),
  }),
]);

assert(
  authorityBefore.response.status === 200 && authorityBefore.body.success,
  "Authority status endpoint failed before rollback drill.",
  { status: authorityBefore.response.status, body: authorityBefore.body }
);
const authority = authorityBefore.body.authority;
assert(authority.settlement.authority === "SERVICE", "Settlement must be SERVICE.", {
  authority,
});
assert(
  authority.settlement.comparisonMode === "ENABLED",
  "Settlement comparison mode must remain ENABLED.",
  { authority }
);
assert(
  authority.ledger.authority === "MONOLITH" || authority.ledger.authority === "SERVICE",
  "Ledger authority has an unsupported value.",
  { authority }
);
assert(authority.credit.authority === "MONOLITH", "Credit authority changed.", {
  authority,
});
pass("Authority state is post-promotion safe.", {
  settlement: authority.settlement.authority,
  ledger: authority.ledger.authority,
  credit: authority.credit.authority,
});

assert(
  postPromotionStatus.response.status === 200 &&
    postPromotionStatus.body.success,
  "Post-promotion status endpoint failed.",
  {
    status: postPromotionStatus.response.status,
    body: postPromotionStatus.body,
  }
);
const monitoring = postPromotionStatus.body.postPromotionStatus;
assert(monitoring.authority === "SERVICE", "Monitoring authority mismatch.", {
  monitoring,
});
assert(
  monitoring.comparisonMode === "ENABLED",
  "Monitoring comparison mode mismatch.",
  { monitoring }
);
assert(monitoring.promotedAt, "Promotion timestamp missing.", { monitoring });
assert(
  monitoring.serviceHealth.available === true,
  "Settlement Service health should be available.",
  { monitoring }
);
assert(
  monitoring.rollbackReadiness === "READY",
  "Rollback readiness should be READY.",
  { monitoring }
);
assert(
  typeof monitoring.postPromotionMismatchCount === "number" &&
    typeof monitoring.postPromotionFailureCount === "number",
  "Post-promotion counts missing.",
  { monitoring }
);
assert(monitoring.recommendation, "Monitoring recommendation missing.", {
  monitoring,
});
pass("Post-promotion monitoring endpoint reports required controls.", {
  promotedAt: monitoring.promotedAt,
  mismatchCount: monitoring.postPromotionMismatchCount,
  failureCount: monitoring.postPromotionFailureCount,
  recommendation: monitoring.recommendation,
});

const drill = await requestJson("/api/authority/rollback/drill", {
  method: "POST",
  headers: authHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({
    domain: "SETTLEMENT",
    mode: "SIMULATION",
    correlationId,
  }),
});
assert(
  drill.response.status === 200 && drill.body.success,
  "Rollback drill simulation failed.",
  { status: drill.response.status, body: drill.body }
);
const drillResult = drill.body.drill;
assert(drillResult.drillPassed === true, "Rollback drill should pass.", {
  drill: drillResult,
});
assert(
  drillResult.authorityBefore === "SERVICE" &&
    drillResult.authorityAfter === "SERVICE",
  "Rollback drill must not change authority.",
  { drill: drillResult }
);
assert(
  drillResult.authorityChanged === false,
  "Rollback drill reported authority mutation.",
  { drill: drillResult }
);
assert(
  drillResult.auditEvent?.eventType === "authority.rollback.drill.simulated",
  "Rollback drill outbox event missing.",
  { drill: drillResult }
);
pass("Rollback drill simulation passed without authority change.", {
  auditEvent: drillResult.auditEvent,
});

const authorityAfter = await requestJson("/api/authority/status", {
  headers: authHeaders(),
});
assert(
  authorityAfter.response.status === 200 && authorityAfter.body.success,
  "Authority status endpoint failed after rollback drill.",
  { status: authorityAfter.response.status, body: authorityAfter.body }
);
assert(
  authorityAfter.body.authority.settlement.authority === "SERVICE" &&
    authorityAfter.body.authority.settlement.comparisonMode === "ENABLED" &&
    (authorityAfter.body.authority.ledger.authority === "MONOLITH" ||
      authorityAfter.body.authority.ledger.authority === "SERVICE") &&
    authorityAfter.body.authority.ledger.comparisonMode === "ENABLED" &&
    authorityAfter.body.authority.credit.authority === "MONOLITH",
  "Rollback drill changed authority controls.",
  { authority: authorityAfter.body.authority }
);
pass("Rollback drill left authority controls unchanged.", {
  settlement: authorityAfter.body.authority.settlement.authority,
  comparisonMode: authorityAfter.body.authority.settlement.comparisonMode,
});

pass("Settlement post-promotion QA completed.", {
  correlationId,
  recommendation: monitoring.recommendation,
});
