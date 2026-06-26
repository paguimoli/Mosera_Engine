import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const correlationId = `qa-credit-rollback-drill-${Date.now()}`;
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function authHeaders(extra = {}) {
  if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN is required.");

  return {
    authorization: `Bearer ${sessionToken}`,
    ...extra,
  };
}

function createQaSupabaseClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    fail("SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket,
    },
  });
}

function sum(rows, fieldName) {
  return rows.reduce((total, row) => total + Number(row[fieldName] ?? 0), 0);
}

async function snapshotCreditState() {
  const supabase = createQaSupabaseClient();
  const [wallets, reservations] = await Promise.all([
    supabase
      .from("financial_wallets")
      .select("id,balance,credit_limit")
      .eq("wallet_type", "CREDIT"),
    supabase
      .from("credit_reservations")
      .select("id,reserved_amount,released_amount,settled_amount,remaining_exposure"),
  ]);

  if (wallets.error) {
    fail("Unable to snapshot credit wallets.", { error: wallets.error.message });
  }
  if (reservations.error) {
    fail("Unable to snapshot credit reservations.", {
      error: reservations.error.message,
    });
  }

  const walletRows = wallets.data ?? [];
  const reservationRows = reservations.data ?? [];

  return {
    walletCount: walletRows.length,
    walletBalanceTotal: sum(walletRows, "balance"),
    walletCreditLimitTotal: sum(walletRows, "credit_limit"),
    reservationCount: reservationRows.length,
    reservedAmountTotal: sum(reservationRows, "reserved_amount"),
    releasedAmountTotal: sum(reservationRows, "released_amount"),
    settledAmountTotal: sum(reservationRows, "settled_amount"),
    remainingExposureTotal: sum(reservationRows, "remaining_exposure"),
  };
}

const protectedPaths = [
  {
    path: "/api/authority/credit-post-promotion-status",
    method: "GET",
  },
  {
    path: "/api/authority/credit-rollback/drill",
    method: "POST",
    body: { mode: "SIMULATION" },
  },
];

for (const protectedPath of protectedPaths) {
  const unauthenticated = await requestJson(protectedPath.path, {
    method: protectedPath.method,
    headers:
      protectedPath.method === "POST"
        ? { "content-type": "application/json" }
        : undefined,
    body: protectedPath.body ? JSON.stringify(protectedPath.body) : undefined,
  });

  assert(
    unauthenticated.response.status === 401,
    "Credit post-promotion authority API should require authentication.",
    {
      path: protectedPath.path,
      status: unauthenticated.response.status,
      body: unauthenticated.body,
    }
  );
}
pass("Credit post-promotion monitoring and rollback drill APIs require auth.");

const [
  authorityBeforeResult,
  postPromotionStatusResult,
  settlementStatusResult,
  ledgerStatusResult,
  snapshotBefore,
] = await Promise.all([
  requestJson("/api/authority/status", { headers: authHeaders() }),
  requestJson("/api/authority/credit-post-promotion-status", {
    headers: authHeaders(),
  }),
  requestJson("/api/authority/settlement-stabilization-status?window=7d", {
    headers: authHeaders(),
  }),
  requestJson("/api/authority/ledger-stabilization-status", {
    headers: authHeaders(),
  }),
  snapshotCreditState(),
]);

assert(
  authorityBeforeResult.response.status === 200 &&
    authorityBeforeResult.body.success,
  "Authority status endpoint failed before Credit rollback drill.",
  { status: authorityBeforeResult.response.status, body: authorityBeforeResult.body }
);
assert(
  postPromotionStatusResult.response.status === 200 &&
    postPromotionStatusResult.body.success,
  "Credit post-promotion status endpoint failed.",
  {
    status: postPromotionStatusResult.response.status,
    body: postPromotionStatusResult.body,
  }
);
assert(
  settlementStatusResult.response.status === 200 &&
    settlementStatusResult.body.success,
  "Settlement status endpoint failed.",
  { status: settlementStatusResult.response.status, body: settlementStatusResult.body }
);
assert(
  ledgerStatusResult.response.status === 200 && ledgerStatusResult.body.success,
  "Ledger status endpoint failed.",
  { status: ledgerStatusResult.response.status, body: ledgerStatusResult.body }
);

const authorityBefore = authorityBeforeResult.body.authority;
const monitoring = postPromotionStatusResult.body.postPromotionStatus;
const settlementStatus = settlementStatusResult.body.stabilizationStatus;
const ledgerStatus = ledgerStatusResult.body.stabilizationStatus;

assert(authorityBefore.credit.authority === "SERVICE", "Credit must be SERVICE.", {
  authorityBefore,
});
assert(
  authorityBefore.credit.comparisonMode === "ENABLED",
  "Credit comparison mode must remain ENABLED.",
  { authorityBefore }
);
assert(authorityBefore.settlement.authority === "SERVICE", "Settlement must remain SERVICE.", {
  authorityBefore,
});
assert(settlementStatus.certificationStatus === "CERTIFIED", "Settlement must remain CERTIFIED.", {
  settlementStatus,
});
assert(authorityBefore.ledger.authority === "SERVICE", "Ledger must remain SERVICE.", {
  authorityBefore,
});
assert(ledgerStatus.certificationStatus === "CERTIFIED", "Ledger must remain CERTIFIED.", {
  ledgerStatus,
});

assert(monitoring.authority === "SERVICE", "Credit monitoring authority mismatch.", {
  monitoring,
});
assert(
  monitoring.comparisonMode === "ENABLED",
  "Credit monitoring comparison mode mismatch.",
  { monitoring }
);
assert(monitoring.promotedAt, "Credit promotion timestamp missing.", {
  monitoring,
});
assert(
  monitoring.serviceHealth.available === true,
  "Credit Wallet Service health should be available.",
  { monitoring }
);
assert(monitoring.rollbackReady === true, "Credit rollbackReady should be true.", {
  monitoring,
});
assert(
  monitoring.rollbackReadiness === "READY",
  "Credit rollback readiness should be READY.",
  { monitoring }
);
assert(
  typeof monitoring.creditWalletsProcessed === "number" &&
    typeof monitoring.reservationsProcessed === "number" &&
    typeof monitoring.exposureUpdatesProcessed === "number",
  "Credit processed counters missing.",
  { monitoring }
);
assert(
  typeof monitoring.mismatchCount === "number" &&
    typeof monitoring.failureCount === "number" &&
    typeof monitoring.criticalMismatchCount === "number",
  "Credit post-promotion mismatch/failure counters missing.",
  { monitoring }
);
assert(monitoring.recommendation, "Credit monitoring recommendation missing.", {
  monitoring,
});
pass("Credit post-promotion monitoring endpoint reports required controls.", {
  promotedAt: monitoring.promotedAt,
  creditWalletsProcessed: monitoring.creditWalletsProcessed,
  reservationsProcessed: monitoring.reservationsProcessed,
  exposureUpdatesProcessed: monitoring.exposureUpdatesProcessed,
  mismatchCount: monitoring.mismatchCount,
  failureCount: monitoring.failureCount,
  criticalMismatchCount: monitoring.criticalMismatchCount,
  recommendation: monitoring.recommendation,
});

const drill = await requestJson("/api/authority/credit-rollback/drill", {
  method: "POST",
  headers: authHeaders({ "content-type": "application/json" }),
  body: JSON.stringify({
    mode: "SIMULATION",
    correlationId,
  }),
});
assert(
  drill.response.status === 200 && drill.body.success,
  "Credit rollback drill simulation failed.",
  { status: drill.response.status, body: drill.body }
);
const drillResult = drill.body.drill;
assert(drillResult.drillPassed === true, "Credit rollback drill should pass.", {
  drill: drillResult,
});
assert(
  drillResult.authorityBefore === "SERVICE" &&
    drillResult.authorityAfter === "SERVICE",
  "Credit rollback drill must not change authority.",
  { drill: drillResult }
);
assert(
  drillResult.authorityChanged === false,
  "Credit rollback drill reported authority mutation.",
  { drill: drillResult }
);
assert(
  drillResult.auditEvent?.eventType ===
    "authority.credit.rollback.drill.simulated",
  "Credit rollback drill outbox event missing.",
  { drill: drillResult }
);
pass("Credit rollback drill simulation passed without authority change.", {
  auditEvent: drillResult.auditEvent,
});

const [authorityAfterResult, snapshotAfter] = await Promise.all([
  requestJson("/api/authority/status", { headers: authHeaders() }),
  snapshotCreditState(),
]);

assert(
  authorityAfterResult.response.status === 200 && authorityAfterResult.body.success,
  "Authority status endpoint failed after Credit rollback drill.",
  { status: authorityAfterResult.response.status, body: authorityAfterResult.body }
);
const authorityAfter = authorityAfterResult.body.authority;
assert(
  authorityAfter.settlement.authority === "SERVICE" &&
    authorityAfter.ledger.authority === "SERVICE" &&
    authorityAfter.credit.authority === "SERVICE" &&
    authorityAfter.credit.comparisonMode === "ENABLED",
  "Credit rollback drill changed authority controls.",
  { authority: authorityAfter }
);
assert(
  JSON.stringify(snapshotAfter) === JSON.stringify(snapshotBefore),
  "Credit rollback drill changed balances, reservations, or exposure.",
  { before: snapshotBefore, after: snapshotAfter }
);
pass("Credit rollback drill left authority and financial state unchanged.", {
  authority: authorityAfter.credit.authority,
  comparisonMode: authorityAfter.credit.comparisonMode,
});

pass("Credit post-promotion QA completed.", {
  correlationId,
  recommendation: monitoring.recommendation,
  rollbackReadiness: monitoring.rollbackReadiness,
});
