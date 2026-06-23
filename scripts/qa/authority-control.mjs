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

const unauthenticated = await requestJson("/api/authority/status");
assert(
  unauthenticated.response.status === 401,
  "Authority status endpoint should require authentication.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Authority status endpoint requires auth.");

if (!sessionToken) {
  fail("QA_ADMIN_SESSION_TOKEN is required.");
}

const authHeaders = { authorization: `Bearer ${sessionToken}` };
const statusResult = await requestJson("/api/authority/status", {
  headers: authHeaders,
});
assert(
  statusResult.response.status === 200 && statusResult.body.success,
  "Authority status endpoint failed.",
  { status: statusResult.response.status, body: statusResult.body }
);

const authority = statusResult.body.authority;
assert(
  authority.settlement.authority === "MONOLITH" ||
    authority.settlement.authority === "SERVICE",
  "Settlement authority has an unsupported value.",
  { config: authority.settlement }
);
assert(
  authority.ledger.authority === "MONOLITH" || authority.ledger.authority === "SERVICE",
  "Ledger authority has an unsupported value.",
  { config: authority.ledger }
);
assert(authority.credit.authority === "MONOLITH", "Credit authority changed.", {
  config: authority.credit,
});
for (const domain of ["settlement", "ledger", "credit"]) {
  assert(
    authority[domain].comparisonMode === "ENABLED",
    "Comparison mode changed.",
    { domain, config: authority[domain] }
  );
  assert(
    typeof authority[domain].mismatchAlertThreshold === "number",
    "Mismatch alert threshold missing.",
    { domain, config: authority[domain] }
  );
}
pass("Authority controls are safe.", {
  settlement: authority.settlement.authority,
  ledger: authority.ledger.authority,
  credit: authority.credit.authority,
});

const readinessResult = await requestJson("/api/authority/rollback-readiness", {
  headers: authHeaders,
});
assert(
  readinessResult.response.status === 200 && readinessResult.body.success,
  "Rollback readiness endpoint failed.",
  { status: readinessResult.response.status, body: readinessResult.body }
);

const readiness = readinessResult.body.rollbackReadiness;
assert(readiness.overallStatus, "Overall rollback readiness missing.", {
  readiness,
});
for (const domain of ["settlement", "ledger", "credit"]) {
  assert(
    typeof readiness[domain].serviceHealth.available === "boolean",
    "Service health did not participate in rollback readiness.",
    { domain, readiness: readiness[domain] }
  );
}
pass("Rollback readiness includes service health.", {
  overallStatus: readiness.overallStatus,
});

pass("Authority control QA completed.", {
  overallStatus: readiness.overallStatus,
});
