import "../qa/load-session-env.mjs";

const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

if (!sessionToken) {
  console.error("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const response = await fetch(
  `${appUrl}/api/authority/credit-post-promotion-status`,
  {
    headers: { authorization: `Bearer ${sessionToken}` },
  }
);
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  console.error(
    JSON.stringify({ status: "FAIL", statusCode: response.status, payload }, null, 2)
  );
  process.exit(1);
}

const status = payload.postPromotionStatus;

console.log(
  JSON.stringify(
    {
      status: "PASS",
      authority: status.authority,
      comparisonMode: status.comparisonMode,
      promotedAt: status.promotedAt,
      serviceHealth: status.serviceHealth,
      rollbackReady: status.rollbackReady,
      rollbackReadiness: status.rollbackReadiness,
      rollbackTrigger: status.rollbackTrigger,
      triggerSource: status.triggerSource,
      creditWalletsProcessed: status.creditWalletsProcessed,
      reservationsProcessed: status.reservationsProcessed,
      exposureUpdatesProcessed: status.exposureUpdatesProcessed,
      mismatchCount: status.mismatchCount,
      failureCount: status.failureCount,
      criticalMismatchCount: status.criticalMismatchCount,
      recommendation: status.recommendation,
      evaluatedAt: status.evaluatedAt,
    },
    null,
    2
  )
);
