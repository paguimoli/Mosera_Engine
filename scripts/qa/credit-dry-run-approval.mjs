import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const correlationId = "qa-credit-dry-run-approval-v1";

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

async function approve(body) {
  return requestJson("/api/authority/approvals/dry-run", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

function dryRunApprovals(history) {
  return history.approvals.filter(
    (approval) =>
      approval.authorityCandidate === "CREDIT" &&
      approval.approvalType === "DRY_RUN_APPROVAL"
  );
}

const unauthenticated = await requestJson("/api/authority/approvals/dry-run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    domain: "CREDIT",
    justification: "Unauthenticated Credit approval should fail.",
    acknowledgedWarnings: [],
  }),
});
assert(unauthenticated.response.status === 401, "Credit dry-run approval should require auth.", {
  status: unauthenticated.response.status,
  body: unauthenticated.body,
});
pass("Credit dry-run approval endpoint requires auth.");

const [
  decisionBeforeResult,
  authorityResult,
  settlementStatusResult,
  ledgerStatusResult,
  historyBeforeResult,
] = await Promise.all([
  authGet("/api/authority/promotion-decision?domain=credit"),
  authGet("/api/authority/status"),
  authGet("/api/authority/settlement-stabilization-status?window=7d"),
  authGet("/api/authority/ledger-stabilization-status"),
  authGet("/api/authority/credit-approval-history"),
]);

assert(
  decisionBeforeResult.response.status === 200 && decisionBeforeResult.body.success,
  "Credit promotion decision before approval failed.",
  { status: decisionBeforeResult.response.status, body: decisionBeforeResult.body }
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
assert(
  ledgerStatusResult.response.status === 200 && ledgerStatusResult.body.success,
  "Ledger certification status failed.",
  { status: ledgerStatusResult.response.status, body: ledgerStatusResult.body }
);
assert(
  historyBeforeResult.response.status === 200 && historyBeforeResult.body.success,
  "Credit approval history before approval failed.",
  { status: historyBeforeResult.response.status, body: historyBeforeResult.body }
);

const decisionBefore = decisionBeforeResult.body.decision;
const authorityBefore = authorityResult.body.authority;
const settlementStatus = settlementStatusResult.body.stabilizationStatus;
const ledgerStatus = ledgerStatusResult.body.stabilizationStatus;
const warningsToAcknowledge = decisionBefore.warnings;
const beforeDryRunApprovals = dryRunApprovals(
  historyBeforeResult.body.approvalHistory
);

assert(decisionBefore.domain === "CREDIT", "Credit decision domain mismatch.", {
  decisionBefore,
});
assert(decisionBefore.currentAuthority === "MONOLITH", "Credit authority must remain MONOLITH before approval.", {
  decisionBefore,
});
assert(decisionBefore.comparisonMode === "ENABLED", "Credit comparison must remain ENABLED before approval.", {
  decisionBefore,
});
assert(decisionBefore.rollbackReadiness === "READY", "Credit rollback readiness must be READY before approval.", {
  decisionBefore,
});
assert(authorityBefore.credit.authority === "MONOLITH", "Credit authority status must remain MONOLITH.", {
  authorityBefore,
});
assert(authorityBefore.credit.comparisonMode === "ENABLED", "Credit comparison status must remain ENABLED.", {
  authorityBefore,
});
assert(authorityBefore.settlement.authority === "SERVICE", "Settlement must remain SERVICE.", {
  authorityBefore,
});
assert(settlementStatus.certificationStatus === "CERTIFIED", "Settlement must remain CERTIFIED.", {
  settlementStatus,
});
assert(authorityBefore.ledger.authority === "SERVICE", "Ledger must remain SERVICE.", {
  authorityBefore,
});
assert(ledgerStatus.certificationStatus === "CERTIFIED", "Ledger must remain CERTIFIED.", {
  ledgerStatus,
});

const missingJustification = await approve({
  domain: "CREDIT",
  justification: "",
  acknowledgedWarnings: warningsToAcknowledge,
});
assert(missingJustification.response.status >= 400, "Credit approval should reject missing justification.", {
  status: missingJustification.response.status,
  body: missingJustification.body,
});
pass("Credit dry-run approval rejects missing justification.");

if (decisionBefore.decision === "READY_FOR_DRY_RUN_APPROVAL") {
  const missingWarningAcknowledgement = await approve({
    domain: "CREDIT",
    justification: "QA validates Credit missing warning acknowledgement rejection.",
    acknowledgedWarnings: [],
  });
  assert(
    missingWarningAcknowledgement.response.status >= 400,
    "Credit approval should reject missing warning acknowledgement.",
    {
      status: missingWarningAcknowledgement.response.status,
      body: missingWarningAcknowledgement.body,
    }
  );
  pass("Credit dry-run approval rejects missing warning acknowledgement.");
} else {
  assert(
    decisionBefore.decision === "READY_FOR_PROMOTION_APPROVAL",
    "Credit decision must be ready for dry-run approval or already approved.",
    { decisionBefore }
  );
  pass("Credit warning acknowledgement rejection already covered by existing approval state.", {
    decision: decisionBefore.decision,
  });
}

const validApproval = await approve({
  domain: "CREDIT",
  justification:
    "QA confirms Credit lifecycle-adjusted shadow evidence is ready and raw evidence remains visible.",
  acknowledgedWarnings: warningsToAcknowledge,
  correlationId,
});
assert(validApproval.response.status === 200 && validApproval.body.success, "Credit dry-run approval failed.", {
  status: validApproval.response.status,
  body: validApproval.body,
});
assert(validApproval.body.approval.approvalType === "DRY_RUN_APPROVAL", "Approval type mismatch.", {
  approval: validApproval.body.approval,
});
assert(validApproval.body.approval.authorityCandidate === "CREDIT", "Approval domain mismatch.", {
  approval: validApproval.body.approval,
});
pass("Credit dry-run approval succeeds when valid.", {
  approvalId: validApproval.body.approval.id,
  idempotent: validApproval.body.idempotent,
});

const repeatedApproval = await approve({
  domain: "CREDIT",
  justification:
    "QA confirms Credit lifecycle-adjusted shadow evidence is ready and raw evidence remains visible.",
  acknowledgedWarnings: warningsToAcknowledge,
  correlationId,
});
assert(
  repeatedApproval.response.status === 200 && repeatedApproval.body.success,
  "Repeated Credit dry-run approval should be idempotent.",
  { status: repeatedApproval.response.status, body: repeatedApproval.body }
);
assert(
  repeatedApproval.body.approval.id === validApproval.body.approval.id,
  "Repeated Credit dry-run approval should return existing approval.",
  {
    firstApprovalId: validApproval.body.approval.id,
    repeatedApprovalId: repeatedApproval.body.approval.id,
  }
);
assert(repeatedApproval.body.idempotent === true, "Repeated approval should be idempotent.", {
  body: repeatedApproval.body,
});

const historyAfterIdempotentResult = await authGet(
  "/api/authority/credit-approval-history"
);
assert(
  historyAfterIdempotentResult.response.status === 200 &&
    historyAfterIdempotentResult.body.success,
  "Credit approval history after idempotent approval failed.",
  {
    status: historyAfterIdempotentResult.response.status,
    body: historyAfterIdempotentResult.body,
  }
);
const afterDryRunApprovals = dryRunApprovals(
  historyAfterIdempotentResult.body.approvalHistory
);
const matchingApprovals = afterDryRunApprovals.filter(
  (approval) => approval.id === validApproval.body.approval.id
);
assert(matchingApprovals.length === 1, "Credit dry-run approval should be append-only and not duplicated.", {
  approvalId: validApproval.body.approval.id,
  beforeCount: beforeDryRunApprovals.length,
  afterCount: afterDryRunApprovals.length,
});
pass("Credit dry-run approval is idempotent and append-only.");

const [decisionAfterResult, authorityAfterResult, statusAfterResult] =
  await Promise.all([
    authGet("/api/authority/promotion-decision?domain=credit"),
    authGet("/api/authority/status"),
    authGet("/api/authority/credit-approval-status"),
  ]);
assert(
  decisionAfterResult.response.status === 200 && decisionAfterResult.body.success,
  "Credit promotion decision after approval failed.",
  { status: decisionAfterResult.response.status, body: decisionAfterResult.body }
);
assert(authorityAfterResult.response.status === 200 && authorityAfterResult.body.success, "Authority status after approval failed.", {
  status: authorityAfterResult.response.status,
  body: authorityAfterResult.body,
});
assert(statusAfterResult.response.status === 200 && statusAfterResult.body.success, "Credit approval status after approval failed.", {
  status: statusAfterResult.response.status,
  body: statusAfterResult.body,
});

const decisionAfter = decisionAfterResult.body.decision;
const authorityAfter = authorityAfterResult.body.authority;
const approvalStatus = statusAfterResult.body.approvalStatus;

assert(
  decisionAfter.decision === "READY_FOR_PROMOTION_APPROVAL",
  "Credit decision should advance to READY_FOR_PROMOTION_APPROVAL.",
  { decisionBefore, decisionAfter }
);
assert(
  approvalStatus.latestApprovals.dryRunApproval?.id === validApproval.body.approval.id,
  "Credit approval status should expose the dry-run approval.",
  { approvalStatus, approvalId: validApproval.body.approval.id }
);
assert(authorityAfter.credit.authority === "MONOLITH", "Credit authority changed.", {
  authorityAfter,
});
assert(authorityAfter.credit.comparisonMode === "ENABLED", "Credit comparison changed.", {
  authorityAfter,
});
assert(authorityAfter.settlement.authority === "SERVICE", "Settlement authority changed.", {
  authorityAfter,
});
assert(authorityAfter.ledger.authority === "SERVICE", "Ledger authority changed.", {
  authorityAfter,
});

pass("Credit dry-run approval QA completed.", {
  approvalId: validApproval.body.approval.id,
  decisionBefore: decisionBefore.decision,
  decisionAfter: decisionAfter.decision,
  idempotent: repeatedApproval.body.idempotent,
  authority: authorityAfter.credit.authority,
  comparisonMode: authorityAfter.credit.comparisonMode,
});
