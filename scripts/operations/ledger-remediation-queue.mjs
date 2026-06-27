import "../qa/load-session-env.mjs";

const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

function fail(message, metadata = {}) {
  console.error(message);
  for (const [key, value] of Object.entries(metadata)) {
    console.error(`${key}: ${value}`);
  }
  process.exit(1);
}

if (!sessionToken) fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");

const response = await fetch(`${appUrl}/api/operations/ledger-reference-remediation/queue`, {
  headers: { authorization: `Bearer ${sessionToken}` },
});
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  fail("Ledger remediation queue endpoint failed.", {
    status: response.status,
    error: payload.error ?? "unknown",
  });
}

const queue = payload.remediationQueue;

console.log(`status: ${queue.status}`);
console.log(`totalCount: ${queue.totalCount}`);
console.log(`appendOnly: ${queue.appendOnly}`);
console.log(`mutationAllowed: ${queue.mutationAllowed}`);
console.log(`generatedAt: ${queue.generatedAt}`);
for (const candidate of queue.candidates.slice(0, 10)) {
  console.log(
    `${candidate.remediationId} ${candidate.status} ${candidate.confidence} ${candidate.sourceEntityId}`
  );
}
