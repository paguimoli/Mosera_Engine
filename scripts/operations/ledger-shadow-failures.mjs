const appUrl = process.env.OPERATIONS_APP_URL || "http://localhost:3000";
const sessionToken = process.env.OPERATIONS_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;
const query = process.argv.slice(2).join("&");

if (!sessionToken) {
  console.error("OPERATIONS_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const suffix = query ? `?${query}` : "";
const response = await fetch(`${appUrl}/api/ledger-shadow/failures${suffix}`, {
  headers: { authorization: `Bearer ${sessionToken}` },
});
const body = await response.json();

if (!response.ok || !body.success) {
  console.error(JSON.stringify({ status: "FAIL", responseStatus: response.status, body }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "PASS", count: body.failures.length, failures: body.failures }, null, 2));
