import "./load-session-env.mjs";

const settlementServiceUrl =
  process.env.QA_SETTLEMENT_SERVICE_URL || "http://localhost:5400";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function pass(message, metadata = {}) {
  console.log(JSON.stringify({ status: "PASS", message, ...metadata }, null, 2));
}

async function request(path, options = {}) {
  const response = await fetch(`${settlementServiceUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

function assert(condition, message, metadata = {}) {
  if (!condition) {
    fail(message, metadata);
  }
}

const correlationId = `qa-settlement-shadow-${Date.now()}`;

const basePayload = {
  correlationId,
  settlementRunId: "qa-shadow-run-1",
  ticketId: "qa-shadow-ticket-1",
  drawingId: "qa-shadow-drawing-1",
  gameId: "qa-shadow-game-1",
  wagerType: "selection-match",
  stakeAmount: 1000,
  currency: "USD",
  selectedNumbers: [1, 2, 3],
  winningNumbers: [1, 2, 3, 4, 5],
};

const health = await request("/health");
assert(health.response.status === 200, "Settlement service health failed.", {
  status: health.response.status,
  body: health.body,
});
pass("Settlement service health returned 200.");

const match = await request("/v1/settlement/shadow/execute", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-correlation-id": correlationId,
  },
  body: JSON.stringify({
    ...basePayload,
    expectedMonolithResult: {
      calculatedOutcome: "WIN",
      grossPayout: 2000,
      netAmount: 1000,
      stakeAmount: 1000,
      currency: "USD",
    },
  }),
});

assert(match.response.status === 200, "Shadow match request failed.", {
  status: match.response.status,
  body: match.body,
});
assert(match.body.comparisonStatus === "MATCH", "Expected MATCH comparison.", {
  body: match.body,
});
assert(match.body.calculatedOutcome === "WIN", "Expected WIN outcome.", {
  body: match.body,
});
pass("Shadow comparison returned MATCH for matching monolith result.");

const mismatch = await request("/v1/settlement/shadow/execute", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-correlation-id": correlationId,
  },
  body: JSON.stringify({
    ...basePayload,
    expectedMonolithResult: {
      calculatedOutcome: "LOSS",
      grossPayout: 0,
      netAmount: -1000,
      stakeAmount: 1000,
      currency: "USD",
    },
  }),
});

assert(mismatch.response.status === 200, "Shadow mismatch request failed.", {
  status: mismatch.response.status,
  body: mismatch.body,
});
assert(
  mismatch.body.comparisonStatus === "MISMATCH",
  "Expected MISMATCH comparison.",
  { body: mismatch.body }
);
assert(
  Array.isArray(mismatch.body.mismatches) && mismatch.body.mismatches.length > 0,
  "Expected mismatch details.",
  { body: mismatch.body }
);
pass("Shadow comparison returned MISMATCH for differing monolith result.");

assert(
  process.env.SETTLEMENT_SHADOW_MODE_ENABLED !== "true",
  "Monolith shadow mode should be disabled by default for QA.",
  {
    SETTLEMENT_SHADOW_MODE_ENABLED:
      process.env.SETTLEMENT_SHADOW_MODE_ENABLED ?? null,
  }
);
pass("Monolith settlement shadow mode remains disabled by default.");

pass("Settlement shadow-mode QA completed.", { correlationId });
