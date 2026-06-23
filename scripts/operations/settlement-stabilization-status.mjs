import "../qa/load-session-env.mjs";

const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;
const args = process.argv.slice(2);

function getArg(name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;

  return args[index + 1] ?? fallback;
}

if (!sessionToken) {
  console.error("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const window = getArg("--window", "7d");
const response = await fetch(
  `${appUrl}/api/authority/settlement-stabilization-status?window=${encodeURIComponent(window)}`,
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

const status = payload.stabilizationStatus;

console.log(
  JSON.stringify(
    {
      status: "PASS",
      window: status.window,
      authority: status.authority,
      comparisonMode: status.comparisonMode,
      promotedAt: status.promotedAt,
      daysSincePromotion: status.daysSincePromotion,
      settlementsProcessed: status.settlementsProcessed,
      mismatchCount: status.mismatchCount,
      failureCount: status.failureCount,
      criticalMismatchCount: status.criticalMismatchCount,
      serviceHealth: status.serviceHealth,
      rollbackReadiness: status.rollbackReadiness,
      rollbackTrigger: status.rollbackTrigger,
      stabilizationStatus: status.stabilizationStatus,
      recommendation: status.recommendation,
      generatedAt: status.generatedAt,
    },
    null,
    2
  )
);
