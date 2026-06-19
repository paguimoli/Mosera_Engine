const ledgerServiceUrl = process.env.QA_LEDGER_SERVICE_URL || "http://localhost:5200";

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

async function executeShadow(payload) {
  return requestJson(`${ledgerServiceUrl}/v1/ledger/shadow/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": payload.correlationId,
    },
    body: JSON.stringify(payload),
  });
}

const health = await requestJson(`${ledgerServiceUrl}/health`);
assert(health.response.status === 200, "Ledger service health failed.", {
  status: health.response.status,
  body: health.body,
});
pass("Ledger service health returned 200.");

const runId = `${Date.now()}`;
const correlationId = `qa-ledger-shadow-${runId}`;
const basePayload = {
  correlationId,
  transactionId: `qa-ledger-transaction-${runId}`,
  accountId: `qa-ledger-account-${runId}`,
  walletId: `qa-ledger-wallet-${runId}`,
  entryType: "MANUAL_CREDIT_ADJUSTMENT",
  direction: "CREDIT",
  amountMinor: 1000,
  currency: "USD",
  actorId: "qa-ledger-actor",
  idempotencyKey: `qa-ledger-idempotency-${runId}`,
  metadata: {
    source: "qa:ledger-shadow",
  },
};

const match = await executeShadow({
  ...basePayload,
  expectedMonolithResult: {
    transactionId: basePayload.transactionId,
    accountId: basePayload.accountId,
    walletId: basePayload.walletId,
    entryType: basePayload.entryType,
    direction: basePayload.direction,
    amountMinor: basePayload.amountMinor,
    currency: basePayload.currency,
    idempotencyKey: basePayload.idempotencyKey,
  },
});
assert(match.response.status === 200, "MATCH shadow request failed.", {
  status: match.response.status,
  body: match.body,
});
assert(match.body.comparisonStatus === "MATCH", "MATCH request did not match.", {
  body: match.body,
});
pass("MATCH shadow execution completed.", {
  shadowLedgerRunId: match.body.shadowLedgerRunId ?? null,
});

const mismatch = await executeShadow({
  ...basePayload,
  transactionId: `${basePayload.transactionId}-mismatch`,
  expectedMonolithResult: {
    transactionId: `${basePayload.transactionId}-mismatch`,
    accountId: basePayload.accountId,
    walletId: basePayload.walletId,
    entryType: "MANUAL_DEBIT_ADJUSTMENT",
    direction: "DEBIT",
    amountMinor: 900,
    currency: "USD",
    idempotencyKey: basePayload.idempotencyKey,
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
  shadowLedgerRunId: mismatch.body.shadowLedgerRunId ?? null,
});

const failure = await executeShadow({
  ...basePayload,
  transactionId: `${basePayload.transactionId}-failure`,
  amountMinor: 0,
  expectedMonolithResult: {
    transactionId: `${basePayload.transactionId}-failure`,
    accountId: basePayload.accountId,
    walletId: basePayload.walletId,
    entryType: basePayload.entryType,
    direction: basePayload.direction,
    amountMinor: 0,
    currency: basePayload.currency,
    idempotencyKey: basePayload.idempotencyKey,
  },
});
assert(failure.response.status === 400, "FAILURE shadow request should fail validation.", {
  status: failure.response.status,
  body: failure.body,
});
pass("FAILURE shadow validation path completed.", {
  correlationId,
});

pass("Ledger shadow mode QA completed.", { correlationId });
