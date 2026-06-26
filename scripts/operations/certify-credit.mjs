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

function getRepeatedArg(name) {
  const values = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]);
    }
  }

  return values;
}

if (!sessionToken) {
  console.error("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const justification = getArg("--justification");
const acknowledgedWarnings = getRepeatedArg("--acknowledge-warning");
const correlationId = getArg(
  "--correlation-id",
  `ops-certify-credit-${Date.now()}`
);

if (!justification) {
  console.error("--justification is required.");
  process.exit(1);
}

const response = await fetch(`${appUrl}/api/authority/certification/credit`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${sessionToken}`,
  },
  body: JSON.stringify({
    justification,
    acknowledgedWarnings,
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

console.log(
  JSON.stringify(
    {
      status: "PASS",
      approvalId: payload.approval.id,
      idempotent: payload.idempotent,
      certifiedAt: payload.approval.createdAt,
      certificationStatusBefore:
        payload.stabilizationBefore.certificationStatus,
      certificationStatusAfter: payload.stabilizationAfter.certificationStatus,
      authority: payload.stabilizationAfter.authority,
      comparisonMode: payload.stabilizationAfter.comparisonMode,
      rollbackReadiness: payload.stabilizationAfter.rollbackReadiness,
    },
    null,
    2
  )
);
