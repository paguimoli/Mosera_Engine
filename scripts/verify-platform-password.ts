export {};

const AUTH_SERVICE_URL = (process.env.AUTH_SERVICE_URL || "http://localhost:5600").replace(/\/$/, "");

async function main() {
  const loginId = process.env.PLATFORM_USERNAME?.trim();
  const password = process.env.PLATFORM_PASSWORD;
  if (!loginId || !password) throw new Error("PLATFORM_USERNAME and PLATFORM_PASSWORD are required.");

  const login = await fetch(`${AUTH_SERVICE_URL}/api/auth-service/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginId, password, correlationId: crypto.randomUUID() }),
  });
  const payload = await login.json().catch(() => ({}));
  if (!login.ok) throw new Error(`Auth Service verification failed (${login.status}).`);

  const sessionToken = typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  if (sessionToken) {
    await fetch(`${AUTH_SERVICE_URL}/api/auth-service/authority/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionToken, correlationId: crypto.randomUUID() }),
    });
  }
  console.log(JSON.stringify({ success: true, authority: "AUTH_SERVICE", identityId: payload.identity?.identityId ?? null }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Auth Service verification failed.");
  process.exit(1);
});
