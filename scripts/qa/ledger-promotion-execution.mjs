import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const correlationId = "qa-ledger-promotion-execution-v1";
const justification =
  "QA confirms Ledger controlled promotion execution support is ready and rollback remains available.";

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

async function executePromotion(body, authenticated = true) {
  return requestJson("/api/authority/ledger-promotion/execute", {
    method: "POST",
    headers: authenticated
      ? authHeaders({ "content-type": "application/json" })
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const unauthenticated = await executePromotion(
  {
    domain: "LEDGER",
    mode: "EXECUTE",
    justification,
    correlationId,
  },
  false
);
assert(unauthenticated.response.status === 401, "Ledger promotion execution should require auth.", {
  status: unauthenticated.response.status,
  body: unauthenticated.body,
});
pass("Ledger promotion execution endpoint requires auth.");

const invalidMode = await executePromotion({
  domain: "LEDGER",
  mode: "SIMULATION",
  justification,
  correlationId: `${correlationId}-invalid-mode`,
});
assert(invalidMode.response.status >= 400, "Ledger promotion should reject invalid mode.", {
  status: invalidMode.response.status,
  body: invalidMode.body,
});
pass("Ledger promotion execution rejects invalid mode.");

const missingJustification = await executePromotion({
  domain: "LEDGER",
  mode: "EXECUTE",
  justification: "",
  correlationId: `${correlationId}-missing-justification`,
});
assert(
  missingJustification.response.status >= 400,
  "Ledger promotion should reject missing justification.",
  { status: missingJustification.response.status, body: missingJustification.body }
);
pass("Ledger promotion execution rejects missing justification.");

const [authorityBeforeResult, decisionBeforeResult] = await Promise.all([
  authGet("/api/authority/status"),
  authGet("/api/authority/promotion-decision?domain=ledger"),
]);
assert(authorityBeforeResult.response.status === 200 && authorityBeforeResult.body.success, "Authority before promotion failed.", {
  status: authorityBeforeResult.response.status,
  body: authorityBeforeResult.body,
});
assert(
  decisionBeforeResult.response.status === 200 && decisionBeforeResult.body.success,
  "Ledger decision before promotion failed.",
  { status: decisionBeforeResult.response.status, body: decisionBeforeResult.body }
);

const authorityBefore = authorityBeforeResult.body.authority;
const decisionBefore = decisionBeforeResult.body.decision;
assert(authorityBefore.settlement.authority === "SERVICE", "Settlement must be SERVICE before Ledger promotion.", {
  authorityBefore,
});
assert(authorityBefore.credit.authority === "MONOLITH", "Credit must be MONOLITH before Ledger promotion.", {
  authorityBefore,
});
assert(
  authorityBefore.ledger.authority === "MONOLITH" ||
    authorityBefore.ledger.authority === "SERVICE",
  "Ledger authority must be a supported state before promotion.",
  { authorityBefore }
);
assert(
  decisionBefore.decision === "READY_FOR_CONTROLLED_PROMOTION" ||
    decisionBefore.decision === "PROMOTED",
  "Ledger must be ready for controlled promotion or already promoted.",
  { decisionBefore }
);

const promotionResult = await executePromotion({
  domain: "LEDGER",
  mode: "EXECUTE",
  justification,
  correlationId,
});
assert(
  promotionResult.response.status === 200 && promotionResult.body.success,
  "Ledger promotion execution failed.",
  { status: promotionResult.response.status, body: promotionResult.body }
);
const promotion = promotionResult.body.promotion;
assert(promotion.newAuthority === "SERVICE", "Ledger promotion did not result in SERVICE authority.", {
  promotion,
});
assert(promotion.comparisonMode === "ENABLED", "Ledger comparison must remain ENABLED.", {
  promotion,
});
assert(
  promotion.idempotent === true ||
    promotion.auditEvent?.eventType === "authority.ledger.promoted",
  "Ledger promotion event was not emitted for a new promotion.",
  { promotion }
);
pass("Ledger promotion execution succeeds when valid.", {
  previousAuthority: promotion.previousAuthority,
  newAuthority: promotion.newAuthority,
  idempotent: promotion.idempotent,
  auditEvent: promotion.auditEvent,
});

const repeatedPromotion = await executePromotion({
  domain: "LEDGER",
  mode: "EXECUTE",
  justification,
  correlationId,
});
assert(
  repeatedPromotion.response.status === 200 && repeatedPromotion.body.success,
  "Repeated Ledger promotion should be idempotent.",
  { status: repeatedPromotion.response.status, body: repeatedPromotion.body }
);
assert(
  repeatedPromotion.body.promotion.newAuthority === "SERVICE" &&
    repeatedPromotion.body.promotion.idempotent === true,
  "Repeated Ledger promotion should report idempotent SERVICE authority.",
  { promotion: repeatedPromotion.body.promotion }
);
pass("Ledger promotion execution is idempotent.");

const [
  authorityAfterResult,
  promotionStatusResult,
  rollbackReadinessResult,
  settlementStatusResult,
  decisionAfterResult,
] = await Promise.all([
  authGet("/api/authority/status"),
  authGet("/api/authority/ledger-promotion-status"),
  authGet("/api/authority/rollback-readiness"),
  authGet("/api/authority/settlement-stabilization-status?window=7d"),
  authGet("/api/authority/promotion-decision?domain=ledger"),
]);

assert(authorityAfterResult.response.status === 200 && authorityAfterResult.body.success, "Authority after promotion failed.", {
  status: authorityAfterResult.response.status,
  body: authorityAfterResult.body,
});
assert(
  promotionStatusResult.response.status === 200 && promotionStatusResult.body.success,
  "Ledger promotion status failed.",
  { status: promotionStatusResult.response.status, body: promotionStatusResult.body }
);
assert(
  rollbackReadinessResult.response.status === 200 && rollbackReadinessResult.body.success,
  "Rollback readiness failed.",
  { status: rollbackReadinessResult.response.status, body: rollbackReadinessResult.body }
);
assert(
  settlementStatusResult.response.status === 200 && settlementStatusResult.body.success,
  "Settlement certification status failed.",
  { status: settlementStatusResult.response.status, body: settlementStatusResult.body }
);
assert(
  decisionAfterResult.response.status === 200 && decisionAfterResult.body.success,
  "Ledger decision after promotion failed.",
  { status: decisionAfterResult.response.status, body: decisionAfterResult.body }
);

const authorityAfter = authorityAfterResult.body.authority;
const promotionStatus = promotionStatusResult.body.promotionStatus;
const rollbackReadiness = rollbackReadinessResult.body.rollbackReadiness;
const settlementStatus = settlementStatusResult.body.stabilizationStatus;
const decisionAfter = decisionAfterResult.body.decision;

assert(authorityAfter.ledger.authority === "SERVICE", "Ledger authority should be SERVICE.", {
  authorityAfter,
});
assert(authorityAfter.ledger.comparisonMode === "ENABLED", "Ledger comparison changed.", {
  authorityAfter,
});
assert(authorityAfter.settlement.authority === "SERVICE", "Settlement authority changed.", {
  authorityAfter,
});
assert(settlementStatus.certificationStatus === "CERTIFIED", "Settlement certification changed.", {
  settlementStatus,
});
assert(authorityAfter.credit.authority === "MONOLITH", "Credit authority changed.", {
  authorityAfter,
});
assert(promotionStatus.authority === "SERVICE", "Ledger promotion status should report SERVICE.", {
  promotionStatus,
});
assert(promotionStatus.rollbackReady === true, "Ledger promotion status should report rollback ready.", {
  promotionStatus,
});
assert(
  rollbackReadiness.ledger.rollbackStatus === "READY",
  "Ledger rollback readiness should remain READY.",
  { rollbackReadiness: rollbackReadiness.ledger }
);
assert(decisionAfter.decision === "PROMOTED", "Ledger decision should be PROMOTED after execution.", {
  decisionAfter,
});

pass("Ledger promotion execution QA completed.", {
  before: authorityBefore.ledger.authority,
  after: authorityAfter.ledger.authority,
  decisionBefore: decisionBefore.decision,
  decisionAfter: decisionAfter.decision,
  promotionEvent: promotion.auditEvent,
  rollbackReadiness: rollbackReadiness.ledger.rollbackStatus,
});
