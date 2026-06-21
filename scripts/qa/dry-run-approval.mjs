import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const correlationId = "qa-dry-run-approval-settlement-v1";
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

async function approve(body) {
  return requestJson("/api/authority/approvals/dry-run", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

const unauthenticated = await requestJson("/api/authority/approvals/dry-run", {
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
  "Dry-run approval endpoint should require authentication.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Dry-run approval endpoint requires auth.");

const decisionBeforeResult = await authGet(
  "/api/authority/promotion-decision?domain=settlement"
);
assert(
  decisionBeforeResult.response.status === 200 && decisionBeforeResult.body.success,
  "Promotion decision before approval failed.",
  { status: decisionBeforeResult.response.status, body: decisionBeforeResult.body }
);
const decisionBefore = decisionBeforeResult.body.decision;

const missingJustification = await approve({
  domain: "SETTLEMENT",
  justification: "",
  acknowledgedWarnings: [rawEvidenceWarning],
});
assert(
  missingJustification.response.status >= 400,
  "Dry-run approval should reject missing justification.",
  { status: missingJustification.response.status, body: missingJustification.body }
);
pass("Dry-run approval rejects missing justification.");

const missingWarningAcknowledgement = await approve({
  domain: "SETTLEMENT",
  justification: "QA validates missing warning acknowledgement rejection.",
  acknowledgedWarnings: [],
});
assert(
  missingWarningAcknowledgement.response.status >= 400,
  "Dry-run approval should reject missing warning acknowledgement or non-ready state.",
  {
    status: missingWarningAcknowledgement.response.status,
    body: missingWarningAcknowledgement.body,
  }
);
pass("Dry-run approval rejects missing warning acknowledgement.");

const validApproval = await approve({
  domain: "SETTLEMENT",
  justification:
    "QA confirms lifecycle-adjusted shadow evidence is ready and raw evidence remains visible.",
  acknowledgedWarnings: [rawEvidenceWarning],
  correlationId,
});
assert(
  validApproval.response.status === 200 && validApproval.body.success,
  "Dry-run approval capture failed.",
  { status: validApproval.response.status, body: validApproval.body }
);
assert(
  validApproval.body.approval.approvalType === "DRY_RUN_APPROVAL",
  "Approval type mismatch.",
  { approval: validApproval.body.approval }
);
assert(
  validApproval.body.approval.authorityCandidate === "SETTLEMENT",
  "Approval domain mismatch.",
  { approval: validApproval.body.approval }
);
pass("Dry-run approval succeeds when valid.", {
  approvalId: validApproval.body.approval.id,
  idempotent: validApproval.body.idempotent,
});

const repeatedApproval = await approve({
  domain: "SETTLEMENT",
  justification:
    "QA confirms lifecycle-adjusted shadow evidence is ready and raw evidence remains visible.",
  acknowledgedWarnings: [rawEvidenceWarning],
  correlationId,
});
assert(
  repeatedApproval.response.status === 200 && repeatedApproval.body.success,
  "Repeated dry-run approval should be idempotent.",
  { status: repeatedApproval.response.status, body: repeatedApproval.body }
);
assert(
  repeatedApproval.body.approval.id === validApproval.body.approval.id,
  "Repeated dry-run approval should return the existing approval record.",
  {
    firstApprovalId: validApproval.body.approval.id,
    repeatedApprovalId: repeatedApproval.body.approval.id,
  }
);
assert(
  repeatedApproval.body.idempotent === true,
  "Repeated dry-run approval should report idempotent=true.",
  { body: repeatedApproval.body }
);
pass("Dry-run approval is idempotent and append-only.");

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
  decisionAfter.decision === "READY_FOR_PROMOTION_APPROVAL" ||
    decisionAfter.decision === "READY_FOR_CONTROLLED_PROMOTION" ||
    decisionAfter.decision === "PROMOTED",
  "Promotion decision should advance to an approval-ready state.",
  { decisionBefore, decisionAfter }
);
assert(
  decisionAfter.currentAuthority === "MONOLITH" ||
    decisionAfter.currentAuthority === "SERVICE",
  "Dry-run approval should only observe supported authority states.",
  { decisionAfter }
);
assert(
  decisionAfter.comparisonMode === "ENABLED",
  "Dry-run approval must not disable comparison mode.",
  { decisionAfter }
);
pass("Promotion decision advanced without authority transfer.", {
  before: decisionBefore.decision,
  after: decisionAfter.decision,
  authority: decisionAfter.currentAuthority,
  comparisonMode: decisionAfter.comparisonMode,
});

pass("Dry-run approval QA completed.", {
  approvalId: validApproval.body.approval.id,
  decision: decisionAfter.decision,
});
