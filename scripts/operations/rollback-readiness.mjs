const appUrl = process.env.OPERATIONS_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPERATIONS_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

if (!sessionToken) {
  console.error("OPERATIONS_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const response = await fetch(`${appUrl}/api/authority/rollback-readiness`, {
  headers: { authorization: `Bearer ${sessionToken}` },
});
const body = await response.json();

if (!response.ok || !body.success) {
  console.error(
    JSON.stringify({ status: "FAIL", responseStatus: response.status, body }, null, 2)
  );
  process.exit(1);
}

const readiness = body.rollbackReadiness;
const rows = ["settlement", "ledger", "credit"].map((domain) => {
  const config = readiness[domain];

  return {
    domain,
    authority: config.authority,
    comparisonMode: config.comparisonMode,
    rollbackStatus: config.rollbackStatus,
    serviceAvailable: config.serviceHealth.available,
    reasons: config.reasons,
  };
});

console.log(
  JSON.stringify(
    {
      status: "PASS",
      evaluatedAt: readiness.evaluatedAt,
      overallStatus: readiness.overallStatus,
      rollbackReadiness: rows,
    },
    null,
    2
  )
);
