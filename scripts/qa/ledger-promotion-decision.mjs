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

async function requestJson(path, authenticated = true) {
  const response = await fetch(`${appUrl}${path}`, {
    headers: authenticated && sessionToken ? { authorization: `Bearer ${sessionToken}` } : {},
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

const unauthenticated = await requestJson("/api/authority/promotion-decision?domain=ledger", false);
assert(unauthenticated.response.status === 401, "Ledger promotion decision should require auth.", {
  status: unauthenticated.response.status,
});
pass("Ledger promotion decision endpoint requires auth.");

if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN is required.");

const result = await requestJson("/api/authority/promotion-decision?domain=ledger");
assert(result.response.status === 200 && result.body.success, "Ledger promotion decision failed.", {
  status: result.response.status,
  body: result.body,
});
const decision = result.body.decision;

assert(decision.domain === "LEDGER", "Ledger promotion decision domain mismatch.", { decision });
assert(
  decision.currentAuthority === "MONOLITH" || decision.currentAuthority === "SERVICE",
  "Ledger authority has an unsupported value.",
  { decision }
);
assert(decision.comparisonMode === "ENABLED", "Ledger comparison must remain ENABLED.", {
  decision,
});
assert(
  decision.currentAuthority === "SERVICE"
    ? decision.decision === "PROMOTED"
    : decision.decision !== "PROMOTED",
  "Ledger decision does not match authority state.",
  { decision }
);
assert(decision.promotionReadiness, "Ledger promotion readiness missing.", { decision });

pass("Ledger promotion decision is available.", {
  decision: decision.decision,
  authority: decision.currentAuthority,
  raw: decision.rawReadiness,
  promotion: decision.promotionReadiness,
  blockers: decision.blockingReasons,
});
