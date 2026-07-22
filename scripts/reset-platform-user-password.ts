export {};

const AUTH_SERVICE_URL = (process.env.AUTH_SERVICE_URL || "http://localhost:5600").replace(/\/$/, "");

function argument(name: string, envName: string) {
  const index = process.argv.indexOf(name);
  return (index >= 0 ? process.argv[index + 1] : process.env[envName])?.trim() || "";
}

async function main() {
  const identityId = argument("--identity-id", "RESET_PLATFORM_IDENTITY_ID");
  const actorIdentityId = argument("--actor-identity-id", "RESET_PLATFORM_ACTOR_IDENTITY_ID");
  const newPassword = argument("--password", "RESET_PLATFORM_PASSWORD");

  if (!identityId || !actorIdentityId || !newPassword) {
    throw new Error("Usage: npm run auth:reset-password -- --identity-id <id> --actor-identity-id <super-admin-id> --password <password>");
  }

  const response = await fetch(`${AUTH_SERVICE_URL}/api/auth-service/authority/password/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-correlation-id": crypto.randomUUID() },
    body: JSON.stringify({ identityId, actorIdentityId, newPassword, reason: "operator_password_reset" }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Auth Service password reset failed (${response.status}): ${JSON.stringify(payload)}`);
  console.log(JSON.stringify({ success: true, identityId, authority: "AUTH_SERVICE", result: payload }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Auth Service password reset failed.");
  process.exit(1);
});
