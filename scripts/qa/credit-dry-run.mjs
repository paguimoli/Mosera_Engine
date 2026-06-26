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

const unauthenticated = await requestJson("/api/authority/credit-dry-run-evaluation", false);
assert(unauthenticated.response.status === 401, "Credit dry-run should require auth.", {
  status: unauthenticated.response.status,
});
pass("Credit dry-run endpoint requires auth.");

if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN is required.");

const result = await requestJson("/api/authority/credit-dry-run-evaluation");
assert(result.response.status === 200 && result.body.success, "Credit dry-run evaluation failed.", {
  status: result.response.status,
  body: result.body,
});
const dryRun = result.body.dryRunEvaluation;

assert(dryRun.authorityCandidate === "CREDIT", "Credit dry-run domain mismatch.", { dryRun });
assert(
  dryRun.currentState === "READY_FOR_DRY_RUN_APPROVAL" ||
    dryRun.currentState === "READY_FOR_PROMOTION_APPROVAL",
  "Credit dry-run state mismatch.",
  { dryRun }
);
assert(typeof dryRun.ifServiceBecameAuthoritativeNow.wouldRollbackTrigger === "boolean", "Dry-run rollback trigger missing.", {
  dryRun,
});
assert(dryRun.promotionEvidence.readiness === "READY", "Credit promotion evidence must be READY.", {
  dryRun,
});
assert(dryRun.rollbackReadiness === "READY", "Credit rollback readiness must be READY.", {
  dryRun,
});
assert(Array.isArray(dryRun.approvalRequirements), "Approval requirements missing.", { dryRun });

pass("Credit dry-run evaluation is advisory-only.", {
  currentState: dryRun.currentState,
  evaluation: dryRun.ifServiceBecameAuthoritativeNow,
  approvalRequirements: dryRun.approvalRequirements,
  postPromotionEvidence: dryRun.postPromotionEvidence,
});
