import { randomUUID } from "node:crypto";

const AUTH_SERVICE_URL = (process.env.AUTH_SERVICE_URL || "http://localhost:5600").replace(/\/$/, "");

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const response = await fetch(`${AUTH_SERVICE_URL}/api/auth-service/authority/identities`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-correlation-id": randomUUID() },
    body: JSON.stringify({
      identityId: randomUUID(),
      tenantId: required("PLATFORM_OPERATOR_TENANT_ID"),
      brandId: process.env.PLATFORM_OPERATOR_BRAND_ID?.trim() || null,
      username: required("PLATFORM_USERNAME"),
      email: required("PLATFORM_EMAIL"),
      password: required("PLATFORM_PASSWORD"),
      accountType: "OPERATOR",
      initialStatus: "ACTIVE",
      actorIdentityId: required("PLATFORM_OPERATOR_ACTOR_IDENTITY_ID"),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Auth Service operator creation failed (${response.status}): ${JSON.stringify(payload)}`);
  console.log(JSON.stringify({ success: true, authority: "AUTH_SERVICE", result: payload }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Auth Service operator creation failed.");
  process.exit(1);
});
