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

async function getJson(path) {
  const response = await fetch(`${appUrl}${path}`, {
    headers: sessionToken ? { authorization: `Bearer ${sessionToken}` } : {},
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;

  return { response, body: parsed };
}

const unauthenticated = await requestJson("/api/authority/credit-promotion/simulate", {}, false);
assert(unauthenticated.response.status === 401, "Credit simulation should require auth.", {
  status: unauthenticated.response.status,
});
pass("Credit promotion simulation endpoint requires auth.");

if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN is required.");

const correlationId = `qa-credit-promotion-simulation-${Date.now()}`;
const [promotionResult, rollbackResult] = await Promise.all([
  requestJson("/api/authority/credit-promotion/simulate", { correlationId }),
  requestJson("/api/authority/credit-rollback/simulate", { correlationId }),
]);

assert(promotionResult.response.status === 200 && promotionResult.body.success, "Credit promotion simulation failed.", {
  status: promotionResult.response.status,
  body: promotionResult.body,
});
assert(rollbackResult.response.status === 200 && rollbackResult.body.success, "Credit rollback simulation failed.", {
  status: rollbackResult.response.status,
  body: rollbackResult.body,
});

const promotion = promotionResult.body.simulation;
const rollback = rollbackResult.body.simulation;
assert(promotion.domain === "CREDIT", "Promotion simulation domain mismatch.", { promotion });
assert(rollback.domain === "CREDIT", "Rollback simulation domain mismatch.", { rollback });
assert(promotion.currentAuthority === "MONOLITH", "Credit promotion simulation must preserve MONOLITH.", {
  promotion,
});
assert(promotion.simulatedAuthority === "SERVICE", "Promotion simulation should model SERVICE authority.", {
  promotion,
});
assert(promotion.promotionAllowed === false, "Phase 17.0 must not allow promotion yet.", {
  promotion,
});
assert(
  promotion.blockers.includes("Credit PROMOTION_APPROVAL must exist."),
  "Promotion simulation should require promotion approval.",
  { promotion }
);
assert(
  promotion.blockers.includes(
    "Credit promotion decision must be READY_FOR_CONTROLLED_PROMOTION."
  ),
  "Promotion simulation should require controlled-promotion readiness.",
  { promotion }
);
if (promotion.promotionDecision === "READY_FOR_DRY_RUN_APPROVAL") {
  assert(
    promotion.blockers.includes("Credit DRY_RUN_APPROVAL must exist."),
    "Promotion simulation should require dry-run approval before approval capture.",
    { promotion }
  );
}
assert(promotion.comparisonMode === "ENABLED", "Credit simulation must preserve comparison mode.", {
  promotion,
});
assert(promotion.rollbackReady === true, "Credit promotion simulation should report rollbackReady=true.", {
  promotion,
});
assert(rollback.rollbackReady === true, "Credit rollback simulation should report rollbackReady=true.", {
  rollback,
});
assert(promotion.auditEvent?.eventType === "authority.credit.promotion.simulated", "Promotion audit event missing.", {
  promotion,
});
assert(rollback.auditEvent?.eventType === "authority.credit.rollback.simulated", "Rollback audit event missing.", {
  rollback,
});

const authorityResult = await getJson("/api/authority/status");
assert(authorityResult.response.status === 200 && authorityResult.body.success, "Authority status failed.", {
  status: authorityResult.response.status,
  body: authorityResult.body,
});
const authority = authorityResult.body.authority;
assert(authority.credit.authority === "MONOLITH", "Credit authority changed after simulation.", {
  authority,
});
assert(authority.credit.comparisonMode === "ENABLED", "Credit comparison changed after simulation.", {
  authority,
});
assert(authority.settlement.authority === "SERVICE", "Settlement authority changed after simulation.", {
  authority,
});
assert(authority.ledger.authority === "SERVICE", "Ledger authority changed after simulation.", {
  authority,
});

pass("Credit promotion and rollback simulations are audit-only.", {
  promotionAllowed: promotion.promotionAllowed,
  rollbackAllowed: rollback.rollbackAllowed,
  promotionBlockers: promotion.blockers,
  rollbackBlockers: rollback.blockers,
  promotionAuditEventId: promotion.auditEvent.id,
  rollbackAuditEventId: rollback.auditEvent.id,
});
