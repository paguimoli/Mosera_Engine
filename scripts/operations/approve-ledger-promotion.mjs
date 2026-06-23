import "../qa/load-session-env.mjs";

const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

function readArgs(argv) {
  const args = {
    acknowledgedWarnings: [],
    correlationId: null,
    justification: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--justification" && next) {
      args.justification = next;
      index += 1;
    } else if (arg === "--acknowledge-warning" && next) {
      args.acknowledgedWarnings.push(next);
      index += 1;
    } else if (arg === "--correlation-id" && next) {
      args.correlationId = next;
      index += 1;
    }
  }

  return args;
}

if (!sessionToken) {
  console.error("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const args = readArgs(process.argv.slice(2));
if (!args.justification.trim()) {
  console.error("--justification is required.");
  process.exit(1);
}

const response = await fetch(`${appUrl}/api/authority/approvals/promotion`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${sessionToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    domain: "LEDGER",
    justification: args.justification,
    acknowledgedWarnings: args.acknowledgedWarnings,
    correlationId: args.correlationId,
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
      decisionBefore: payload.promotionDecisionBefore.decision,
      decisionAfter: payload.promotionDecisionAfter.decision,
      currentAuthority: payload.promotionDecisionAfter.currentAuthority,
      comparisonMode: payload.promotionDecisionAfter.comparisonMode,
    },
    null,
    2
  )
);
