import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const correlationId = `qa-settlement-promotion-${Date.now()}`;

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

const unauthenticatedStatus = await requestJson("/api/authority/promotion-status");
assert(
  unauthenticatedStatus.response.status === 401,
  "Promotion status endpoint should require authentication.",
  {
    status: unauthenticatedStatus.response.status,
    body: unauthenticatedStatus.body,
  }
);

const unauthenticatedPromotion = await requestJson(
  "/api/authority/promotion/execute",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain: "SETTLEMENT" }),
  }
);
assert(
  unauthenticatedPromotion.response.status === 401,
  "Promotion execution endpoint should require authentication.",
  {
    status: unauthenticatedPromotion.response.status,
    body: unauthenticatedPromotion.body,
  }
);
pass("Settlement promotion endpoints require auth.");

const promotionResult = await requestJson("/api/authority/promotion/execute", {
  method: "POST",
  headers: authHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({
    domain: "SETTLEMENT",
    correlationId,
  }),
});
assert(
  promotionResult.response.status === 200 && promotionResult.body.success,
  "Settlement authority promotion failed.",
  { status: promotionResult.response.status, body: promotionResult.body }
);

const promotion = promotionResult.body.promotion;
assert(promotion.newAuthority === "SERVICE", "Settlement was not promoted.", {
  promotion,
});
assert(
  promotion.comparisonMode === "ENABLED",
  "Settlement comparison mode must remain enabled.",
  { promotion }
);
assert(
  promotion.idempotent === true ||
    promotion.auditEvent?.eventType === "authority.promoted",
  "Promotion event was not emitted for a new promotion.",
  { promotion }
);
pass("Settlement authority promotion executed.", {
  previousAuthority: promotion.previousAuthority,
  newAuthority: promotion.newAuthority,
  idempotent: promotion.idempotent,
  auditEvent: promotion.auditEvent,
});

const [authorityStatus, promotionStatus, rollbackReadiness, readiness, shadowSummary] =
  await Promise.all([
    requestJson("/api/authority/status", { headers: authHeaders() }),
    requestJson("/api/authority/promotion-status", { headers: authHeaders() }),
    requestJson("/api/authority/rollback-readiness", { headers: authHeaders() }),
    requestJson("/api/authority/settlement-readiness", { headers: authHeaders() }),
    requestJson("/api/settlement-shadow/summary", { headers: authHeaders() }),
  ]);

assert(
  authorityStatus.response.status === 200 && authorityStatus.body.success,
  "Authority status endpoint failed after promotion.",
  { status: authorityStatus.response.status, body: authorityStatus.body }
);
const authority = authorityStatus.body.authority;
assert(authority.settlement.authority === "SERVICE", "Settlement is not SERVICE.", {
  authority,
});
assert(
  authority.ledger.authority === "MONOLITH" || authority.ledger.authority === "SERVICE",
  "Ledger authority has an unsupported value.",
  { authority }
);
assert(authority.credit.authority === "MONOLITH", "Credit authority changed.", {
  authority,
});
assert(
  authority.settlement.comparisonMode === "ENABLED",
  "Settlement comparison mode changed.",
  { authority }
);
pass("Authority status reflects Settlement-only promotion.", {
  settlement: authority.settlement.authority,
  ledger: authority.ledger.authority,
  credit: authority.credit.authority,
});

assert(
  promotionStatus.response.status === 200 && promotionStatus.body.success,
  "Promotion status endpoint failed.",
  { status: promotionStatus.response.status, body: promotionStatus.body }
);
assert(
  promotionStatus.body.promotionStatus.authority === "SERVICE",
  "Promotion status should report SERVICE.",
  { promotionStatus: promotionStatus.body.promotionStatus }
);
assert(
  promotionStatus.body.promotionStatus.rollbackReady === true,
  "Promotion status should report rollback ready.",
  { promotionStatus: promotionStatus.body.promotionStatus }
);
pass("Promotion status reports SERVICE authority and rollback readiness.", {
  promotionStatus: promotionStatus.body.promotionStatus,
});

assert(
  rollbackReadiness.response.status === 200 && rollbackReadiness.body.success,
  "Rollback readiness endpoint failed after promotion.",
  { status: rollbackReadiness.response.status, body: rollbackReadiness.body }
);
assert(
  rollbackReadiness.body.rollbackReadiness.settlement.rollbackStatus === "READY",
  "Settlement rollback readiness should remain READY.",
  { rollbackReadiness: rollbackReadiness.body.rollbackReadiness.settlement }
);
pass("Rollback remains ready after promotion.", {
  rollbackReadiness:
    rollbackReadiness.body.rollbackReadiness.settlement.rollbackStatus,
});

assert(
  readiness.response.status === 200 && readiness.body.success,
  "Settlement authority readiness endpoint failed.",
  { status: readiness.response.status, body: readiness.body }
);
assert(
  readiness.body.readiness.runtimeRoute.authoritativePath === "SERVICE" &&
    readiness.body.readiness.runtimeRoute.comparisonPath === "MONOLITH" &&
    readiness.body.readiness.runtimeRoute.productionCutoverActive === true,
  "Settlement runtime route does not reflect controlled promotion.",
  { readiness: readiness.body.readiness.runtimeRoute }
);
pass("Settlement runtime route reflects Service authority with Monolith comparison.", {
  runtimeRoute: readiness.body.readiness.runtimeRoute,
});

assert(
  shadowSummary.response.status === 200 && shadowSummary.body.success,
  "Settlement shadow reporting endpoint failed after promotion.",
  { status: shadowSummary.response.status, body: shadowSummary.body }
);
assert(
  typeof shadowSummary.body.summary.totalRuns === "number",
  "Settlement shadow summary did not return metrics.",
  { summary: shadowSummary.body.summary }
);
pass("Settlement shadow reporting remains available.", {
  summary: shadowSummary.body.summary,
});

pass("Settlement authority promotion QA completed.", {
  correlationId,
  authority: authority.settlement.authority,
  comparisonMode: authority.settlement.comparisonMode,
});
