import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const promotionCorrelationId = `qa-promotion-simulation-${Date.now()}`;
const rollbackCorrelationId = `qa-rollback-simulation-${Date.now()}`;

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

async function simulate(path, correlationId) {
  return requestJson(path, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      domain: "SETTLEMENT",
      correlationId,
    }),
  });
}

for (const path of [
  "/api/authority/promotion/simulate",
  "/api/authority/rollback/simulate",
]) {
  const unauthenticated = await requestJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain: "SETTLEMENT" }),
  });

  assert(
    unauthenticated.response.status === 401,
    "Promotion execution simulation endpoint should require authentication.",
    { path, status: unauthenticated.response.status, body: unauthenticated.body }
  );
}
pass("Promotion and rollback simulation endpoints require auth.");

const [promotionResult, rollbackResult] = await Promise.all([
  simulate("/api/authority/promotion/simulate", promotionCorrelationId),
  simulate("/api/authority/rollback/simulate", rollbackCorrelationId),
]);

assert(
  promotionResult.response.status === 200 && promotionResult.body.success,
  "Promotion simulation failed.",
  { status: promotionResult.response.status, body: promotionResult.body }
);
assert(
  rollbackResult.response.status === 200 && rollbackResult.body.success,
  "Rollback simulation failed.",
  { status: rollbackResult.response.status, body: rollbackResult.body }
);

const promotion = promotionResult.body.simulation;
const rollback = rollbackResult.body.simulation;

assert(rollback.rollbackAllowed === true, "Rollback simulation should pass.", {
  rollback,
});
assert(
  promotion.currentAuthority === "MONOLITH" ||
    promotion.currentAuthority === "SERVICE",
  "Promotion simulation returned unsupported authority.",
  { promotion }
);
if (promotion.currentAuthority === "MONOLITH") {
  assert(promotion.promotionAllowed === true, "Promotion simulation should pass.", {
    promotion,
  });
} else {
  assert(
    promotion.promotionAllowed === false &&
      promotion.blockers.includes(
        "Settlement authority must remain MONOLITH before controlled promotion."
      ),
    "Promotion simulation should recognize Settlement as already promoted.",
    { promotion }
  );
}
assert(
  rollback.authorityState === promotion.currentAuthority,
  "Rollback simulation must preserve current authority.",
  { rollback }
);
assert(
  promotion.comparisonMode === "ENABLED" && rollback.comparisonMode === "ENABLED",
  "Simulation must not disable comparison mode.",
  { promotion, rollback }
);
assert(
  promotion.auditEvent?.eventType === "authority.promotion.simulated" &&
    promotion.auditEvent.id,
  "Promotion simulation outbox audit event missing.",
  { promotion }
);
assert(
  rollback.auditEvent?.eventType === "authority.rollback.simulated" &&
    rollback.auditEvent.id,
  "Rollback simulation outbox audit event missing.",
  { rollback }
);
assert(
  promotion.auditEvent.correlationId === promotionCorrelationId,
  "Promotion simulation correlation ID mismatch.",
  { promotion }
);
assert(
  rollback.auditEvent.correlationId === rollbackCorrelationId,
  "Rollback simulation correlation ID mismatch.",
  { rollback }
);
pass("Promotion and rollback simulations passed with outbox audit events.", {
  promotionAuditEventId: promotion.auditEvent.id,
  rollbackAuditEventId: rollback.auditEvent.id,
});

const authorityStatus = await requestJson("/api/authority/status", {
  headers: authHeaders(),
});
assert(
  authorityStatus.response.status === 200 && authorityStatus.body.success,
  "Authority status endpoint failed after simulations.",
  { status: authorityStatus.response.status, body: authorityStatus.body }
);
assert(
  authorityStatus.body.authority.settlement.authority === promotion.currentAuthority,
  "Authority changed unexpectedly after simulation.",
  { authorityStatus: authorityStatus.body.authority }
);
assert(
  authorityStatus.body.authority.settlement.comparisonMode === "ENABLED",
  "Comparison mode changed after simulation.",
  { authorityStatus: authorityStatus.body.authority }
);
pass("Simulation preserved authority controls.", {
  authority: authorityStatus.body.authority.settlement.authority,
  comparisonMode: authorityStatus.body.authority.settlement.comparisonMode,
});

pass("Promotion simulation QA completed.", {
  promotionAllowed: promotion.promotionAllowed,
  rollbackAllowed: rollback.rollbackAllowed,
  promotionBlockers: promotion.blockers,
  rollbackBlockers: rollback.blockers,
});
