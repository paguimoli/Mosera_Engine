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

function fail(message, metadata = {}) {
  console.error(message);
  for (const [key, value] of Object.entries(metadata)) {
    console.error(`${key}: ${value}`);
  }
  process.exit(1);
}

if (!sessionToken) fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");

const remediationId = getArg("--remediation-id");
const remediationDecision = getArg("--decision", "APPROVE");
const justification = getArg("--justification");
const correlationId =
  getArg("--correlation-id") ?? `ops-ledger-remediation-${Date.now()}`;

if (!remediationId) fail("--remediation-id is required.");
if (!justification) fail("--justification is required.");

const response = await fetch(
  `${appUrl}/api/operations/ledger-reference-remediation/approvals`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      remediationId,
      remediationDecision,
      justification,
      correlationId,
    }),
  }
);
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  fail("Ledger remediation approval endpoint failed.", {
    status: response.status,
    error: payload.error ?? "unknown",
  });
}

console.log(`approvalId: ${payload.approval.id}`);
console.log(`approvalType: ${payload.approval.approvalType}`);
console.log(`semanticType: ${payload.approval.metadata.approvalSemanticType}`);
console.log(`outboxEventId: ${payload.outboxEventId}`);
console.log(`idempotent: ${payload.idempotent}`);
console.log(`statusBefore: ${payload.candidateBefore.status}`);
console.log(`statusAfter: ${payload.candidateAfter.status}`);
