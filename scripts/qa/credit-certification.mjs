import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const warning =
  "Operator certification is still required before marking Credit as CERTIFIED.";
const correlationId = "qa-credit-certification-capture-v1";
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function createQaSupabaseClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    fail("SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket,
    },
  });
}

async function snapshotCreditFinancialState() {
  const supabase = createQaSupabaseClient();
  const [wallets, reservations] = await Promise.all([
    supabase
      .from("financial_wallets")
      .select("id,wallet_type,balance,credit_limit,updated_at")
      .eq("wallet_type", "CREDIT")
      .order("id", { ascending: true }),
    supabase
      .from("credit_reservations")
      .select(
        "id,reserved_amount,released_amount,settled_amount,remaining_exposure"
      )
      .order("id", { ascending: true }),
  ]);

  if (wallets.error) {
    fail("Unable to snapshot credit wallets.", { error: wallets.error.message });
  }
  if (reservations.error) {
    fail("Unable to snapshot credit reservations.", {
      error: reservations.error.message,
    });
  }

  return {
    wallets: wallets.data ?? [],
    reservations: reservations.data ?? [],
  };
}

async function getCreditStabilizationStatus() {
  const result = await authGet("/api/authority/credit-stabilization-status");

  assert(
    result.response.status === 200 && result.body.success,
    "Credit stabilization status failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.stabilizationStatus;
}

async function getSettlementStabilizationStatus() {
  const result = await authGet("/api/authority/settlement-stabilization-status?window=7d");

  assert(
    result.response.status === 200 && result.body.success,
    "Settlement stabilization status failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.stabilizationStatus;
}

async function getLedgerStabilizationStatus() {
  const result = await authGet("/api/authority/ledger-stabilization-status");

  assert(
    result.response.status === 200 && result.body.success,
    "Ledger stabilization status failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.stabilizationStatus;
}

async function getAuthorityStatus() {
  const result = await authGet("/api/authority/status");

  assert(result.response.status === 200 && result.body.success, "Authority status failed.", {
    status: result.response.status,
    body: result.body,
  });

  return result.body.authority;
}

async function getCreditApprovalHistory() {
  const result = await authGet("/api/authority/credit-approval-history");

  assert(
    result.response.status === 200 && result.body.success,
    "Credit approval history failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.approvalHistory;
}

async function certify(body) {
  return requestJson("/api/authority/certification/credit", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

function creditCertificationApprovals(history) {
  return history.approvals.filter(
    (approval) =>
      approval.authorityCandidate === "CREDIT" &&
      approval.approvalType === "CREDIT_CERTIFICATION"
  );
}

async function assertOutboxEvent({ approvalId, correlationId: eventCorrelationId }) {
  const supabase = createQaSupabaseClient();
  const { data, error } = await supabase
    .from("outbox_events")
    .select("id,event_type,aggregate_type,aggregate_id,payload,correlation_id")
    .eq("event_type", "authority.credit.certified")
    .eq("aggregate_type", "authority_candidate")
    .eq("aggregate_id", "CREDIT")
    .eq("correlation_id", eventCorrelationId)
    .limit(10);

  if (error) {
    fail("Unable to query Credit certification outbox event.", {
      error: error.message,
    });
  }

  const event = data?.find(
    (candidate) => candidate.payload?.approvalId === approvalId
  );

  assert(Boolean(event), "Credit certification outbox event was not found.", {
    approvalId,
    correlationId: eventCorrelationId,
    events: data,
  });

  pass("Credit certification outbox event exists.", {
    outboxEventId: event.id,
    approvalId,
  });

  return event;
}

const unauthenticated = await requestJson("/api/authority/certification/credit", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    justification: "Unauthenticated Credit certification should fail.",
    acknowledgedWarnings: [warning],
  }),
});
assert(
  unauthenticated.response.status === 401,
  "Credit certification endpoint should require auth.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Credit certification endpoint requires auth.");

const missingJustification = await certify({
  acknowledgedWarnings: [warning],
  correlationId: "qa-credit-certification-missing-justification",
});
assert(
  missingJustification.response.status === 400,
  "Credit certification should reject missing justification.",
  { status: missingJustification.response.status, body: missingJustification.body }
);
pass("Credit certification rejects missing justification.");

const [
  before,
  settlementBefore,
  ledgerBefore,
  authorityBefore,
  approvalHistoryBefore,
  snapshotBefore,
] = await Promise.all([
  getCreditStabilizationStatus(),
  getSettlementStabilizationStatus(),
  getLedgerStabilizationStatus(),
  getAuthorityStatus(),
  getCreditApprovalHistory(),
  snapshotCreditFinancialState(),
]);
const beforeCertificationApprovals = creditCertificationApprovals(
  approvalHistoryBefore
);

assert(before.authority === "SERVICE", "Credit authority must be SERVICE.", {
  before,
});
assert(before.comparisonMode === "ENABLED", "Credit comparison must remain ENABLED.", {
  before,
});
assert(before.rollbackReadiness === "READY", "Credit rollback readiness must be READY.", {
  before,
});
assert(
  before.certificationStatus === "READY_FOR_CERTIFICATION" ||
    before.certificationStatus === "CERTIFIED",
  "Credit must be ready or already certified.",
  { before }
);
assert(before.creditWalletsProcessed > 0, "Credit post-promotion activity must exist.", {
  before,
});
assert(
  before.mismatchCount === 0 &&
    before.failureCount === 0 &&
    before.criticalMismatchCount === 0,
  "Credit post-promotion evidence must be clean.",
  { before }
);
assert(
  settlementBefore.authority === "SERVICE" &&
    settlementBefore.certificationStatus === "CERTIFIED",
  "Settlement must remain SERVICE and CERTIFIED.",
  { settlementBefore }
);
assert(
  ledgerBefore.authority === "SERVICE" &&
    ledgerBefore.certificationStatus === "CERTIFIED",
  "Ledger must remain SERVICE and CERTIFIED.",
  { ledgerBefore }
);
assert(
  authorityBefore.credit.authority === "SERVICE" &&
    authorityBefore.credit.comparisonMode === "ENABLED",
  "Credit authority controls must be SERVICE with comparison ENABLED.",
  { authorityBefore }
);

if (before.certificationStatus === "READY_FOR_CERTIFICATION") {
  const missingAcknowledgement = await certify({
    justification:
      "QA confirms Credit certification warnings must be acknowledged.",
    acknowledgedWarnings: [],
    correlationId: "qa-credit-certification-missing-acknowledgement",
  });
  assert(
    missingAcknowledgement.response.status === 400,
    "Credit certification should reject missing warning acknowledgement.",
    {
      status: missingAcknowledgement.response.status,
      body: missingAcknowledgement.body,
    }
  );
  pass("Credit certification rejects missing acknowledgement.");
} else {
  pass("Credit certification missing acknowledgement rejection already covered before certification.");
}

const approval = await certify({
  justification:
    "QA certifies Credit Wallet Service post-promotion activity evidence for controlled authority.",
  acknowledgedWarnings: [warning],
  correlationId,
});
assert(
  approval.response.status === 200 && approval.body.success,
  "Credit certification failed.",
  { status: approval.response.status, body: approval.body }
);
assert(
  approval.body.approval.approvalType === "CREDIT_CERTIFICATION",
  "Unexpected Credit certification approval type.",
  { body: approval.body }
);
assert(
  approval.body.stabilizationAfter.certificationStatus === "CERTIFIED",
  "Credit certification should update status to CERTIFIED.",
  { body: approval.body }
);
pass("Credit certification succeeds when valid.", {
  approvalId: approval.body.approval.id,
  idempotent: approval.body.idempotent,
});

const idempotent = await certify({
  justification:
    "QA certifies Credit Wallet Service post-promotion activity evidence for controlled authority.",
  acknowledgedWarnings: [warning],
  correlationId,
});
assert(
  idempotent.response.status === 200 &&
    idempotent.body.success &&
    idempotent.body.idempotent === true &&
    idempotent.body.approval.id === approval.body.approval.id,
  "Credit certification should be idempotent by correlationId.",
  { status: idempotent.response.status, body: idempotent.body }
);
pass("Credit certification is idempotent.", {
  approvalId: idempotent.body.approval.id,
});

const [
  after,
  settlementAfter,
  ledgerAfter,
  authorityAfter,
  approvalHistoryAfter,
  snapshotAfter,
] = await Promise.all([
  getCreditStabilizationStatus(),
  getSettlementStabilizationStatus(),
  getLedgerStabilizationStatus(),
  getAuthorityStatus(),
  getCreditApprovalHistory(),
  snapshotCreditFinancialState(),
]);
const afterCertificationApprovals = creditCertificationApprovals(
  approvalHistoryAfter
);
const matchingApprovals = afterCertificationApprovals.filter(
  (candidate) => candidate.id === approval.body.approval.id
);
const outboxEvent = await assertOutboxEvent({
  approvalId: approval.body.approval.id,
  correlationId,
});

assert(after.certificationStatus === "CERTIFIED", "Credit status should be CERTIFIED.", {
  after,
});
assert(after.certificationApprovalId === approval.body.approval.id, "Approval id missing.", {
  after,
  approval: approval.body.approval,
});
assert(after.certifiedAt, "Certified timestamp missing.", { after });
assert(after.authority === "SERVICE", "Certification changed Credit authority.", {
  after,
});
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
assert(
  ledgerAfter.authority === "SERVICE" &&
    ledgerAfter.certificationStatus === "CERTIFIED",
  "Certification changed Ledger state.",
  { ledgerAfter }
);
assert(
  authorityAfter.credit.authority === "SERVICE" &&
    authorityAfter.credit.comparisonMode === "ENABLED",
  "Certification changed Credit authority controls.",
  { authorityAfter }
);
assert(
  JSON.stringify(snapshotAfter) === JSON.stringify(snapshotBefore),
  "Credit certification changed balances, reservations, or exposure.",
  { before: snapshotBefore, after: snapshotAfter }
);
assert(
  matchingApprovals.length === 1,
  "Credit certification approval should remain append-only and unique by id.",
  {
    approvalId: approval.body.approval.id,
    beforeCount: beforeCertificationApprovals.length,
    afterCount: afterCertificationApprovals.length,
  }
);

pass("Credit certification QA completed.", {
  approvalId: after.certificationApprovalId,
  outboxEventId: outboxEvent.id,
  certificationStatusBefore: approval.body.stabilizationBefore.certificationStatus,
  certificationStatusAfter: after.certificationStatus,
  certifiedAt: after.certifiedAt,
});
