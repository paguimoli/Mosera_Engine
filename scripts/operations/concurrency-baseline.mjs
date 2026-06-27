import "../qa/load-session-env.mjs";

const appUrl =
  process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
let sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;
const adminUsername = process.env.QA_ADMIN_USERNAME || "admin2";
const adminPassword = process.env.QA_ADMIN_PASSWORD || "";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

async function ensureSessionToken() {
  if (sessionToken) {
    const { response } = await requestJson("/api/auth/me", {
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    if (response.ok) return;
  }

  if (!adminPassword) {
    fail("OPS_ADMIN_SESSION_TOKEN, QA_ADMIN_SESSION_TOKEN, or QA_ADMIN_PASSWORD is required.");
  }

  const { response, body } = await requestJson("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: adminUsername,
      password: adminPassword,
    }),
  });

  if (!response.ok || body?.success !== true || !body.sessionToken) {
    fail("Unable to establish admin session.", { status: response.status, body });
  }

  sessionToken = body.sessionToken;
}

await ensureSessionToken();

const { response, body } = await requestJson("/api/operations/concurrency-baseline", {
  headers: { authorization: `Bearer ${sessionToken}` },
});

if (!response.ok || body?.success !== true) {
  fail("Concurrency baseline endpoint failed.", { status: response.status, body });
}

console.log(JSON.stringify(body.concurrencyBaseline, null, 2));
