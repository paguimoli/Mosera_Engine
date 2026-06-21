const appUrl = process.env.OPERATIONS_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPERATIONS_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

if (!sessionToken) {
  console.error("OPERATIONS_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const response = await fetch(`${appUrl}/api/authority/status`, {
  headers: { authorization: `Bearer ${sessionToken}` },
});
const body = await response.json();

if (!response.ok || !body.success) {
  console.error(
    JSON.stringify({ status: "FAIL", responseStatus: response.status, body }, null, 2)
  );
  process.exit(1);
}

const rows = ["settlement", "ledger", "credit"].map((domain) => {
  const config = body.authority[domain];

  return {
    domain,
    authority: config.authority,
    comparisonMode: config.comparisonMode,
    mismatchAlertThreshold: config.mismatchAlertThreshold,
    serviceUrl: config.serviceUrl,
  };
});

console.log(
  JSON.stringify(
    {
      status: "PASS",
      evaluatedAt: body.authority.evaluatedAt,
      authority: rows,
    },
    null,
    2
  )
);
