import "../qa/load-session-env.mjs";

const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;
const domainArg = process.argv.find((arg) => arg.startsWith("--domain="));
const domain = domainArg?.split("=")[1] || "settlement";

if (!sessionToken) {
  console.error("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const response = await fetch(
  `${appUrl}/api/authority/promotion-decision?domain=${encodeURIComponent(domain)}`,
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

const decision = payload.decision;

console.log(
  JSON.stringify(
    {
      status: "PASS",
      domain: decision.domain,
      decision: decision.decision,
      blockers: decision.blockingReasons,
      warnings: decision.warnings,
      nextRequiredAction: decision.recommendation,
      currentAuthority: decision.currentAuthority,
      comparisonMode: decision.comparisonMode,
      rollbackReadiness: decision.rollbackReadiness,
    },
    null,
    2
  )
);
