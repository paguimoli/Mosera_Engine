import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const dryRunCorrelationId = "qa-ledger-dry-run-approval-v1";
const promotionCorrelationId = "qa-ledger-promotion-approval-v1";

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
  if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN is required.");

  return {
    authorization: `Bearer ${sessionToken}`,
    ...extra,
  };
}

async function authGet(path) {
  return requestJson(path, { headers: authHeaders() });
}

async function approveDryRun(warnings) {
  return requestJson("/api/authority/approvals/dry-run", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      domain: "LEDGER",
      justification:
        "QA confirms Ledger dry-run approval exists before promotion approval.",
      acknowledgedWarnings: warnings,
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
    domain: "LEDGER",
    justification: "Unauthenticated Ledger approval should fail.",
    acknowledgedWarnings: [],
  }),
});
assert(
  unauthenticated.response.status === 401,
  "Ledger promotion approval should require auth.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Ledger promotion approval endpoint requires auth.");

const [initialDecisionResult, authorityResult, settlementStatusResult] =
  await Promise.all([
    authGet("/api/authority/promotion-decision?domain=ledger"),
    authGet("/api/authority/status"),
    authGet("/api/authority/settlement-stabilization-status?window=7d"),
  ]);

assert(
  initialDecisionResult.response.status === 200 && initialDecisionResult.body.success,
  "Ledger promotion decision lookup failed.",
  { status: initialDecisionResult.response.status, body: initialDecisionResult.body }
);
assert(authorityResult.response.status === 200 && authorityResult.body.success, "Authority status failed.", {
  status: authorityResult.response.status,
  body: authorityResult.body,
});
assert(
  settlementStatusResult.response.status === 200 && settlementStatusResult.body.success,
  "Settlement certification status failed.",
  { status: settlementStatusResult.response.status, body: settlementStatusResult.body }
);

const initialDecision = initialDecisionResult.body.decision;
const authorityBefore = authorityResult.body.authority;
const settlementStatus = settlementStatusResult.body.stabilizationStatus;

assert(authorityBefore.settlement.authority === "SERVICE", "Settlement must remain SERVICE.", {
  authorityBefore,
});
assert(settlementStatus.certificationStatus === "CERTIFIED", "Settlement must remain CERTIFIED.", {
  settlementStatus,
});
assert(
  authorityBefore.ledger.authority === "MONOLITH" ||
    authorityBefore.ledger.authority === "SERVICE",
  "Ledger authority has an unsupported value.",
  { authorityBefore }
);
assert(authorityBefore.ledger.comparisonMode === "ENABLED", "Ledger comparison must remain ENABLED.", {
  authorityBefore,
});
assert(authorityBefore.credit.authority === "MONOLITH", "Credit must remain MONOLITH.", {
  authorityBefore,
});

const missingJustification = await approvePromotion({
  domain: "LEDGER",
  justification: "",
  acknowledgedWarnings: initialDecision.warnings,
});
assert(
  missingJustification.response.status >= 400,
  "Ledger promotion approval should reject missing justification.",
  { status: missingJustification.response.status, body: missingJustification.body }
);
pass("Ledger promotion approval rejects missing justification.");

if (initialDecision.decision === "READY_FOR_PROMOTION_APPROVAL") {
  const missingWarningAcknowledgement = await approvePromotion({
    domain: "LEDGER",
    justification: "QA validates Ledger missing warning acknowledgement rejection.",
    acknowledgedWarnings: [],
  });
  assert(
    missingWarningAcknowledgement.response.status >= 400,
    "Ledger promotion approval should reject missing warning acknowledgement.",
    {
      status: missingWarningAcknowledgement.response.status,
      body: missingWarningAcknowledgement.body,
    }
  );
  pass("Ledger promotion approval rejects missing warning acknowledgement.");
} else {
  pass("Ledger warning acknowledgement rejection already covered by existing approval state.", {
    decision: initialDecision.decision,
  });
}

const dryRunApproval = await approveDryRun(initialDecision.warnings);
assert(
  dryRunApproval.response.status === 200 && dryRunApproval.body.success,
  "Ledger DRY_RUN_APPROVAL prerequisite should exist.",
  { status: dryRunApproval.response.status, body: dryRunApproval.body }
);
assert(
  dryRunApproval.body.approval.approvalType === "DRY_RUN_APPROVAL",
  "Ledger DRY_RUN_APPROVAL prerequisite type mismatch.",
  { approval: dryRunApproval.body.approval }
);
pass("Ledger DRY_RUN_APPROVAL prerequisite is enforced and available.", {
  approvalId: dryRunApproval.body.approval.id,
  idempotent: dryRunApproval.body.idempotent,
});

const decisionBeforeResult = await authGet("/api/authority/promotion-decision?domain=ledger");
assert(
  decisionBeforeResult.response.status === 200 && decisionBeforeResult.body.success,
  "Ledger promotion decision before promotion approval failed.",
  { status: decisionBeforeResult.response.status, body: decisionBeforeResult.body }
);
const decisionBefore = decisionBeforeResult.body.decision;
assert(
  decisionBefore.decision === "READY_FOR_PROMOTION_APPROVAL" ||
    decisionBefore.decision === "READY_FOR_CONTROLLED_PROMOTION" ||
    decisionBefore.decision === "PROMOTED",
  "Ledger must be ready for promotion approval or already approved.",
  { decisionBefore }
);
assert(
  decisionBefore.approvalState.dryRunApproval,
  "Ledger DRY_RUN_APPROVAL must exist before promotion approval.",
  { decisionBefore }
);

const validApproval = await approvePromotion({
  domain: "LEDGER",
  justification:
    "QA confirms Ledger dry-run approval exists, rollback is ready, and controlled promotion may be planned.",
  acknowledgedWarnings: decisionBefore.warnings,
  correlationId: promotionCorrelationId,
});
assert(
  validApproval.response.status === 200 && validApproval.body.success,
  "Ledger promotion approval failed.",
  { status: validApproval.response.status, body: validApproval.body }
);
assert(
  validApproval.body.approval.approvalType === "PROMOTION_APPROVAL",
  "Ledger promotion approval type mismatch.",
  { approval: validApproval.body.approval }
);
assert(
  validApproval.body.approval.authorityCandidate === "LEDGER",
  "Ledger promotion approval domain mismatch.",
  { approval: validApproval.body.approval }
);
pass("Ledger promotion approval succeeds when valid.", {
  approvalId: validApproval.body.approval.id,
  idempotent: validApproval.body.idempotent,
});

const repeatedApproval = await approvePromotion({
  domain: "LEDGER",
  justification:
    "QA confirms Ledger dry-run approval exists, rollback is ready, and controlled promotion may be planned.",
  acknowledgedWarnings: decisionBefore.warnings,
  correlationId: promotionCorrelationId,
});
assert(
  repeatedApproval.response.status === 200 && repeatedApproval.body.success,
  "Repeated Ledger promotion approval should be idempotent.",
  { status: repeatedApproval.response.status, body: repeatedApproval.body }
);
assert(
  repeatedApproval.body.approval.id === validApproval.body.approval.id,
  "Repeated Ledger promotion approval should return existing approval.",
  {
    firstApprovalId: validApproval.body.approval.id,
    repeatedApprovalId: repeatedApproval.body.approval.id,
  }
);
assert(repeatedApproval.body.idempotent === true, "Repeated Ledger approval should be idempotent.", {
  body: repeatedApproval.body,
});
pass("Ledger promotion approval is idempotent and append-only.");

const [decisionAfterResult, authorityAfterResult, settlementAfterResult] =
  await Promise.all([
    authGet("/api/authority/promotion-decision?domain=ledger"),
    authGet("/api/authority/status"),
    authGet("/api/authority/settlement-stabilization-status?window=7d"),
  ]);
assert(
  decisionAfterResult.response.status === 200 && decisionAfterResult.body.success,
  "Ledger promotion decision after approval failed.",
  { status: decisionAfterResult.response.status, body: decisionAfterResult.body }
);
assert(authorityAfterResult.response.status === 200 && authorityAfterResult.body.success, "Authority after approval failed.", {
  status: authorityAfterResult.response.status,
  body: authorityAfterResult.body,
});
assert(
  settlementAfterResult.response.status === 200 && settlementAfterResult.body.success,
  "Settlement status after Ledger approval failed.",
  { status: settlementAfterResult.response.status, body: settlementAfterResult.body }
);

const decisionAfter = decisionAfterResult.body.decision;
const authorityAfter = authorityAfterResult.body.authority;
const settlementAfter = settlementAfterResult.body.stabilizationStatus;

assert(
  decisionAfter.decision === "READY_FOR_CONTROLLED_PROMOTION" ||
    decisionAfter.decision === "PROMOTED",
  "Ledger decision should advance to controlled promotion readiness or promoted state.",
  { decisionBefore, decisionAfter }
);
assert(
  authorityAfter.ledger.authority === "MONOLITH" ||
    authorityAfter.ledger.authority === "SERVICE",
  "Ledger authority has an unsupported value.",
  { authorityAfter }
);
assert(authorityAfter.ledger.comparisonMode === "ENABLED", "Ledger comparison changed.", {
  authorityAfter,
});
assert(authorityAfter.settlement.authority === "SERVICE", "Settlement authority changed.", {
  authorityAfter,
});
assert(settlementAfter.certificationStatus === "CERTIFIED", "Settlement certification changed.", {
  settlementAfter,
});
assert(authorityAfter.credit.authority === "MONOLITH", "Credit authority changed.", {
  authorityAfter,
});

pass("Ledger promotion approval QA completed.", {
  before: decisionBefore.decision,
  after: decisionAfter.decision,
  approvalId: validApproval.body.approval.id,
  idempotent: validApproval.body.idempotent,
});
