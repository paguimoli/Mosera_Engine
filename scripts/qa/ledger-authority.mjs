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

function authHeaders() {
  if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN is required.");

  return { authorization: `Bearer ${sessionToken}` };
}

const unauthenticated = await requestJson("/api/authority/ledger-readiness");
assert(unauthenticated.response.status === 401, "Ledger readiness should require auth.", {
  status: unauthenticated.response.status,
  body: unauthenticated.body,
});
pass("Ledger readiness endpoint requires auth.");

const result = await requestJson("/api/authority/ledger-readiness", {
  headers: authHeaders(),
});
assert(result.response.status === 200 && result.body.success, "Ledger readiness failed.", {
  status: result.response.status,
  body: result.body,
});

const readiness = result.body.readiness;
assert(
  readiness.authority === "MONOLITH" || readiness.authority === "SERVICE",
  "Ledger authority has an unsupported value.",
  { readiness }
);
assert(readiness.comparisonMode === "ENABLED", "Ledger comparison must remain ENABLED.", {
  readiness,
});
assert(
  readiness.runtimeRoute.productionCutoverActive === (readiness.authority === "SERVICE"),
  "Ledger production cutover flag does not match authority.",
  { readiness }
);
assert(
  readiness.runtimeRoute.comparisonPath ===
    (readiness.authority === "SERVICE" ? "MONOLITH" : "LEDGER_SERVICE"),
  "Ledger comparison path mismatch.",
  { readiness }
);

pass("Ledger authority readiness is reported.", {
  authority: readiness.authority,
  comparisonMode: readiness.comparisonMode,
  readinessStatus: readiness.status,
  rollbackReadinessStatus: readiness.rollbackReadinessStatus,
  remainingBlockers: readiness.remainingBlockers,
});
