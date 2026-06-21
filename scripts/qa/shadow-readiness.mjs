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

const unauthenticated = await requestJson("/api/shadow-readiness");
assert(
  unauthenticated.response.status === 401,
  "Shadow readiness endpoint should require authentication.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Protected endpoint requires auth.");

if (!sessionToken) {
  fail("QA_ADMIN_SESSION_TOKEN is required.");
}

async function authGet(window) {
  return requestJson(`/api/shadow-readiness?window=${window}`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}

const sevenDay = await authGet("7d");
assert(
  sevenDay.response.status === 200 && sevenDay.body.success,
  "Shadow readiness endpoint failed.",
  { status: sevenDay.response.status, body: sevenDay.body }
);

const readiness = sevenDay.body.readiness;
assert(readiness.window === "7d", "Default requested window was not applied.", {
  readiness,
});
assert(readiness.domains.settlement, "Settlement metrics missing.", { readiness });
assert(readiness.domains.ledger, "Ledger metrics missing.", { readiness });
assert(readiness.domains.credit, "Credit metrics missing.", { readiness });
assert(readiness.platform.platformStatus, "Platform readiness missing.", {
  readiness,
});
assert(
  readiness.extractionRecommendation,
  "Extraction recommendation missing.",
  { readiness }
);
pass("Shadow readiness aggregated all domains.", {
  platformStatus: readiness.platform.platformStatus,
  recommendation: readiness.extractionRecommendation,
});

for (const window of ["24h", "30d", "all"]) {
  const result = await authGet(window);
  assert(
    result.response.status === 200 &&
      result.body.success &&
      result.body.readiness.window === window,
    "Window filtering failed.",
    { window, status: result.response.status, body: result.body }
  );
}
pass("Window filtering works.");

pass("Shadow readiness QA completed.", {
  recommendation: readiness.extractionRecommendation,
});
