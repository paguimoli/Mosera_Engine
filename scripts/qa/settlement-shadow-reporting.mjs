import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const settlementServiceUrl =
  process.env.QA_SETTLEMENT_SERVICE_URL || "http://localhost:5400";
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

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

async function authGet(path) {
  if (!sessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN is required.");
  }

  return requestJson(`${appUrl}${path}`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}

async function executeShadow(payload) {
  return requestJson(`${settlementServiceUrl}/v1/settlement/shadow/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": payload.correlationId,
    },
    body: JSON.stringify(payload),
  });
}

const runId = `${Date.now()}`;
const correlationId = `qa-shadow-reporting-${runId}`;
const ticketId = `qa-shadow-ticket-${runId}`;
const basePayload = {
  correlationId,
  settlementRunId: `qa-shadow-run-${runId}`,
  ticketId,
  drawingId: `qa-shadow-drawing-${runId}`,
  gameId: "qa-shadow-game-reporting",
  wagerType: "selection-match",
  stakeAmount: 1000,
  currency: "USD",
  selectedNumbers: [1, 2, 3],
  winningNumbers: [1, 2, 3, 4, 5],
};

const match = await executeShadow({
  ...basePayload,
  expectedMonolithResult: {
    calculatedOutcome: "WIN",
    grossPayout: 2000,
    netAmount: 1000,
    stakeAmount: 1000,
    currency: "USD",
  },
});
assert(match.response.status === 200, "MATCH shadow request failed.", {
  status: match.response.status,
  body: match.body,
});
assert(match.body.persistedShadowRunId, "MATCH shadow run was not persisted.", {
  body: match.body,
});
pass("MATCH shadow run persisted.", {
  persistedShadowRunId: match.body.persistedShadowRunId,
});

const mismatch = await executeShadow({
  ...basePayload,
  ticketId: `${ticketId}-mismatch`,
  expectedMonolithResult: {
    calculatedOutcome: "LOSS",
    grossPayout: 0,
    netAmount: -1000,
    stakeAmount: 1000,
    currency: "USD",
  },
});
assert(mismatch.response.status === 200, "MISMATCH shadow request failed.", {
  status: mismatch.response.status,
  body: mismatch.body,
});
assert(
  mismatch.body.comparisonStatus === "MISMATCH" &&
    mismatch.body.persistedShadowRunId,
  "MISMATCH shadow run was not persisted.",
  { body: mismatch.body }
);
pass("MISMATCH shadow run persisted.", {
  persistedShadowRunId: mismatch.body.persistedShadowRunId,
});

const failure = await executeShadow({
  ...basePayload,
  ticketId: `${ticketId}-failure`,
  stakeAmount: 0,
  expectedMonolithResult: {
    calculatedOutcome: "LOSS",
    grossPayout: 0,
    netAmount: 0,
    stakeAmount: 0,
    currency: "USD",
  },
});
assert(failure.response.status === 400, "FAILURE shadow request should fail.", {
  status: failure.response.status,
  body: failure.body,
});
pass("FAILURE shadow request persisted by service best-effort path.");

const summary = await authGet("/api/settlement-shadow/summary");
assert(summary.response.status === 200 && summary.body.success, "Summary endpoint failed.", {
  status: summary.response.status,
  body: summary.body,
});
assert(summary.body.summary.totalRuns >= 2, "Summary did not include shadow runs.", {
  summary: summary.body.summary,
});
assert(summary.body.summary.failures >= 1, "Summary did not include failures.", {
  summary: summary.body.summary,
});
pass("Summary endpoint returned shadow metrics.", {
  readiness: summary.body.summary.readiness.status,
});

const mismatches = await authGet(
  `/api/settlement-shadow/mismatches?ticketId=${encodeURIComponent(
    `${ticketId}-mismatch`
  )}`
);
assert(
  mismatches.response.status === 200 &&
    mismatches.body.success &&
    mismatches.body.mismatches.length > 0,
  "Mismatch endpoint did not return persisted mismatch.",
  { status: mismatches.response.status, body: mismatches.body }
);
pass("Mismatch endpoint returned persisted records.", {
  count: mismatches.body.mismatches.length,
});

const failures = await authGet(
  `/api/settlement-shadow/failures?ticketId=${encodeURIComponent(
    `${ticketId}-failure`
  )}`
);
assert(
  failures.response.status === 200 &&
    failures.body.success &&
    failures.body.failures.length > 0,
  "Failure endpoint did not return persisted failure.",
  { status: failures.response.status, body: failures.body }
);
pass("Failure endpoint returned persisted records.", {
  count: failures.body.failures.length,
});

pass("Settlement shadow reporting QA completed.", { correlationId });
