const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const ledgerServiceUrl = process.env.QA_LEDGER_SERVICE_URL || "http://localhost:5200";
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
  return requestJson(`${ledgerServiceUrl}/v1/ledger/shadow/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": payload.correlationId,
    },
    body: JSON.stringify(payload),
  });
}

const runId = `${Date.now()}`;
const correlationId = `qa-ledger-shadow-reporting-${runId}`;
const basePayload = {
  correlationId,
  transactionId: `qa-ledger-reporting-${runId}`,
  accountId: `qa-ledger-reporting-account-${runId}`,
  walletId: `qa-ledger-reporting-wallet-${runId}`,
  entryType: "MANUAL_CREDIT_ADJUSTMENT",
  direction: "CREDIT",
  amountMinor: 1000,
  currency: "USD",
  actorId: "qa-ledger-actor",
  idempotencyKey: `qa-ledger-reporting-idempotency-${runId}`,
  metadata: {
    source: "qa:ledger-shadow-reporting",
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
assert(match.body.shadowLedgerRunId, "MATCH shadow run was not persisted.", {
  body: match.body,
});
pass("MATCH ledger shadow run persisted.", {
  shadowLedgerRunId: match.body.shadowLedgerRunId,
});

const mismatchTransactionId = `${basePayload.transactionId}-mismatch`;
const mismatch = await executeShadow({
  ...basePayload,
  transactionId: mismatchTransactionId,
  expectedMonolithResult: {
    transactionId: mismatchTransactionId,
    accountId: basePayload.accountId,
    walletId: basePayload.walletId,
    entryType: "MANUAL_DEBIT_ADJUSTMENT",
    direction: "DEBIT",
    amountMinor: 500,
    currency: "CRC",
    idempotencyKey: `${basePayload.idempotencyKey}-other`,
  },
});
assert(mismatch.response.status === 200, "MISMATCH shadow request failed.", {
  status: mismatch.response.status,
  body: mismatch.body,
});
assert(
  mismatch.body.comparisonStatus === "MISMATCH" &&
    mismatch.body.shadowLedgerRunId,
  "MISMATCH shadow run was not persisted.",
  { body: mismatch.body }
);
pass("MISMATCH ledger shadow run persisted.", {
  shadowLedgerRunId: mismatch.body.shadowLedgerRunId,
  mismatchCount: mismatch.body.mismatches.length,
});

const failureTransactionId = `${basePayload.transactionId}-failure`;
const failure = await executeShadow({
  ...basePayload,
  transactionId: failureTransactionId,
  amountMinor: 0,
  expectedMonolithResult: {
    transactionId: failureTransactionId,
    accountId: basePayload.accountId,
    walletId: basePayload.walletId,
    entryType: basePayload.entryType,
    direction: basePayload.direction,
    amountMinor: 0,
    currency: basePayload.currency,
    idempotencyKey: basePayload.idempotencyKey,
  },
});
assert(failure.response.status === 400, "FAILURE shadow request should fail.", {
  status: failure.response.status,
  body: failure.body,
});
pass("FAILURE ledger shadow request persisted by best-effort path.");

const summary = await authGet("/api/ledger-shadow/summary");
assert(summary.response.status === 200 && summary.body.success, "Summary endpoint failed.", {
  status: summary.response.status,
  body: summary.body,
});
assert(summary.body.summary.totalRuns >= 2, "Summary did not include ledger shadow runs.", {
  summary: summary.body.summary,
});
assert(summary.body.summary.failures >= 1, "Summary did not include ledger shadow failures.", {
  summary: summary.body.summary,
});
pass("Summary endpoint returned ledger shadow metrics.", {
  readiness: summary.body.summary.readiness.status,
});

const mismatches = await authGet(
  `/api/ledger-shadow/mismatches?transactionId=${encodeURIComponent(
    mismatchTransactionId
  )}`
);
assert(
  mismatches.response.status === 200 &&
    mismatches.body.success &&
    mismatches.body.mismatches.length > 0,
  "Mismatch endpoint did not return persisted ledger mismatch.",
  { status: mismatches.response.status, body: mismatches.body }
);
pass("Mismatch endpoint returned ledger shadow records.", {
  count: mismatches.body.mismatches.length,
});

const failures = await authGet(
  `/api/ledger-shadow/failures?transactionId=${encodeURIComponent(
    failureTransactionId
  )}`
);
assert(
  failures.response.status === 200 &&
    failures.body.success &&
    failures.body.failures.length > 0,
  "Failure endpoint did not return persisted ledger failure.",
  { status: failures.response.status, body: failures.body }
);
pass("Failure endpoint returned ledger shadow records.", {
  count: failures.body.failures.length,
});

pass("Ledger shadow reporting QA completed.", { correlationId });
