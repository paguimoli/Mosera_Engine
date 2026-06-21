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

async function authGet(path) {
  if (!sessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN is required.");
  }

  return requestJson(path, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}

const unauthenticated = await requestJson("/api/authority/promotion-decision?domain=settlement");
assert(
  unauthenticated.response.status === 401,
  "Promotion decision endpoint should require authentication.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Promotion decision endpoint requires auth.");

const [decisionResult, dryRunResult] = await Promise.all([
  authGet("/api/authority/promotion-decision?domain=settlement"),
  authGet("/api/authority/dry-run-evaluation"),
]);

assert(
  decisionResult.response.status === 200 && decisionResult.body.success,
  "Promotion decision endpoint failed.",
  { status: decisionResult.response.status, body: decisionResult.body }
);
assert(
  dryRunResult.response.status === 200 && dryRunResult.body.success,
  "Dry-run evaluation endpoint failed.",
  { status: dryRunResult.response.status, body: dryRunResult.body }
);

const decision = decisionResult.body.decision;
const dryRun = dryRunResult.body.dryRunEvaluation;

assert(decision.domain === "SETTLEMENT", "Promotion decision domain mismatch.", {
  decision,
});
assert(
  decision.currentAuthority === "MONOLITH",
  "Promotion decision must not transfer authority.",
  { decision }
);
assert(
  decision.comparisonMode === "ENABLED",
  "Settlement comparison mode should remain enabled.",
  { decision }
);
assert(decision.rollbackReadiness, "Rollback readiness missing.", { decision });
assert(decision.approvalState, "Approval state missing.", { decision });
pass("Promotion decision includes unified inputs.", {
  decision: decision.decision,
  rollbackReadiness: decision.rollbackReadiness,
});

if (decision.promotionReadiness.readiness === "READY") {
  assert(
    decision.rawReadiness.readiness !== "READY" ||
      !decision.blockingReasons.some((reason) => reason.includes("Raw evidence")),
    "Raw blocked evidence should not block lifecycle promotion readiness.",
    { decision }
  );
  assert(
    decision.decision === "READY_FOR_DRY_RUN_APPROVAL" ||
      decision.decision === "READY_FOR_PROMOTION_APPROVAL" ||
      decision.decision === "READY_FOR_CONTROLLED_PROMOTION",
    "Promotion-ready evidence should advance to an approval state.",
    { decision }
  );
} else {
  assert(
    decision.blockingReasons.some((reason) =>
      reason.includes("Promotion evidence")
    ),
    "Promotion evidence that is not ready should be the blocker.",
    { decision }
  );
}
pass("Decision uses lifecycle-adjusted promotion evidence.", {
  raw: decision.rawReadiness,
  promotion: decision.promotionReadiness,
  blockers: decision.blockingReasons,
});

assert(
  dryRun.currentState === decision.decision,
  "Settlement dry-run evaluation contradicts promotion decision.",
  { dryRun, decision }
);
assert(
  dryRun.promotionEvidence.readiness === decision.promotionReadiness.readiness,
  "Dry-run promotion evidence does not match promotion decision.",
  { dryRun, decision }
);
pass("Dry-run evaluation matches promotion decision engine.", {
  dryRun: dryRun.ifServiceBecameAuthoritativeNow,
});

pass("Promotion decision QA completed.", {
  decision: decision.decision,
  blockers: decision.blockingReasons,
  warnings: decision.warnings,
});
