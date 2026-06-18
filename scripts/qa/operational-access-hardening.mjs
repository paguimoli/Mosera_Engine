import { authenticator } from "otplib";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const adminSessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const breakGlassUsername = process.env.QA_BREAK_GLASS_USERNAME;
const breakGlassPassword = process.env.QA_BREAK_GLASS_PASSWORD;
const breakGlassTotpSecret = process.env.QA_BREAK_GLASS_TOTP_SECRET;

const correlationId = `qa-operational-access-${Date.now()}`;
const assertions = [];

function fail(message, metadata = {}) {
  console.error("QA assertion failed.");
  console.error(`correlationId: ${correlationId}`);
  console.error(`reason: ${message}`);

  for (const [key, value] of Object.entries(metadata)) {
    console.error(`${key}: ${value}`);
  }

  process.exit(1);
}

function pass(message) {
  assertions.push(message);
  console.log(`PASS: ${message}`);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-correlation-id": correlationId,
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));

  return { response, payload };
}

async function adminRequest(path, options = {}) {
  return requestJson(path, {
    ...options,
    headers: {
      authorization: `Bearer ${adminSessionToken}`,
      ...(options.headers ?? {}),
    },
  });
}

function requireAdminToken() {
  if (!adminSessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN is required.");
  }
}

async function assertOperationalInventory() {
  const users = await adminRequest("/api/admin/access/users");

  if (!users.response.ok || !users.payload.success) {
    fail("Operational user inventory endpoint failed.", {
      status: users.response.status,
      error: users.payload.error ?? "",
    });
  }

  if (!Array.isArray(users.payload.users)) {
    fail("Operational user inventory response did not include a users array.");
  }

  pass("Operational credential inventory is visible to authorized admin.");

  const breakGlass = await adminRequest("/api/admin/access/break-glass");

  if (!breakGlass.response.ok || !breakGlass.payload.success) {
    fail("Break-glass inventory endpoint failed.", {
      status: breakGlass.response.status,
      error: breakGlass.payload.error ?? "",
    });
  }

  if (!Array.isArray(breakGlass.payload.accounts)) {
    fail("Break-glass inventory response did not include an accounts array.");
  }

  if (breakGlass.payload.accounts.length > 2) {
    fail("More than two break-glass accounts are visible.", {
      count: breakGlass.payload.accounts.length,
    });
  }

  pass("Break-glass inventory is visible without exposing secrets.");
}

async function assertSessionInventory() {
  const sessions = await adminRequest("/api/admin/sessions");

  if (!sessions.response.ok || !sessions.payload.success) {
    fail("Session inventory endpoint failed.", {
      status: sessions.response.status,
      error: sessions.payload.error ?? "",
    });
  }

  if (!Array.isArray(sessions.payload.sessions)) {
    fail("Session inventory response did not include a sessions array.");
  }

  pass("Active session inventory is visible to authorized admin.");
}

async function assertBreakGlassMfaLoginAndRevocation() {
  if (!breakGlassUsername || !breakGlassPassword || !breakGlassTotpSecret) {
    console.log(
      "SKIP: Break-glass MFA login validation requires QA_BREAK_GLASS_USERNAME, QA_BREAK_GLASS_PASSWORD, and QA_BREAK_GLASS_TOTP_SECRET."
    );
    return;
  }

  const login = await requestJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: breakGlassUsername,
      password: breakGlassPassword,
    }),
  });

  if (!login.response.ok || !login.payload.success || !login.payload.mfaRequired) {
    fail("Break-glass login did not require MFA.", {
      status: login.response.status,
      username: breakGlassUsername,
    });
  }

  pass("Break-glass login enforces MFA challenge.");

  const code = authenticator.generate(breakGlassTotpSecret);
  const verify = await requestJson("/api/auth/mfa/challenge/verify", {
    method: "POST",
    body: JSON.stringify({
      challengeToken: login.payload.challengeToken,
      code,
    }),
  });

  if (!verify.response.ok || !verify.payload.success || !verify.payload.sessionToken) {
    fail("Break-glass MFA challenge verification failed.", {
      status: verify.response.status,
      username: breakGlassUsername,
    });
  }

  pass("Break-glass MFA challenge produces an authenticated session.");

  const sessions = await adminRequest("/api/admin/sessions");
  const session = sessions.payload.sessions?.find(
    (item) => item.userId === verify.payload.user?.id && item.isActive
  );

  if (!session?.id) {
    fail("Unable to find the break-glass session for revocation.", {
      userId: verify.payload.user?.id ?? "",
    });
  }

  const revoke = await adminRequest("/api/admin/sessions/revoke", {
    method: "POST",
    body: JSON.stringify({ sessionId: session.id }),
  });

  if (!revoke.response.ok || !revoke.payload.success) {
    fail("Break-glass session revocation failed.", {
      status: revoke.response.status,
      sessionId: session.id,
    });
  }

  pass("Break-glass session can be revoked by authorized admin.");
}

async function main() {
  requireAdminToken();
  await assertOperationalInventory();
  await assertSessionInventory();
  await assertBreakGlassMfaLoginAndRevocation();

  console.log(`correlationId: ${correlationId}`);
  console.log(`assertionsPassed: ${assertions.length}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Operational access QA failed.");
});
