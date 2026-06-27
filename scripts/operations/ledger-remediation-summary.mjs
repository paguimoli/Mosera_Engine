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

const response = await fetch(`${appUrl}/api/operations/ledger-reference-remediation/summary`, {
  headers: { authorization: `Bearer ${sessionToken}` },
});
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  fail("Ledger remediation summary endpoint failed.", {
    status: response.status,
    error: payload.error ?? "unknown",
  });
}

const summary = payload.remediationSummary;

console.log(`status: ${summary.status}`);
console.log(`totalCount: ${summary.totalCount}`);
console.log(`pendingCount: ${summary.pendingCount}`);
console.log(`approvedCount: ${summary.approvedCount}`);
console.log(`rejectedCount: ${summary.rejectedCount}`);
console.log(`completedCount: ${summary.completedCount}`);
console.log(`expiredCount: ${summary.expiredCount}`);
console.log(`averageReviewSeconds: ${summary.averageReviewSeconds ?? "n/a"}`);
console.log(`generatedAt: ${summary.generatedAt}`);
