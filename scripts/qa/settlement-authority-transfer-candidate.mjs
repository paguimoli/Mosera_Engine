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

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

const unauthenticated = await requestJson("/api/authority/settlement-readiness");
assert(
  unauthenticated.response.status === 401,
  "Settlement authority readiness endpoint should require authentication.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Settlement authority readiness endpoint requires auth.");

if (!sessionToken) {
  fail("QA_ADMIN_SESSION_TOKEN is required.");
}

const result = await requestJson("/api/authority/settlement-readiness", {
  headers: { authorization: `Bearer ${sessionToken}` },
});

assert(
  result.response.status === 200 && result.body.success,
  "Settlement authority readiness endpoint failed.",
  { status: result.response.status, body: result.body }
);

const readiness = result.body.readiness;
const expectedComparisonPath =
  readiness.authority === "SERVICE" ? "MONOLITH" : "SETTLEMENT_SERVICE";

assert(
  readiness.authority === "MONOLITH" || readiness.authority === "SERVICE",
  "Settlement authority has an unsupported value.",
  { readiness }
);
assert(
  readiness.runtimeRoute.productionCutoverActive ===
    (readiness.authority === "SERVICE"),
  "Settlement production cutover flag does not match authority.",
  { readiness }
);
assert(
  readiness.runtimeRoute.authoritativePath === readiness.authority,
  "Settlement runtime route does not match configured authority.",
  { readiness }
);
assert(
  readiness.runtimeRoute.comparisonPath === expectedComparisonPath,
  "Settlement comparison path does not match authority.",
  { readiness }
);
assert(readiness.thresholds.mismatchAlertThreshold >= 0, "Mismatch threshold missing.", {
  readiness,
});
assert(
  typeof readiness.rollbackTrigger.shouldTriggerRollback === "boolean",
  "Rollback trigger evaluation missing.",
  { readiness }
);
assert(readiness.metrics, "Settlement authority metrics missing.", { readiness });

pass("Settlement authority controls reflect the active promotion phase.", {
  authority: readiness.authority,
  comparisonPath: readiness.runtimeRoute.comparisonPath,
  readinessStatus: readiness.status,
  rollbackReadinessStatus: readiness.rollbackReadinessStatus,
  rollbackTrigger: readiness.rollbackTrigger.shouldTriggerRollback,
  remainingBlockers: readiness.remainingBlockers,
});
