const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

function fail(message, metadata = {}) {
  console.error(message);
  for (const [key, value] of Object.entries(metadata)) console.error(`${key}: ${value}`);
  process.exit(1);
}

if (!sessionToken) fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");

const response = await fetch(`${appUrl}/api/settlement-shadow/failures`, {
  headers: { authorization: `Bearer ${sessionToken}` },
});
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  fail("Settlement shadow failures endpoint failed.", {
    status: response.status,
    error: payload.error ?? "unknown",
  });
}

console.log(`failureCount: ${payload.failures.length}`);
for (const failure of payload.failures.slice(0, 10)) {
  console.log(
    `${failure.createdAt} ${failure.failureType} ticket=${failure.ticketId ?? ""} reason=${failure.failureReason}`
  );
}
