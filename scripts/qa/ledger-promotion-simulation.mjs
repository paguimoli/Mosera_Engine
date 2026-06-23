import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;

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

async function requestJson(path, body, authenticated = true) {
  const response = await fetch(`${appUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated && sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;

  return { response, body: parsed };
}

async function getJson(path, authenticated = true) {
  const response = await fetch(`${appUrl}${path}`, {
    headers: {
      ...(authenticated && sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;

  return { response, body: parsed };
}

const unauthenticated = await requestJson("/api/authority/ledger-promotion/simulate", {}, false);
assert(unauthenticated.response.status === 401, "Ledger simulation should require auth.", {
  status: unauthenticated.response.status,
});
pass("Ledger promotion simulation endpoint requires auth.");

if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN is required.");

const correlationId = `qa-ledger-promotion-simulation-${Date.now()}`;
const [promotionResult, rollbackResult] = await Promise.all([
  requestJson("/api/authority/ledger-promotion/simulate", { correlationId }),
  requestJson("/api/authority/ledger-rollback/simulate", { correlationId }),
]);

assert(promotionResult.response.status === 200 && promotionResult.body.success, "Ledger promotion simulation failed.", {
  status: promotionResult.response.status,
  body: promotionResult.body,
});
assert(rollbackResult.response.status === 200 && rollbackResult.body.success, "Ledger rollback simulation failed.", {
  status: rollbackResult.response.status,
  body: rollbackResult.body,
});

const promotion = promotionResult.body.simulation;
const rollback = rollbackResult.body.simulation;
assert(promotion.domain === "LEDGER", "Promotion simulation domain mismatch.", { promotion });
assert(rollback.domain === "LEDGER", "Rollback simulation domain mismatch.", { rollback });
assert(promotion.currentAuthority === "MONOLITH", "Ledger simulation must preserve MONOLITH authority.", {
  promotion,
});
assert(promotion.simulatedAuthority === "SERVICE", "Promotion simulation should model SERVICE authority.", {
  promotion,
});
assert(promotion.comparisonMode === "ENABLED", "Ledger simulation must preserve comparison mode.", {
  promotion,
});
assert(promotion.rollbackReady === true, "Ledger promotion simulation should report rollbackReady=true.", {
  promotion,
});
assert(rollback.rollbackReady === true, "Ledger rollback simulation should report rollbackReady=true.", {
  rollback,
});
assert(promotion.auditEvent?.eventType === "authority.ledger.promotion.simulated", "Promotion audit event missing.", {
  promotion,
});
assert(rollback.auditEvent?.eventType === "authority.ledger.rollback.simulated", "Rollback audit event missing.", {
  rollback,
});

const [authorityResult, settlementStatusResult] = await Promise.all([
  getJson("/api/authority/status"),
  getJson("/api/authority/settlement-stabilization-status?window=7d"),
]);
assert(authorityResult.response.status === 200 && authorityResult.body.success, "Authority status failed.", {
  status: authorityResult.response.status,
  body: authorityResult.body,
});
assert(
  settlementStatusResult.response.status === 200 && settlementStatusResult.body.success,
  "Settlement certification status failed.",
  { status: settlementStatusResult.response.status, body: settlementStatusResult.body }
);

const authority = authorityResult.body.authority;
const settlementStatus = settlementStatusResult.body.stabilizationStatus;
assert(authority.ledger.authority === "MONOLITH", "Ledger authority changed after simulation.", {
  authority,
});
assert(authority.ledger.comparisonMode === "ENABLED", "Ledger comparison changed after simulation.", {
  authority,
});
assert(authority.settlement.authority === "SERVICE", "Settlement authority changed after simulation.", {
  authority,
});
assert(settlementStatus.certificationStatus === "CERTIFIED", "Settlement certification changed after simulation.", {
  settlementStatus,
});
assert(authority.credit.authority === "MONOLITH", "Credit authority changed after simulation.", {
  authority,
});

pass("Ledger promotion and rollback simulations are audit-only.", {
  promotionAllowed: promotion.promotionAllowed,
  rollbackAllowed: rollback.rollbackAllowed,
  promotionBlockers: promotion.blockers,
  rollbackBlockers: rollback.blockers,
  promotionAuditEventId: promotion.auditEvent.id,
  rollbackAuditEventId: rollback.auditEvent.id,
});
