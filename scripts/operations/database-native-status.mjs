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

const response = await fetch(`${appUrl}/api/operations/database-native-status`, {
  headers: { authorization: `Bearer ${sessionToken}` },
});
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  fail("Database native status endpoint failed.", {
    status: response.status,
    error: payload.error ?? "unknown",
  });
}

const status = payload.nativeStatus;

console.log(`generatedAt: ${status.generatedAt}`);
console.log(`measurementOnly: ${status.measurementOnly}`);
console.log(`overallDatabaseHealth: ${status.status}`);
console.log(`source: ${status.source}`);
console.log(`activeSessions: ${status.sessions.active ?? "unavailable"}`);
console.log(`idleSessions: ${status.sessions.idle ?? "unavailable"}`);
console.log(`waitingSessions: ${status.sessions.waiting ?? "unavailable"}`);
console.log(`totalSessions: ${status.sessions.total ?? "unavailable"}`);
console.log(`poolUtilization: ${status.pool.utilization ?? "unavailable"}`);
console.log(`poolExhaustionEvents: ${status.pool.exhaustionEvents ?? "unavailable"}`);
console.log("waitEvents:");
for (const item of status.waitEvents) {
  console.log(`- ${item.waitEventType ?? "unknown"} ${item.waitEvent ?? "unknown"} count=${item.count}`);
}
console.log("transactionStates:");
for (const item of status.transactionStates) {
  console.log(`- ${item.state ?? "unknown"} count=${item.count}`);
}
console.log("limitations:");
for (const limitation of status.limitations) {
  console.log(`- ${limitation}`);
}
