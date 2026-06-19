const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

function fail(message, metadata = {}) {
  console.error(message);
  for (const [key, value] of Object.entries(metadata)) console.error(`${key}: ${value}`);
  process.exit(1);
}

if (!sessionToken) fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");

const response = await fetch(`${appUrl}/api/settlement-shadow/mismatches`, {
  headers: { authorization: `Bearer ${sessionToken}` },
});
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  fail("Settlement shadow mismatches endpoint failed.", {
    status: response.status,
    error: payload.error ?? "unknown",
  });
}

console.log(`mismatchCount: ${payload.mismatches.length}`);
for (const mismatch of payload.mismatches.slice(0, 10)) {
  console.log(
    `${mismatch.createdAt} ${mismatch.severity} ${mismatch.mismatchType} ticket=${mismatch.run?.ticketId ?? ""}`
  );
}
