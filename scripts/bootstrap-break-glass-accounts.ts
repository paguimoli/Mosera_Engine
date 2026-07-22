import { randomUUID } from "node:crypto";

const AUTH_SERVICE_URL = (process.env.AUTH_SERVICE_URL || "http://localhost:5600").replace(/\/$/, "");

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function createEmergencyIdentity(index: 1 | 2) {
  const actorIdentityId = process.env.AUTH_BOOTSTRAP_ACTOR_IDENTITY_ID?.trim() || null;
  const response = await fetch(`${AUTH_SERVICE_URL}/api/auth-service/authority/identities`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-correlation-id": randomUUID() },
    body: JSON.stringify({
      identityId: randomUUID(),
      tenantId: required("AUTH_BOOTSTRAP_TENANT_ID"),
      brandId: process.env.AUTH_BOOTSTRAP_BRAND_ID?.trim() || null,
      username: required(`BREAK_GLASS_${index}_USERNAME`),
      email: required(`BREAK_GLASS_${index}_EMAIL`),
      password: required(`BREAK_GLASS_${index}_PASSWORD`),
      accountType: "EMERGENCY",
      initialStatus: "EMERGENCY",
      actorIdentityId,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Auth Service emergency identity ${index} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

async function main() {
  const results = [await createEmergencyIdentity(1), await createEmergencyIdentity(2)];
  console.log(JSON.stringify({ success: true, authority: "AUTH_SERVICE", governedEmergencyAccounts: 2, results }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Auth Service emergency account bootstrap failed.");
  process.exit(1);
});
