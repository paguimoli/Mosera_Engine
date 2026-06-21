import "./load-session-env.mjs";

const creditServiceUrl = process.env.QA_CREDIT_SERVICE_URL || "http://localhost:5300";

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

const health = await requestJson(`${creditServiceUrl}/health`);
assert(health.response.status === 200, "Credit Wallet service health failed.", {
  status: health.response.status,
  body: health.body,
});
pass("Credit Wallet service health returned 200.");

const runId = `${Date.now()}`;
const correlationId = `qa-credit-shadow-${runId}`;
const basePayload = {
  correlationId,
  accountId: `qa-credit-account-${runId}`,
  walletId: `qa-credit-wallet-${runId}`,
  ticketId: `qa-credit-ticket-${runId}`,
  reservationId: `qa-credit-reservation-${runId}`,
  amountMinor: 1000,
  currency: "USD",
  availableCreditBefore: 5000,
  pendingExposureBefore: 0,
  metadata: { source: "qa:credit-shadow" },
};

const reserve = await executeShadow("reserve", {
  ...basePayload,
  expectedMonolithResult: {
    amountMinor: 1000,
    availableCreditAfter: 4000,
    reservedAmount: 1000,
    currency: "USD",
  },
});
assert(reserve.response.status === 200, "RESERVE shadow request failed.", {
  status: reserve.response.status,
  body: reserve.body,
});
assert(reserve.body.comparisonStatus === "MATCH", "RESERVE did not match.", {
  body: reserve.body,
});
pass("RESERVE shadow execution completed.", {
  shadowCreditRunId: reserve.body.shadowCreditRunId ?? null,
});

const release = await executeShadow("release", {
  ...basePayload,
  remainingExposureBefore: 1000,
  releasedAmountBefore: 0,
  expectedMonolithResult: {
    amountMinor: 1000,
    availableCreditAfter: 6000,
    releasedAmount: 1000,
    remainingExposure: 0,
    currency: "USD",
  },
});
assert(release.response.status === 200, "RELEASE shadow request failed.", {
  status: release.response.status,
  body: release.body,
});
assert(release.body.comparisonStatus === "MATCH", "RELEASE did not match.", {
  body: release.body,
});
pass("RELEASE shadow execution completed.", {
  shadowCreditRunId: release.body.shadowCreditRunId ?? null,
});

const settlement = await executeShadow("settlement", {
  ...basePayload,
  remainingExposureBefore: 1000,
  releasedAmountBefore: 0,
  balanceBefore: 0,
  balanceImpactMinor: 2500,
  expectedMonolithResult: {
    amountMinor: 1000,
    availableCreditAfter: 8500,
    releasedAmount: 1000,
    remainingExposure: 0,
    balanceImpact: 2500,
    currency: "USD",
  },
});
assert(settlement.response.status === 200, "SETTLEMENT shadow request failed.", {
  status: settlement.response.status,
  body: settlement.body,
});
assert(settlement.body.comparisonStatus === "MATCH", "SETTLEMENT did not match.", {
  body: settlement.body,
});
pass("SETTLEMENT shadow execution completed.", {
  shadowCreditRunId: settlement.body.shadowCreditRunId ?? null,
});

const mismatch = await executeShadow("reserve", {
  ...basePayload,
  ticketId: `${basePayload.ticketId}-mismatch`,
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
    mismatch.body.mismatches.length > 0,
  "MISMATCH request did not report mismatches.",
  { body: mismatch.body }
);
pass("MISMATCH shadow execution completed.", {
  mismatchCount: mismatch.body.mismatches.length,
  shadowCreditRunId: mismatch.body.shadowCreditRunId ?? null,
});

const failure = await executeShadow("release", {
  ...basePayload,
  ticketId: `${basePayload.ticketId}-failure`,
  reservationId: `${basePayload.reservationId}-failure`,
  amountMinor: 1500,
  remainingExposureBefore: 1000,
  releasedAmountBefore: 0,
  expectedMonolithResult: {
    amountMinor: 1500,
    remainingExposure: -500,
    currency: "USD",
  },
});
assert(failure.response.status === 400, "FAILURE shadow request should fail validation.", {
  status: failure.response.status,
  body: failure.body,
});
pass("FAILURE shadow validation path completed.", { correlationId });

pass("Credit shadow mode QA completed.", { correlationId });
