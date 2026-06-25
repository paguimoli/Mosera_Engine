import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const warning =
  "Operator certification is still required before marking Ledger as CERTIFIED.";
const correlationId = "qa-ledger-certification-capture";

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

async function getLedgerStabilizationStatus() {
  const result = await requestJson("/api/authority/ledger-stabilization-status", {
    headers: authHeaders(),
  });

  assert(result.response.status === 200 && result.body.success, "Ledger status failed.", {
    status: result.response.status,
    body: result.body,
  });

  return result.body.stabilizationStatus;
}

async function getSettlementStabilizationStatus() {
  const result = await requestJson(
    "/api/authority/settlement-stabilization-status?window=7d",
    {
      headers: authHeaders(),
    }
  );

  assert(
    result.response.status === 200 && result.body.success,
    "Settlement status failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.stabilizationStatus;
}

async function getAuthorityStatus() {
  const result = await requestJson("/api/authority/status", {
    headers: authHeaders(),
  });

  assert(result.response.status === 200 && result.body.success, "Authority status failed.", {
    status: result.response.status,
    body: result.body,
  });

  return result.body.authority;
}

async function certify(body) {
  return requestJson("/api/authority/certification/ledger", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

const unauthenticated = await requestJson("/api/authority/certification/ledger", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ justification: "Missing auth should fail." }),
});
assert(
  unauthenticated.response.status === 401,
  "Ledger certification endpoint should require auth.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Ledger certification endpoint requires auth.");

const missingJustification = await certify({
  acknowledgedWarnings: [warning],
  correlationId: "qa-ledger-certification-missing-justification",
});
assert(
  missingJustification.response.status === 400,
  "Ledger certification should reject missing justification.",
  { status: missingJustification.response.status, body: missingJustification.body }
);
pass("Ledger certification rejects missing justification.");

const [before, settlementBefore, authorityBefore] = await Promise.all([
  getLedgerStabilizationStatus(),
  getSettlementStabilizationStatus(),
  getAuthorityStatus(),
]);
assert(before.authority === "SERVICE", "Ledger authority must be SERVICE.", {
  before,
});
assert(before.comparisonMode === "ENABLED", "Ledger comparison must remain ENABLED.", {
  before,
});
assert(before.rollbackReadiness === "READY", "Ledger rollback readiness must be READY.", {
  before,
});
assert(
  before.certificationStatus === "READY_FOR_CERTIFICATION" ||
    before.certificationStatus === "CERTIFIED",
  "Ledger must be ready or already certified.",
  { before }
);
assert(
  settlementBefore.authority === "SERVICE" &&
    settlementBefore.certificationStatus === "CERTIFIED",
  "Settlement must remain SERVICE and CERTIFIED.",
  { settlementBefore }
);
assert(authorityBefore.credit.authority === "MONOLITH", "Credit must remain MONOLITH.", {
  authorityBefore,
});

const approval = await certify({
  justification:
    "QA certifies Ledger Service post-promotion activity evidence for controlled authority.",
  acknowledgedWarnings: [warning],
  correlationId,
});
assert(approval.response.status === 200 && approval.body.success, "Ledger certification failed.", {
  status: approval.response.status,
  body: approval.body,
});
assert(
  approval.body.approval.approvalType === "LEDGER_CERTIFICATION",
  "Unexpected approval type.",
  { body: approval.body }
);
assert(
  approval.body.stabilizationAfter.certificationStatus === "CERTIFIED",
  "Ledger certification should update status to CERTIFIED.",
  { body: approval.body }
);
pass("Ledger certification succeeds when valid.", {
  approvalId: approval.body.approval.id,
  idempotent: approval.body.idempotent,
});

const idempotent = await certify({
  justification:
    "QA certifies Ledger Service post-promotion activity evidence for controlled authority.",
  acknowledgedWarnings: [warning],
  correlationId,
});
assert(
  idempotent.response.status === 200 &&
    idempotent.body.success &&
    idempotent.body.idempotent === true &&
    idempotent.body.approval.id === approval.body.approval.id,
  "Ledger certification should be idempotent by correlationId.",
  { status: idempotent.response.status, body: idempotent.body }
);
pass("Ledger certification is idempotent.", {
  approvalId: idempotent.body.approval.id,
});

const [after, settlementAfter, authorityAfter] = await Promise.all([
  getLedgerStabilizationStatus(),
  getSettlementStabilizationStatus(),
  getAuthorityStatus(),
]);
assert(after.certificationStatus === "CERTIFIED", "Ledger status should be CERTIFIED.", {
  after,
});
assert(after.certificationApprovalId === approval.body.approval.id, "Approval id missing.", {
  after,
  approval: approval.body.approval,
});
assert(after.certifiedAt, "Certified timestamp missing.", { after });
assert(after.authority === "SERVICE", "Certification changed Ledger authority.", { after });
assert(after.comparisonMode === "ENABLED", "Certification changed comparison mode.", {
  after,
});
assert(after.rollbackReadiness === "READY", "Certification changed rollback readiness.", {
  after,
});
assert(
  settlementAfter.authority === "SERVICE" &&
    settlementAfter.certificationStatus === "CERTIFIED",
  "Certification changed Settlement state.",
  { settlementAfter }
);
assert(authorityAfter.credit.authority === "MONOLITH", "Certification changed Credit.", {
  authorityAfter,
});
pass("Ledger certification QA completed.", {
  before: before.certificationStatus,
  after: after.certificationStatus,
  approvalId: after.certificationApprovalId,
  certifiedAt: after.certifiedAt,
});
