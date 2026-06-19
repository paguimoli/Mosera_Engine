const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

function fail(message, metadata = {}) {
  console.error(message);
  for (const [key, value] of Object.entries(metadata)) console.error(`${key}: ${value}`);
  process.exit(1);
}

if (!sessionToken) fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");

const response = await fetch(`${appUrl}/api/settlement-shadow/summary`, {
  headers: { authorization: `Bearer ${sessionToken}` },
});
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  fail("Settlement shadow summary endpoint failed.", {
    status: response.status,
    error: payload.error ?? "unknown",
  });
}

const { summary } = payload;
console.log(`generatedAt: ${summary.generatedAt}`);
console.log(`readiness: ${summary.readiness.status}`);
console.log(`totalRuns: ${summary.totalRuns}`);
console.log(`matches: ${summary.matches}`);
console.log(`mismatches: ${summary.mismatches}`);
console.log(`failures: ${summary.failures}`);
console.log(`matchPercentage: ${summary.matchPercentage}`);
console.log(`mismatchPercentage: ${summary.mismatchPercentage}`);
console.log(`failurePercentage: ${summary.failurePercentage}`);
