import "../qa/load-session-env.mjs";

const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;
const correlationIdArg = process.argv.find((arg) =>
  arg.startsWith("--correlation-id=")
);
const correlationId =
  correlationIdArg?.split("=").slice(1).join("=") ||
  `ops-credit-rollback-drill-${Date.now()}`;

if (!sessionToken) {
  console.error("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const response = await fetch(`${appUrl}/api/authority/credit-rollback/drill`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${sessionToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    mode: "SIMULATION",
    correlationId,
  }),
});
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  console.error(
    JSON.stringify({ status: "FAIL", statusCode: response.status, payload }, null, 2)
  );
  process.exit(1);
}

const drill = payload.drill;

console.log(
  JSON.stringify(
    {
      status: "PASS",
      domain: drill.domain,
      mode: drill.mode,
      drillPassed: drill.drillPassed,
      authorityBefore: drill.authorityBefore,
      authorityAfter: drill.authorityAfter,
      authorityChanged: drill.authorityChanged,
      comparisonMode: drill.comparisonMode,
      rollbackReadiness: drill.rollbackReadiness,
      blockers: drill.blockers,
      warnings: drill.warnings,
      auditEvent: drill.auditEvent,
      simulatedAt: drill.simulatedAt,
    },
    null,
    2
  )
);

process.exit(drill.drillPassed && !drill.authorityChanged ? 0 : 1);
