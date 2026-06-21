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

for (const path of [
  "/api/authority/approval-status",
  "/api/authority/approval-history",
  "/api/authority/dry-run-evaluation",
]) {
  const unauthenticated = await requestJson(path);

  assert(
    unauthenticated.response.status === 401,
    "Authority approval API should require authentication.",
    { path, status: unauthenticated.response.status, body: unauthenticated.body }
  );
}
pass("Protected APIs require auth.");

const [statusResult, historyResult, dryRunResult] = await Promise.all([
  authGet("/api/authority/approval-status"),
  authGet("/api/authority/approval-history?authorityCandidate=SETTLEMENT"),
  authGet("/api/authority/dry-run-evaluation"),
]);

assert(
  statusResult.response.status === 200 && statusResult.body.success,
  "Approval status endpoint failed.",
  { status: statusResult.response.status, body: statusResult.body }
);
assert(
  historyResult.response.status === 200 && historyResult.body.success,
  "Approval history endpoint failed.",
  { status: historyResult.response.status, body: historyResult.body }
);
assert(
  dryRunResult.response.status === 200 && dryRunResult.body.success,
  "Dry-run evaluation endpoint failed.",
  { status: dryRunResult.response.status, body: dryRunResult.body }
);

const approvalStatus = statusResult.body.approvalStatus;
const approvalHistory = historyResult.body.approvalHistory;
const dryRunEvaluation = dryRunResult.body.dryRunEvaluation;

assert(
  approvalStatus.authorityCandidate === "SETTLEMENT",
  "Approval status did not target Settlement.",
  { approvalStatus }
);
assert(
  approvalStatus.currentState === "READY_FOR_REVIEW" ||
    approvalStatus.currentState === "BLOCKED" ||
    approvalStatus.currentState === "READY_FOR_DRY_RUN_APPROVAL" ||
    approvalStatus.currentState === "READY_FOR_PROMOTION_APPROVAL" ||
    approvalStatus.currentState === "READY_FOR_CONTROLLED_PROMOTION",
  "Settlement should be ready for review or blocked by promotion evidence.",
  { approvalStatus }
);
assert(
  approvalStatus.latestApprovals.dryRunApproval === null,
  "Dry-run approval should not exist by default.",
  { approvalStatus }
);
assert(
  approvalStatus.approvalRequirements.includes(
    "DRY_RUN_APPROVAL is required before dry-run activation."
  ),
  "Dry-run approval requirement missing.",
  { approvalStatus }
);
assert(
  Array.isArray(approvalHistory.approvals),
  "Approval history should return an immutable append-only list.",
  { approvalHistory }
);
pass("Approval states and history are reported.");

assert(
  dryRunEvaluation.authorityCandidate === "SETTLEMENT",
  "Dry-run evaluation did not target Settlement.",
  { dryRunEvaluation }
);
assert(
  dryRunEvaluation.currentState === approvalStatus.currentState,
  "Dry-run evaluation state differs from approval status.",
  { dryRunEvaluation, approvalStatus }
);
assert(
  typeof dryRunEvaluation.ifServiceBecameAuthoritativeNow
    .wouldRollbackTrigger === "boolean",
  "Dry-run rollback trigger evaluation missing.",
  { dryRunEvaluation }
);
assert(
  dryRunEvaluation.ifServiceBecameAuthoritativeNow.wouldPromotionBeAllowed ===
    false,
  "Dry-run evaluation must not allow promotion without approvals.",
  { dryRunEvaluation }
);
pass("Dry-run evaluation reports promotion and rollback conditions.", {
  currentState: dryRunEvaluation.currentState,
  evaluation: dryRunEvaluation.ifServiceBecameAuthoritativeNow,
});

const mutationAttempt = await requestJson("/api/authority/approval-status", {
  method: "POST",
  headers: {
    authorization: `Bearer ${sessionToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    approvalType: "DRY_RUN_APPROVAL",
    justification: "QA should not be able to create approval through read API.",
  }),
});
assert(
  mutationAttempt.response.status !== 200 && mutationAttempt.response.status !== 201,
  "Approval APIs must remain read-only.",
  { status: mutationAttempt.response.status, body: mutationAttempt.body }
);
pass("Approval APIs are read-only.");

pass("Settlement authority dry-run QA completed.", {
  currentState: approvalStatus.currentState,
  recommendedState: approvalStatus.recommendedState,
  promotionBlockers: approvalStatus.promotionBlockers,
  dryRun: dryRunEvaluation.ifServiceBecameAuthoritativeNow,
});
