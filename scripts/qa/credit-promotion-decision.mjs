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

async function requestJson(path, authenticated = true) {
  const response = await fetch(`${appUrl}${path}`, {
    headers: authenticated && sessionToken ? { authorization: `Bearer ${sessionToken}` } : {},
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

const unauthenticated = await requestJson("/api/authority/promotion-decision?domain=credit", false);
assert(unauthenticated.response.status === 401, "Credit promotion decision should require auth.", {
  status: unauthenticated.response.status,
});
pass("Credit promotion decision endpoint requires auth.");

if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN is required.");

const result = await requestJson("/api/authority/promotion-decision?domain=credit");
assert(result.response.status === 200 && result.body.success, "Credit promotion decision failed.", {
  status: result.response.status,
  body: result.body,
});
const decision = result.body.decision;

assert(decision.domain === "CREDIT", "Credit promotion decision domain mismatch.", { decision });
assert(decision.currentAuthority === "MONOLITH", "Credit authority must remain MONOLITH.", {
  decision,
});
assert(decision.comparisonMode === "ENABLED", "Credit comparison must remain ENABLED.", {
  decision,
});
assert(
  decision.decision === "READY_FOR_DRY_RUN_APPROVAL" ||
    decision.decision === "READY_FOR_PROMOTION_APPROVAL",
  "Credit decision should be ready for dry-run approval or promotion approval.",
  { decision }
);
assert(decision.promotionReadiness.readiness === "READY", "Credit promotion evidence should be READY.", {
  decision,
});
assert(decision.rollbackReadiness === "READY", "Credit rollback readiness should be READY.", {
  decision,
});

pass("Credit promotion decision is ready for the next operator approval step.", {
  decision: decision.decision,
  authority: decision.currentAuthority,
  raw: decision.rawReadiness,
  promotion: decision.promotionReadiness,
  blockers: decision.blockingReasons,
  warnings: decision.warnings,
});
