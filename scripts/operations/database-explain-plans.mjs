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

const response = await fetch(`${appUrl}/api/operations/database-explain-plans`, {
  headers: { authorization: `Bearer ${sessionToken}` },
});
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  fail("Database explain plans endpoint failed.", {
    status: response.status,
    error: payload.error ?? "unknown",
  });
}

const report = payload.explainPlans;

console.log(`generatedAt: ${report.generatedAt}`);
console.log(`measurementOnly: ${report.measurementOnly}`);
console.log(`status: ${report.status}`);
console.log(`source: ${report.source}`);
console.log("executionPlanSummaries:");
for (const plan of report.plans) {
  console.log(`- ${plan.label} table=${plan.table} status=${plan.status} planAvailable=${plan.planAvailable}`);
  console.log(`  planningTimeMs=${plan.planningTimeMs ?? "unavailable"} executionTimeMs=${plan.executionTimeMs ?? "unavailable"}`);
  console.log(`  estimatedRows=${plan.estimatedRows ?? "unavailable"} estimatedCost=${plan.estimatedCost ?? "unavailable"}`);
  console.log(`  statementTemplate=${plan.statementTemplate}`);
}
console.log("limitations:");
for (const limitation of report.limitations) {
  console.log(`- ${limitation}`);
}
