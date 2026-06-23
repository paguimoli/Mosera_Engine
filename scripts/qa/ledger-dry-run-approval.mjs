import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const correlationId = "qa-ledger-dry-run-approval-v1";

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

const unauthenticated = await requestJson("/api/authority/approvals/dry-run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    domain: "LEDGER",
    justification: "Unauthenticated Ledger approval should fail.",
    acknowledgedWarnings: [],
  }),
});
assert(unauthenticated.response.status === 401, "Ledger dry-run approval should require auth.", {
  status: unauthenticated.response.status,
  body: unauthenticated.body,
});
pass("Ledger dry-run approval endpoint requires auth.");

const [decisionBeforeResult, authorityResult, settlementStatusResult] = await Promise.all([
  authGet("/api/authority/promotion-decision?domain=ledger"),
  authGet("/api/authority/status"),
  authGet("/api/authority/settlement-stabilization-status?window=7d"),
]);

assert(
  decisionBeforeResult.response.status === 200 && decisionBeforeResult.body.success,
  "Ledger promotion decision before approval failed.",
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

const decisionBefore = decisionBeforeResult.body.decision;
const authorityBefore = authorityResult.body.authority;
const settlementStatus = settlementStatusResult.body.stabilizationStatus;
const warningsToAcknowledge = decisionBefore.warnings;

assert(authorityBefore.settlement.authority === "SERVICE", "Settlement must remain SERVICE.", {
  authorityBefore,
});
assert(settlementStatus.certificationStatus === "CERTIFIED", "Settlement must remain CERTIFIED.", {
  settlementStatus,
});
assert(authorityBefore.ledger.authority === "MONOLITH", "Ledger must remain MONOLITH before approval.", {
  authorityBefore,
});
assert(authorityBefore.ledger.comparisonMode === "ENABLED", "Ledger comparison must remain ENABLED.", {
  authorityBefore,
});
assert(authorityBefore.credit.authority === "MONOLITH", "Credit must remain MONOLITH.", {
  authorityBefore,
});

const missingJustification = await approve({
  domain: "LEDGER",
  justification: "",
  acknowledgedWarnings: warningsToAcknowledge,
});
assert(missingJustification.response.status >= 400, "Ledger approval should reject missing justification.", {
  status: missingJustification.response.status,
  body: missingJustification.body,
});
pass("Ledger dry-run approval rejects missing justification.");

if (decisionBefore.decision === "READY_FOR_DRY_RUN_APPROVAL") {
  const missingWarningAcknowledgement = await approve({
    domain: "LEDGER",
    justification: "QA validates Ledger missing warning acknowledgement rejection.",
    acknowledgedWarnings: [],
  });
  assert(
    missingWarningAcknowledgement.response.status >= 400,
    "Ledger approval should reject missing warning acknowledgement.",
    {
      status: missingWarningAcknowledgement.response.status,
      body: missingWarningAcknowledgement.body,
    }
  );
  pass("Ledger dry-run approval rejects missing warning acknowledgement.");
} else {
  pass("Ledger warning acknowledgement rejection already covered by existing approval state.", {
    decision: decisionBefore.decision,
  });
}

const validApproval = await approve({
  domain: "LEDGER",
  justification:
    "QA confirms Ledger lifecycle-adjusted shadow evidence is ready and raw evidence remains visible.",
  acknowledgedWarnings: warningsToAcknowledge,
  correlationId,
});
assert(validApproval.response.status === 200 && validApproval.body.success, "Ledger dry-run approval failed.", {
  status: validApproval.response.status,
  body: validApproval.body,
});
assert(validApproval.body.approval.approvalType === "DRY_RUN_APPROVAL", "Approval type mismatch.", {
  approval: validApproval.body.approval,
});
assert(validApproval.body.approval.authorityCandidate === "LEDGER", "Approval domain mismatch.", {
  approval: validApproval.body.approval,
});
pass("Ledger dry-run approval succeeds when valid.", {
  approvalId: validApproval.body.approval.id,
  idempotent: validApproval.body.idempotent,
});

const repeatedApproval = await approve({
  domain: "LEDGER",
  justification:
    "QA confirms Ledger lifecycle-adjusted shadow evidence is ready and raw evidence remains visible.",
  acknowledgedWarnings: warningsToAcknowledge,
  correlationId,
});
assert(
  repeatedApproval.response.status === 200 && repeatedApproval.body.success,
  "Repeated Ledger dry-run approval should be idempotent.",
  { status: repeatedApproval.response.status, body: repeatedApproval.body }
);
assert(
  repeatedApproval.body.approval.id === validApproval.body.approval.id,
  "Repeated Ledger dry-run approval should return existing approval.",
  {
    firstApprovalId: validApproval.body.approval.id,
    repeatedApprovalId: repeatedApproval.body.approval.id,
  }
);
assert(repeatedApproval.body.idempotent === true, "Repeated approval should be idempotent.", {
  body: repeatedApproval.body,
});
pass("Ledger dry-run approval is idempotent and append-only.");

const [decisionAfterResult, authorityAfterResult] = await Promise.all([
  authGet("/api/authority/promotion-decision?domain=ledger"),
  authGet("/api/authority/status"),
]);
assert(
  decisionAfterResult.response.status === 200 && decisionAfterResult.body.success,
  "Ledger promotion decision after approval failed.",
  { status: decisionAfterResult.response.status, body: decisionAfterResult.body }
);
assert(authorityAfterResult.response.status === 200 && authorityAfterResult.body.success, "Authority status after approval failed.", {
  status: authorityAfterResult.response.status,
  body: authorityAfterResult.body,
});

const decisionAfter = decisionAfterResult.body.decision;
const authorityAfter = authorityAfterResult.body.authority;

assert(
  decisionAfter.decision === "READY_FOR_PROMOTION_APPROVAL" ||
    decisionAfter.decision === "READY_FOR_CONTROLLED_PROMOTION",
  "Ledger decision should advance to promotion approval readiness.",
  { decisionBefore, decisionAfter }
);
assert(authorityAfter.ledger.authority === "MONOLITH", "Ledger authority changed.", {
  authorityAfter,
});
assert(authorityAfter.ledger.comparisonMode === "ENABLED", "Ledger comparison changed.", {
  authorityAfter,
});
assert(authorityAfter.settlement.authority === "SERVICE", "Settlement authority changed.", {
  authorityAfter,
});
assert(authorityAfter.credit.authority === "MONOLITH", "Credit authority changed.", {
  authorityAfter,
});

pass("Ledger dry-run approval QA completed.", {
  before: decisionBefore.decision,
  after: decisionAfter.decision,
  approvalId: validApproval.body.approval.id,
  idempotent: validApproval.body.idempotent,
});
