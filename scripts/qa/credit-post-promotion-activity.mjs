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

function defaultCreditServiceUrl(runtimeContext) {
  return runtimeContext === "docker"
    ? "http://credit-wallet-service:8080"
    : "http://localhost:5300";
}

const runtimeContext = detectRuntimeContext();
const appUrl = process.env.QA_APP_URL || defaultAppUrl(runtimeContext);
const creditServiceUrl =
  process.env.QA_CREDIT_SERVICE_URL || defaultCreditServiceUrl(runtimeContext);
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
  if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN is required.");

  return {
    authorization: `Bearer ${sessionToken}`,
    ...extra,
  };
}

async function authGet(path) {
  return requestJson(`${appUrl}${path}`, {
    targetName: "app",
    headers: authHeaders(),
  });
}

async function getAuthorityStatus() {
  const result = await authGet("/api/authority/status");

  assert(result.response.status === 200 && result.body.success, "Authority status failed.", {
    status: result.response.status,
    body: result.body,
  });

  return result.body.authority;
}

async function getCreditStabilizationStatus() {
  const result = await authGet("/api/authority/credit-stabilization-status");

  assert(
    result.response.status === 200 && result.body.success,
    "Credit stabilization status failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.stabilizationStatus;
}

async function getSettlementStabilizationStatus() {
  const result = await authGet("/api/authority/settlement-stabilization-status?window=7d");

  assert(
    result.response.status === 200 && result.body.success,
    "Settlement stabilization status failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.stabilizationStatus;
}

async function getLedgerStabilizationStatus() {
  const result = await authGet("/api/authority/ledger-stabilization-status");

  assert(
    result.response.status === 200 && result.body.success,
    "Ledger stabilization status failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.stabilizationStatus;
}

async function executeCreditServiceMatch(correlationId) {
  const uniqueId = Date.now();
  const amountMinor = 1250;
  const availableCreditBefore = 10000;
  const payload = {
    correlationId,
    accountId: `qa-credit-post-promotion-account-${uniqueId}`,
    walletId: `qa-credit-post-promotion-wallet-${uniqueId}`,
    ticketId: `qa-credit-post-promotion-ticket-${uniqueId}`,
    reservationId: `qa-credit-post-promotion-reservation-${uniqueId}`,
    amountMinor,
    currency: "USD",
    availableCreditBefore,
    metadata: {
      source: "qa:credit-post-promotion-activity",
      activityType: "post-promotion-certification",
    },
    expectedMonolithResult: {
      amountMinor,
      availableCreditAfter: availableCreditBefore - amountMinor,
      reservedAmount: amountMinor,
      currency: "USD",
    },
  };
  const result = await requestJson(
    `${creditServiceUrl}/v1/credit/shadow/reserve`,
    {
      targetName: "credit-wallet-service",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify(payload),
    }
  );

  assert(
    result.response.status === 200,
    "Credit Wallet Service activity request failed.",
    { status: result.response.status, body: result.body }
  );
  assert(
    result.body.comparisonStatus === "MATCH",
    "Credit activity must produce MATCH comparison.",
    { body: result.body }
  );
  assert(result.body.shadowCreditRunId, "Credit activity was not persisted.", {
    body: result.body,
  });

  return {
    payload,
    result: result.body,
  };
}

const unauthenticated = await requestJson(
  `${appUrl}/api/authority/credit-stabilization-status`,
  { targetName: "app" }
);
assert(
  unauthenticated.response.status === 401,
  "Credit stabilization status should require auth.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Credit stabilization endpoint requires auth.");

const [authority, settlement, ledger] = await Promise.all([
  getAuthorityStatus(),
  getSettlementStabilizationStatus(),
  getLedgerStabilizationStatus(),
]);

assert(authority.credit.authority === "SERVICE", "Credit must be SERVICE.", {
  authority,
});
assert(
  authority.credit.comparisonMode === "ENABLED",
  "Credit comparison mode must be ENABLED.",
  { authority }
);
assert(authority.settlement.authority === "SERVICE", "Settlement must remain SERVICE.", {
  authority,
});
assert(authority.ledger.authority === "SERVICE", "Ledger must remain SERVICE.", {
  authority,
});
assert(
  settlement.certificationStatus === "CERTIFIED",
  "Settlement must remain CERTIFIED.",
  { settlement }
);
assert(ledger.certificationStatus === "CERTIFIED", "Ledger must remain CERTIFIED.", {
  ledger,
});
pass("Authority controls are ready for Credit post-promotion activity.", {
  settlement: authority.settlement.authority,
  settlementCertification: settlement.certificationStatus,
  ledger: authority.ledger.authority,
  ledgerCertification: ledger.certificationStatus,
  credit: authority.credit.authority,
  creditComparisonMode: authority.credit.comparisonMode,
});

const before = await getCreditStabilizationStatus();
assert(before.promotedAt, "Credit promotion timestamp missing.", { before });
assert(before.authority === "SERVICE", "Credit status authority mismatch.", { before });
assert(
  before.comparisonMode === "ENABLED",
  "Credit status comparison mode mismatch.",
  { before }
);
assert(before.rollbackReadiness === "READY", "Credit rollback readiness mismatch.", {
  before,
});
assert(before.serviceHealth.available === true, "Credit Service must be healthy.", {
  before,
});

const correlationId = `qa-credit-post-promotion-activity-${Date.now()}`;
const activity = await executeCreditServiceMatch(correlationId);
pass("Credit Wallet Service authoritative activity generated.", {
  correlationId,
  shadowCreditRunId: activity.result.shadowCreditRunId,
  comparisonStatus: activity.result.comparisonStatus,
});

const after = await getCreditStabilizationStatus();

assert(after.authority === "SERVICE", "Credit authority changed.", { after });
assert(after.comparisonMode === "ENABLED", "Credit comparison mode changed.", {
  after,
});
assert(after.rollbackReady === true, "Credit rollbackReady changed.", { after });
assert(after.rollbackReadiness === "READY", "Credit rollback readiness changed.", {
  after,
});
assert(after.serviceHealth.available === true, "Credit Service health changed.", {
  after,
});
assert(
  after.creditWalletsProcessed > before.creditWalletsProcessed,
  "Stabilization status should see new post-promotion Credit wallet activity.",
  { before, after, activity }
);
assert(
  after.reservationsProcessed > before.reservationsProcessed,
  "Stabilization status should see new post-promotion reservation activity.",
  { before, after, activity }
);
assert(
  after.exposureUpdatesProcessed > before.exposureUpdatesProcessed,
  "Stabilization status should see new post-promotion exposure activity.",
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
  "Credit should be ready for certification after clean post-promotion activity.",
  { before, after }
);
assert(
  after.recommendation === "READY_FOR_CERTIFICATION",
  "Credit stabilization recommendation should be READY_FOR_CERTIFICATION.",
  { before, after }
);

const [finalAuthority, finalSettlement, finalLedger] = await Promise.all([
  getAuthorityStatus(),
  getSettlementStabilizationStatus(),
  getLedgerStabilizationStatus(),
]);
assert(
  finalAuthority.settlement.authority === "SERVICE" &&
    finalAuthority.ledger.authority === "SERVICE" &&
    finalAuthority.credit.authority === "SERVICE" &&
    finalAuthority.credit.comparisonMode === "ENABLED",
  "Credit post-promotion activity changed authority controls.",
  { authority: finalAuthority }
);
assert(
  finalSettlement.certificationStatus === "CERTIFIED",
  "Credit post-promotion activity changed Settlement certification.",
  { finalSettlement }
);
assert(
  finalLedger.certificationStatus === "CERTIFIED",
  "Credit post-promotion activity changed Ledger certification.",
  { finalLedger }
);

pass("Credit post-promotion activity certification QA completed.", {
  before: {
    creditWalletsProcessed: before.creditWalletsProcessed,
    reservationsProcessed: before.reservationsProcessed,
    exposureUpdatesProcessed: before.exposureUpdatesProcessed,
    certificationStatus: before.certificationStatus,
  },
  after: {
    creditWalletsProcessed: after.creditWalletsProcessed,
    reservationsProcessed: after.reservationsProcessed,
    exposureUpdatesProcessed: after.exposureUpdatesProcessed,
    mismatchCount: after.mismatchCount,
    failureCount: after.failureCount,
    criticalMismatchCount: after.criticalMismatchCount,
    certificationStatus: after.certificationStatus,
  },
  recommendation: after.recommendation,
});
