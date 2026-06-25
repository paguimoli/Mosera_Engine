import "./load-session-env.mjs";

import { existsSync } from "node:fs";

function detectRuntimeContext() {
  if (process.env.QA_RUNTIME_CONTEXT === "docker" || process.env.QA_RUNTIME_CONTEXT === "host") {
    return process.env.QA_RUNTIME_CONTEXT;
  }

  return existsSync("/.dockerenv") ? "docker" : "host";
}

function defaultAppUrl(runtimeContext) {
  return runtimeContext === "docker" ? "http://app:3000" : "http://localhost:3000";
}

function defaultLedgerServiceUrl(runtimeContext) {
  return runtimeContext === "docker"
    ? "http://ledger-service:8080"
    : "http://localhost:5200";
}

const runtimeContext = detectRuntimeContext();
const appUrl = process.env.QA_APP_URL || defaultAppUrl(runtimeContext);
const ledgerServiceUrl =
  process.env.QA_LEDGER_SERVICE_URL || defaultLedgerServiceUrl(runtimeContext);
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

function fetchFailureMetadata(error, targetName, selectedUrl) {
  let hostname = null;

  try {
    hostname = new URL(selectedUrl).hostname;
  } catch {
    hostname = null;
  }

  return {
    targetName,
    selectedUrl,
    runtimeContext,
    errorName: error?.name ?? null,
    errorMessage: error?.message ?? null,
    errorCode: error?.cause?.code ?? error?.code ?? null,
    hostname: error?.cause?.hostname ?? hostname,
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options).catch((error) => {
    fail("QA HTTP request failed.", fetchFailureMetadata(error, options.targetName ?? "unknown", url));
  });
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
    targetName: "app",
    headers: authHeaders(),
  });

  assert(result.response.status === 200 && result.body.success, "Authority status failed.", {
    status: result.response.status,
    body: result.body,
  });

  return result.body.authority;
}

async function getLedgerStabilizationStatus() {
  const result = await requestJson(
    `${appUrl}/api/authority/ledger-stabilization-status`,
    {
      targetName: "app",
      headers: authHeaders(),
    }
  );

  assert(
    result.response.status === 200 && result.body.success,
    "Ledger stabilization status failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.stabilizationStatus;
}

async function getSettlementStabilizationStatus() {
  const result = await requestJson(
    `${appUrl}/api/authority/settlement-stabilization-status?window=7d`,
    {
      targetName: "app",
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

async function executeLedgerServiceMatch(correlationId) {
  const uniqueId = Date.now();
  const transactionId = `qa-ledger-post-promotion-entry-${uniqueId}`;
  const accountId = `qa-ledger-post-promotion-account-${uniqueId}`;
  const walletId = `qa-ledger-post-promotion-wallet-${uniqueId}`;
  const idempotencyKey = `qa-ledger-post-promotion-${uniqueId}`;
  const payload = {
    correlationId,
    transactionId,
    accountId,
    walletId,
    entryType: "SETTLEMENT_CREDIT",
    direction: "CREDIT",
    amountMinor: 1250,
    currency: "USD",
    actorId: "qa-ledger-post-promotion-activity",
    idempotencyKey,
    metadata: {
      source: "qa:ledger-post-promotion-activity",
      activityType: "post-promotion-certification",
    },
    expectedMonolithResult: {
      transactionId,
      accountId,
      walletId,
      entryType: "SETTLEMENT_CREDIT",
      direction: "CREDIT",
      amountMinor: 1250,
      currency: "USD",
      idempotencyKey,
    },
  };
  const result = await requestJson(
    `${ledgerServiceUrl}/v1/ledger/shadow/execute`,
    {
      targetName: "ledger-service",
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
    "Ledger Service activity request failed.",
    { status: result.response.status, body: result.body }
  );
  assert(
    result.body.comparisonStatus === "MATCH",
    "Ledger activity must produce MATCH comparison.",
    { body: result.body }
  );
  assert(result.body.shadowLedgerRunId, "Ledger activity was not persisted.", {
    body: result.body,
  });

  return {
    payload,
    result: result.body,
  };
}

const authority = await getAuthorityStatus();
assert(authority.ledger.authority === "SERVICE", "Ledger must be SERVICE.", {
  authority,
});
assert(
  authority.ledger.comparisonMode === "ENABLED",
  "Ledger comparison mode must be ENABLED.",
  { authority }
);
assert(authority.settlement.authority === "SERVICE", "Settlement must remain SERVICE.", {
  authority,
});
assert(authority.credit.authority === "MONOLITH", "Credit authority changed.", {
  authority,
});

const settlement = await getSettlementStabilizationStatus();
assert(
  settlement.certificationStatus === "CERTIFIED",
  "Settlement must remain CERTIFIED.",
  { settlement }
);
pass("Authority controls are ready for Ledger post-promotion activity.", {
  settlement: authority.settlement.authority,
  settlementCertification: settlement.certificationStatus,
  ledger: authority.ledger.authority,
  ledgerComparisonMode: authority.ledger.comparisonMode,
  credit: authority.credit.authority,
});

const before = await getLedgerStabilizationStatus();
assert(before.promotedAt, "Ledger promotion timestamp missing.", { before });
assert(before.authority === "SERVICE", "Ledger status authority mismatch.", { before });
assert(
  before.comparisonMode === "ENABLED",
  "Ledger status comparison mode mismatch.",
  { before }
);

const correlationId = `qa-ledger-post-promotion-activity-${Date.now()}`;
const activity = await executeLedgerServiceMatch(correlationId);
pass("Ledger Service authoritative activity generated.", {
  correlationId,
  shadowLedgerRunId: activity.result.shadowLedgerRunId,
  comparisonStatus: activity.result.comparisonStatus,
});

const after = await getLedgerStabilizationStatus();

assert(after.authority === "SERVICE", "Ledger authority changed.", { after });
assert(after.comparisonMode === "ENABLED", "Ledger comparison mode changed.", { after });
assert(after.rollbackReadiness === "READY", "Ledger rollback readiness changed.", {
  after,
});
assert(
  after.ledgerEntriesProcessed > before.ledgerEntriesProcessed,
  "Stabilization status should see new post-promotion ledger activity.",
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
  after.certificationStatus === "READY_FOR_CERTIFICATION" ||
    after.certificationStatus === "CERTIFIED",
  "Ledger should be ready for certification after clean post-promotion activity.",
  { before, after }
);

const finalAuthority = await getAuthorityStatus();
assert(
  finalAuthority.settlement.authority === "SERVICE" &&
    finalAuthority.ledger.authority === "SERVICE" &&
    finalAuthority.ledger.comparisonMode === "ENABLED" &&
    finalAuthority.credit.authority === "MONOLITH",
  "Ledger post-promotion activity changed authority controls.",
  { authority: finalAuthority }
);

pass("Ledger post-promotion activity certification QA completed.", {
  before: {
    ledgerEntriesProcessed: before.ledgerEntriesProcessed,
    certificationStatus: before.certificationStatus,
  },
  after: {
    ledgerEntriesProcessed: after.ledgerEntriesProcessed,
    mismatchCount: after.mismatchCount,
    failureCount: after.failureCount,
    criticalMismatchCount: after.criticalMismatchCount,
    certificationStatus: after.certificationStatus,
  },
  recommendation: after.recommendation,
});
