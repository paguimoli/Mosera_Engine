import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const creditServiceUrl = process.env.QA_CREDIT_SERVICE_URL || "http://localhost:5300";
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

async function executeShadow(operation, payload) {
  return requestJson(`${creditServiceUrl}/v1/credit/shadow/${operation}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": payload.correlationId,
    },
    body: JSON.stringify(payload),
  });
}

const runId = `${Date.now()}`;
const correlationId = `qa-credit-shadow-reporting-${runId}`;
const basePayload = {
  correlationId,
  accountId: `qa-credit-reporting-account-${runId}`,
  walletId: `qa-credit-reporting-wallet-${runId}`,
  ticketId: `qa-credit-reporting-ticket-${runId}`,
  reservationId: `qa-credit-reporting-reservation-${runId}`,
  amountMinor: 1000,
  currency: "USD",
  availableCreditBefore: 5000,
  metadata: { source: "qa:credit-shadow-reporting" },
};

const match = await executeShadow("reserve", {
  ...basePayload,
  expectedMonolithResult: {
    amountMinor: 1000,
    availableCreditAfter: 4000,
    reservedAmount: 1000,
    currency: "USD",
  },
});
assert(match.response.status === 200, "MATCH shadow request failed.", {
  status: match.response.status,
  body: match.body,
});
assert(match.body.shadowCreditRunId, "MATCH shadow run was not persisted.", {
  body: match.body,
});
pass("MATCH credit shadow run persisted.", {
  shadowCreditRunId: match.body.shadowCreditRunId,
});

const mismatchTicketId = `${basePayload.ticketId}-mismatch`;
const mismatch = await executeShadow("reserve", {
  ...basePayload,
  ticketId: mismatchTicketId,
  expectedMonolithResult: {
    amountMinor: 500,
    availableCreditAfter: 4500,
    reservedAmount: 500,
    currency: "CRC",
  },
});
assert(mismatch.response.status === 200, "MISMATCH shadow request failed.", {
  status: mismatch.response.status,
  body: mismatch.body,
});
assert(
  mismatch.body.comparisonStatus === "MISMATCH" &&
    mismatch.body.shadowCreditRunId,
  "MISMATCH shadow run was not persisted.",
  { body: mismatch.body }
);
pass("MISMATCH credit shadow run persisted.", {
  shadowCreditRunId: mismatch.body.shadowCreditRunId,
  mismatchCount: mismatch.body.mismatches.length,
});

const failureReservationId = `${basePayload.reservationId}-failure`;
const failureTicketId = `${basePayload.ticketId}-failure`;
const failure = await executeShadow("release", {
  ...basePayload,
  ticketId: failureTicketId,
  reservationId: failureReservationId,
  amountMinor: 1500,
  remainingExposureBefore: 1000,
  releasedAmountBefore: 0,
  expectedMonolithResult: {
    amountMinor: 1500,
    remainingExposure: -500,
    currency: "USD",
  },
});
assert(failure.response.status === 400, "FAILURE shadow request should fail.", {
  status: failure.response.status,
  body: failure.body,
});
pass("FAILURE credit shadow request persisted by best-effort path.");

const summary = await authGet("/api/credit-shadow/summary");
assert(summary.response.status === 200 && summary.body.success, "Summary endpoint failed.", {
  status: summary.response.status,
  body: summary.body,
});
assert(summary.body.summary.totalRuns >= 2, "Summary did not include credit shadow runs.", {
  summary: summary.body.summary,
});
assert(summary.body.summary.failures >= 1, "Summary did not include credit shadow failures.", {
  summary: summary.body.summary,
});
pass("Summary endpoint returned credit shadow metrics.", {
  readiness: summary.body.summary.readiness.status,
});

const mismatches = await authGet(
  `/api/credit-shadow/mismatches?ticketId=${encodeURIComponent(mismatchTicketId)}`
);
assert(
  mismatches.response.status === 200 &&
    mismatches.body.success &&
    mismatches.body.mismatches.length > 0,
  "Mismatch endpoint did not return persisted credit mismatch.",
  { status: mismatches.response.status, body: mismatches.body }
);
pass("Mismatch endpoint returned credit shadow records.", {
  count: mismatches.body.mismatches.length,
});

const failures = await authGet(
  `/api/credit-shadow/failures?reservationId=${encodeURIComponent(
    failureReservationId
  )}`
);
assert(
  failures.response.status === 200 &&
    failures.body.success &&
    failures.body.failures.length > 0,
  "Failure endpoint did not return persisted credit failure.",
  { status: failures.response.status, body: failures.body }
);
pass("Failure endpoint returned credit shadow records.", {
  count: failures.body.failures.length,
});

pass("Credit shadow reporting QA completed.", { correlationId });
