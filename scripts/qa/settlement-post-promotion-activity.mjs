import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const settlementServiceUrl =
  process.env.QA_SETTLEMENT_SERVICE_URL || "http://host.docker.internal:5400";
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

function authHeaders(extra = {}) {
  if (!sessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN is required.");
  }

  return {
    authorization: `Bearer ${sessionToken}`,
    ...extra,
  };
}

async function getAuthorityStatus() {
  const result = await requestJson(`${appUrl}/api/authority/status`, {
    headers: authHeaders(),
  });

  assert(result.response.status === 200 && result.body.success, "Authority status failed.", {
    status: result.response.status,
    body: result.body,
  });

  return result.body.authority;
}

async function getStabilizationStatus() {
  const result = await requestJson(
    `${appUrl}/api/authority/settlement-stabilization-status?window=7d`,
    {
      headers: authHeaders(),
    }
  );

  assert(
    result.response.status === 200 && result.body.success,
    "Settlement stabilization status failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.stabilizationStatus;
}

async function executeSettlementServiceMatch(correlationId) {
  const runId = `${Date.now()}`;
  const payload = {
    correlationId,
    settlementRunId: `qa-post-promotion-run-${runId}`,
    ticketId: `qa-post-promotion-ticket-${runId}`,
    drawingId: `qa-post-promotion-drawing-${runId}`,
    gameId: "qa-post-promotion-activity",
    wagerType: "selection-match",
    stakeAmount: 1000,
    currency: "USD",
    selectedNumbers: [1, 2, 3],
    winningNumbers: [1, 2, 3, 4, 5],
    expectedMonolithResult: {
      calculatedOutcome: "WIN",
      grossPayout: 2000,
      netAmount: 1000,
      stakeAmount: 1000,
      currency: "USD",
    },
    metadata: {
      source: "qa:settlement-post-promotion-activity",
    },
  };
  const result = await requestJson(
    `${settlementServiceUrl}/v1/settlement/shadow/execute`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify(payload),
    }
  );

  assert(
    result.response.status === 200 && result.body.success === true,
    "Settlement Service activity request failed.",
    { status: result.response.status, body: result.body }
  );
  assert(
    result.body.comparisonStatus === "MATCH",
    "Settlement activity must produce MATCH comparison.",
    { body: result.body }
  );
  assert(result.body.persistedShadowRunId, "Settlement activity was not persisted.", {
    body: result.body,
  });

  return {
    payload,
    result: result.body,
  };
}

const authority = await getAuthorityStatus();
assert(authority.settlement.authority === "SERVICE", "Settlement must be SERVICE.", {
  authority,
});
assert(
  authority.settlement.comparisonMode === "ENABLED",
  "Settlement comparison mode must be ENABLED.",
  { authority }
);
assert(authority.ledger.authority === "MONOLITH", "Ledger authority changed.", {
  authority,
});
assert(authority.credit.authority === "MONOLITH", "Credit authority changed.", {
  authority,
});
pass("Authority controls are ready for post-promotion activity.", {
  settlement: authority.settlement.authority,
  comparisonMode: authority.settlement.comparisonMode,
  ledger: authority.ledger.authority,
  credit: authority.credit.authority,
});

const before = await getStabilizationStatus();
const correlationId = `qa-post-promotion-activity-${Date.now()}`;
let activity = null;

if (before.certificationStatus !== "READY_FOR_CERTIFICATION") {
  activity = await executeSettlementServiceMatch(correlationId);
  pass("Settlement Service authoritative activity generated.", {
    correlationId,
    persistedShadowRunId: activity.result.persistedShadowRunId,
    comparisonStatus: activity.result.comparisonStatus,
  });
} else {
  pass("Existing post-promotion activity already supports certification.", {
    settlementsProcessed: before.settlementsProcessed,
    certificationStatus: before.certificationStatus,
  });
}

const after = await getStabilizationStatus();

assert(after.authority === "SERVICE", "Settlement authority changed.", { after });
assert(after.comparisonMode === "ENABLED", "Comparison mode changed.", { after });
assert(after.rollbackReadiness === "READY", "Rollback readiness changed.", {
  after,
});
assert(
  after.settlementsProcessed > 0,
  "Stabilization status should see post-promotion settlement activity.",
  { before, after, activity }
);
assert(after.mismatchCount === 0, "Post-promotion mismatch count should be zero.", {
  before,
  after,
});
assert(after.failureCount === 0, "Post-promotion failure count should be zero.", {
  before,
  after,
});
assert(
  after.criticalMismatchCount === 0,
  "Post-promotion critical mismatch count should be zero.",
  { before, after }
);
assert(
  after.certificationStatus === "READY_FOR_CERTIFICATION",
  "Settlement should be ready for operator certification.",
  { before, after }
);
pass("Settlement post-promotion activity certification QA completed.", {
  before: {
    settlementsProcessed: before.settlementsProcessed,
    certificationStatus: before.certificationStatus,
  },
  after: {
    settlementsProcessed: after.settlementsProcessed,
    mismatchCount: after.mismatchCount,
    failureCount: after.failureCount,
    criticalMismatchCount: after.criticalMismatchCount,
    certificationStatus: after.certificationStatus,
  },
});
