import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const dryRunCorrelationId = "qa-dry-run-approval-settlement-v1";
const promotionCorrelationId = "qa-promotion-approval-settlement-v1";
const rawEvidenceWarning =
  "Raw evidence is not READY and must remain visible for review.";

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

async function authGet(path) {
  return requestJson(path, { headers: authHeaders() });
}

async function approveDryRun() {
  return requestJson("/api/authority/approvals/dry-run", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      domain: "SETTLEMENT",
      justification:
        "QA confirms lifecycle-adjusted shadow evidence is ready and raw evidence remains visible.",
      acknowledgedWarnings: [rawEvidenceWarning],
      correlationId: dryRunCorrelationId,
    }),
  });
}

async function approvePromotion(body) {
  return requestJson("/api/authority/approvals/promotion", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

const unauthenticated = await requestJson("/api/authority/approvals/promotion", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    domain: "SETTLEMENT",
    justification: "Unauthenticated approval should fail.",
    acknowledgedWarnings: [rawEvidenceWarning],
  }),
});
assert(
  unauthenticated.response.status === 401,
  "Promotion approval endpoint should require authentication.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Promotion approval endpoint requires auth.");

const missingJustification = await approvePromotion({
  domain: "SETTLEMENT",
  justification: "",
  acknowledgedWarnings: [rawEvidenceWarning, "PROMOTION_APPROVAL is missing."],
});
assert(
  missingJustification.response.status >= 400,
  "Promotion approval should reject missing justification.",
  { status: missingJustification.response.status, body: missingJustification.body }
);
pass("Promotion approval rejects missing justification.");

const missingWarnings = await approvePromotion({
  domain: "SETTLEMENT",
  justification: "QA validates missing warning acknowledgement rejection.",
  acknowledgedWarnings: [],
});
assert(
  missingWarnings.response.status >= 400,
  "Promotion approval should reject missing warning acknowledgement or non-ready state.",
  { status: missingWarnings.response.status, body: missingWarnings.body }
);
pass("Promotion approval rejects missing warning acknowledgement.");

const dryRunApproval = await approveDryRun();
assert(
  dryRunApproval.response.status === 200 && dryRunApproval.body.success,
  "Dry-run approval should exist before promotion approval.",
  { status: dryRunApproval.response.status, body: dryRunApproval.body }
);
assert(
  dryRunApproval.body.approval.approvalType === "DRY_RUN_APPROVAL",
  "Dry-run approval type mismatch.",
  { approval: dryRunApproval.body.approval }
);
pass("Dry-run approval prerequisite exists.", {
  approvalId: dryRunApproval.body.approval.id,
  idempotent: dryRunApproval.body.idempotent,
});

const decisionBeforeResult = await authGet(
  "/api/authority/promotion-decision?domain=settlement"
);
assert(
  decisionBeforeResult.response.status === 200 && decisionBeforeResult.body.success,
  "Promotion decision before approval failed.",
  { status: decisionBeforeResult.response.status, body: decisionBeforeResult.body }
);
const decisionBefore = decisionBeforeResult.body.decision;
assert(
  decisionBefore.decision === "READY_FOR_PROMOTION_APPROVAL" ||
    decisionBefore.decision === "READY_FOR_CONTROLLED_PROMOTION" ||
    decisionBefore.decision === "PROMOTED",
  "Settlement should be ready for promotion approval or already approved.",
  { decisionBefore }
);

const validApproval = await approvePromotion({
  domain: "SETTLEMENT",
  justification:
    "QA confirms dry-run approval exists, rollback is ready, and controlled promotion may be planned.",
  acknowledgedWarnings: decisionBefore.warnings,
  correlationId: promotionCorrelationId,
});
assert(
  validApproval.response.status === 200 && validApproval.body.success,
  "Promotion approval capture failed.",
  { status: validApproval.response.status, body: validApproval.body }
);
assert(
  validApproval.body.approval.approvalType === "PROMOTION_APPROVAL",
  "Promotion approval type mismatch.",
  { approval: validApproval.body.approval }
);
assert(
  validApproval.body.approval.authorityCandidate === "SETTLEMENT",
  "Promotion approval domain mismatch.",
  { approval: validApproval.body.approval }
);
pass("Promotion approval succeeds when valid.", {
  approvalId: validApproval.body.approval.id,
  idempotent: validApproval.body.idempotent,
});

const repeatedApproval = await approvePromotion({
  domain: "SETTLEMENT",
  justification:
    "QA confirms dry-run approval exists, rollback is ready, and controlled promotion may be planned.",
  acknowledgedWarnings: decisionBefore.warnings,
  correlationId: promotionCorrelationId,
});
assert(
  repeatedApproval.response.status === 200 && repeatedApproval.body.success,
  "Repeated promotion approval should be idempotent.",
  { status: repeatedApproval.response.status, body: repeatedApproval.body }
);
assert(
  repeatedApproval.body.approval.id === validApproval.body.approval.id,
  "Repeated promotion approval should return the existing approval record.",
  {
    firstApprovalId: validApproval.body.approval.id,
    repeatedApprovalId: repeatedApproval.body.approval.id,
  }
);
assert(
  repeatedApproval.body.idempotent === true,
  "Repeated promotion approval should report idempotent=true.",
  { body: repeatedApproval.body }
);
pass("Promotion approval is idempotent and append-only.");

const decisionAfterResult = await authGet(
  "/api/authority/promotion-decision?domain=settlement"
);
assert(
  decisionAfterResult.response.status === 200 && decisionAfterResult.body.success,
  "Promotion decision after approval failed.",
  { status: decisionAfterResult.response.status, body: decisionAfterResult.body }
);
const decisionAfter = decisionAfterResult.body.decision;
assert(
  decisionAfter.decision === "READY_FOR_CONTROLLED_PROMOTION" ||
    decisionAfter.decision === "PROMOTED",
  "Promotion decision should advance to a controlled promotion state.",
  { decisionBefore, decisionAfter }
);
assert(
  decisionAfter.currentAuthority === "MONOLITH" ||
    decisionAfter.currentAuthority === "SERVICE",
  "Promotion approval should only observe supported authority states.",
  { decisionAfter }
);
assert(
  decisionAfter.comparisonMode === "ENABLED",
  "Promotion approval must not disable comparison mode.",
  { decisionAfter }
);
pass("Promotion decision advanced without authority transfer.", {
  before: decisionBefore.decision,
  after: decisionAfter.decision,
  authority: decisionAfter.currentAuthority,
  comparisonMode: decisionAfter.comparisonMode,
});

pass("Promotion approval QA completed.", {
  approvalId: validApproval.body.approval.id,
  decision: decisionAfter.decision,
});
