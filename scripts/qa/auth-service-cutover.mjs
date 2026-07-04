import { spawnSync } from "node:child_process";

const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const authServiceUrl = (process.env.AUTH_SERVICE_URL || "http://localhost:5600").replace(/\/$/, "");

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

function runSeed() {
  const result = spawnSync("node", ["scripts/qa/seed-local-auth-service-user.mjs"], {
    encoding: "utf8",
    env: process.env,
  });

  assert(result.status === 0, "Local Auth Service seed failed.", {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  });

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail("Local Auth Service seed did not return JSON.", {
      error: error instanceof Error ? error.message : String(error),
      stdout: result.stdout,
    });
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  return { response, body };
}

const authReady = await requestJson(`${authServiceUrl}/health/ready`);
assert(authReady.response.status === 200, "Auth Service readiness must pass.", {
  status: authReady.response.status,
  body: authReady.body,
});

const providerStatus = await requestJson(`${appUrl}/api/auth/provider-status`);
assert(providerStatus.response.status === 200 && providerStatus.body?.success === true, "App auth provider status failed.", {
  status: providerStatus.response.status,
  body: providerStatus.body,
});
assert(providerStatus.body.provider === "auth-service", "App must run in Auth Service provider mode for local cutover QA.", {
  body: providerStatus.body,
});
assert(providerStatus.body.authService?.reachable === true && providerStatus.body.authService?.ready === true, "App must reach Auth Service.", {
  body: providerStatus.body,
});

const seed = runSeed();
assert(seed.localOnly === true, "Auth Service seed must be local-only.", { seed });

const serviceToken = await requestJson(`${authServiceUrl}/api/auth-service/service-token`, {
  method: "POST",
  body: JSON.stringify({
    serviceName: seed.serviceName,
    clientSecret: seed.serviceClientSecret,
    scopes: [seed.serviceAllowedScope],
    correlationId: "qa-service-token",
  }),
});
assert(
  serviceToken.response.status === 200 &&
    serviceToken.body?.success === true &&
    serviceToken.body?.accessToken &&
    serviceToken.body?.scopes?.includes(seed.serviceAllowedScope),
  "Valid service credential must receive a service token.",
  { status: serviceToken.response.status, body: serviceToken.body }
);

const invalidServiceToken = await requestJson(`${authServiceUrl}/api/auth-service/service-token`, {
  method: "POST",
  body: JSON.stringify({
    serviceName: seed.serviceName,
    clientSecret: "wrong-service-secret",
    scopes: [seed.serviceAllowedScope],
    correlationId: "qa-service-token-invalid",
  }),
});
assert(
  invalidServiceToken.response.status === 401 && invalidServiceToken.body?.success === false,
  "Invalid service credential must fail.",
  { status: invalidServiceToken.response.status, body: invalidServiceToken.body }
);

const serviceTokenValidation = await requestJson(`${authServiceUrl}/api/auth-service/service-token/validate`, {
  method: "POST",
  body: JSON.stringify({
    accessToken: serviceToken.body.accessToken,
    requiredScope: seed.serviceAllowedScope,
  }),
});
assert(
  serviceTokenValidation.response.status === 200 && serviceTokenValidation.body?.valid === true,
  "Service token must validate for assigned scope.",
  { status: serviceTokenValidation.response.status, body: serviceTokenValidation.body }
);

const deniedServiceScope = await requestJson(`${authServiceUrl}/api/auth-service/service-token/validate`, {
  method: "POST",
  body: JSON.stringify({
    accessToken: serviceToken.body.accessToken,
    requiredScope: seed.serviceDeniedScope,
  }),
});
assert(
  deniedServiceScope.response.status === 401 &&
    deniedServiceScope.body?.valid === false &&
    deniedServiceScope.body?.reason === "insufficient_scope",
  "Service token validation must fail for unauthorized scope.",
  { status: deniedServiceScope.response.status, body: deniedServiceScope.body }
);

const failedLogin = await requestJson(`${appUrl}/api/auth/login`, {
  method: "POST",
  body: JSON.stringify({
    username: "missing-user@example.com",
    password: "Wrong-Password-2026!",
  }),
});
assert(failedLogin.response.status === 401 && failedLogin.body?.success === false, "Failed Auth Service login must fail closed.", {
  status: failedLogin.response.status,
  body: failedLogin.body,
});

const login = await requestJson(`${appUrl}/api/auth/login`, {
  method: "POST",
  body: JSON.stringify({
    username: seed.loginId,
    password: seed.password,
  }),
});
assert(login.response.status === 200 && login.body?.success === true && login.body?.sessionToken, "Seeded Auth Service login must succeed.", {
  status: login.response.status,
  body: login.body,
});
assert(login.body.accessToken && login.body.tokenType === "Bearer", "Seeded Auth Service login must return a Bearer access token.", {
  body: login.body,
});
assert(login.body.accessTokenKeyId && login.body.accessTokenJwtId, "Seeded Auth Service login must return access token key metadata.", {
  body: login.body,
});
assert(login.body.refreshToken && login.body.refreshTokenId, "Seeded Auth Service login must return refresh token metadata.", {
  body: login.body,
});

const sessionToken = login.body.sessionToken;
const authHeaders = {
  authorization: `Bearer ${sessionToken}`,
};

const jwks = await requestJson(`${authServiceUrl}/.well-known/jwks.json`);
assert(
  jwks.response.status === 200 &&
    Array.isArray(jwks.body?.keys) &&
    jwks.body.keys.some((key) => key.kid === login.body.accessTokenKeyId && key.kty === "RSA" && key.alg === "RS256"),
  "JWKS must expose the active Auth Service signing key.",
  { status: jwks.response.status, body: jwks.body, accessTokenKeyId: login.body.accessTokenKeyId }
);

const tokenValidation = await requestJson(`${authServiceUrl}/api/auth-service/tokens/validate`, {
  method: "POST",
  body: JSON.stringify({ accessToken: login.body.accessToken }),
});
assert(tokenValidation.response.status === 200 && tokenValidation.body?.valid === true, "Auth Service access token must validate.", {
  status: tokenValidation.response.status,
  body: tokenValidation.body,
});
assert(
  Array.isArray(tokenValidation.body?.claims?.permissions) &&
    tokenValidation.body.claims.permissions.includes(seed.allowedPermission),
  "Auth Service access token must include seeded permission claim.",
  { body: tokenValidation.body, allowedPermission: seed.allowedPermission }
);

const refresh = await requestJson(`${authServiceUrl}/api/auth-service/refresh`, {
  method: "POST",
  body: JSON.stringify({ refreshToken: login.body.refreshToken, correlationId: "qa-auth-refresh" }),
});
assert(
  refresh.response.status === 200 &&
    refresh.body?.success === true &&
    refresh.body?.accessToken &&
    refresh.body?.refreshToken &&
    refresh.body.refreshToken !== login.body.refreshToken,
  "Auth Service refresh must rotate refresh token and issue a new access token.",
  { status: refresh.response.status, body: refresh.body }
);

const refreshedTokenValidation = await requestJson(`${authServiceUrl}/api/auth-service/tokens/validate`, {
  method: "POST",
  body: JSON.stringify({ accessToken: refresh.body.accessToken }),
});
assert(refreshedTokenValidation.response.status === 200 && refreshedTokenValidation.body?.valid === true, "Refreshed Auth Service access token must validate.", {
  status: refreshedTokenValidation.response.status,
  body: refreshedTokenValidation.body,
});

const me = await requestJson(`${appUrl}/api/auth/me`, {
  headers: authHeaders,
});
assert(me.response.status === 200 && me.body?.success === true, "Auth Service /me through app must succeed after login.", {
  status: me.response.status,
  body: me.body,
});
assert(me.body.user?.username === seed.loginId, "Auth Service /me must map seeded identity to app user shape.", {
  body: me.body,
});
assert(
  Array.isArray(me.body.permissions) &&
    me.body.permissions.some((permission) => permission.key === seed.allowedPermission),
  "Auth Service /me must include seeded permission.",
  { body: me.body, allowedPermission: seed.allowedPermission }
);

const allowedPermission = await requestJson(`${appUrl}/api/auth/check-permission?permission=${encodeURIComponent(seed.allowedPermission)}`, {
  headers: authHeaders,
});
assert(
  allowedPermission.response.status === 200 &&
    allowedPermission.body?.success === true &&
    allowedPermission.body?.allowed === true,
  "Seeded Auth Service permission must be allowed.",
  { status: allowedPermission.response.status, body: allowedPermission.body }
);

const deniedPermission = await requestJson(`${appUrl}/api/auth/check-permission?permission=${encodeURIComponent(seed.deniedPermission)}`, {
  headers: authHeaders,
});
assert(
  deniedPermission.response.status === 200 &&
    deniedPermission.body?.success === true &&
    deniedPermission.body?.allowed === false,
  "Unassigned Auth Service permission must fail closed.",
  { status: deniedPermission.response.status, body: deniedPermission.body }
);

const replay = await requestJson(`${authServiceUrl}/api/auth-service/refresh`, {
  method: "POST",
  body: JSON.stringify({ refreshToken: login.body.refreshToken, correlationId: "qa-auth-refresh-replay" }),
});
assert(
  replay.response.status === 401 &&
    replay.body?.success === false &&
    replay.body?.replayDetected === true,
  "Reused old Auth Service refresh token must fail as replay.",
  { status: replay.response.status, body: replay.body }
);

const replayRevokedMe = await requestJson(`${appUrl}/api/auth/me`, {
  headers: authHeaders,
});
assert(replayRevokedMe.response.status === 401 && replayRevokedMe.body?.success === false, "Refresh token replay must revoke the bound session.", {
  status: replayRevokedMe.response.status,
  body: replayRevokedMe.body,
});

const logoutLogin = await requestJson(`${appUrl}/api/auth/login`, {
  method: "POST",
  body: JSON.stringify({
    username: seed.loginId,
    password: seed.password,
  }),
});
assert(logoutLogin.response.status === 200 && logoutLogin.body?.success === true && logoutLogin.body?.sessionToken && logoutLogin.body?.refreshToken, "Second seeded login for logout refresh revocation must succeed.", {
  status: logoutLogin.response.status,
  body: logoutLogin.body,
});

const logout = await requestJson(`${appUrl}/api/auth/logout`, {
  method: "POST",
  body: JSON.stringify({ sessionToken: logoutLogin.body.sessionToken }),
});
assert(logout.response.status === 200 && logout.body?.success === true, "Auth Service logout through app must succeed.", {
  status: logout.response.status,
  body: logout.body,
});

const meAfterLogout = await requestJson(`${appUrl}/api/auth/me`, {
  headers: {
    authorization: `Bearer ${logoutLogin.body.sessionToken}`,
  },
});
assert(meAfterLogout.response.status === 401 && meAfterLogout.body?.success === false, "/me after logout must fail.", {
  status: meAfterLogout.response.status,
  body: meAfterLogout.body,
});

const refreshAfterLogout = await requestJson(`${authServiceUrl}/api/auth-service/refresh`, {
  method: "POST",
  body: JSON.stringify({ refreshToken: logoutLogin.body.refreshToken, correlationId: "qa-auth-refresh-after-logout" }),
});
assert(
  refreshAfterLogout.response.status === 401 &&
    refreshAfterLogout.body?.success === false &&
    refreshAfterLogout.body?.replayDetected === true,
  "Refresh token must fail after logout revokes active refresh tokens.",
  { status: refreshAfterLogout.response.status, body: refreshAfterLogout.body }
);

const tokenAfterLogout = await requestJson(`${authServiceUrl}/api/auth-service/tokens/validate`, {
  method: "POST",
  body: JSON.stringify({ accessToken: login.body.accessToken }),
});
assert(tokenAfterLogout.response.status === 401 && tokenAfterLogout.body?.valid === false, "Access token must fail validation after session logout.", {
  status: tokenAfterLogout.response.status,
  body: tokenAfterLogout.body,
});

const invalidMe = await requestJson(`${appUrl}/api/auth/me`, {
  headers: {
    authorization: "Bearer 00000000-0000-0000-0000-000000000000",
  },
});
assert(invalidMe.response.status === 401 && invalidMe.body?.success === false, "Invalid Auth Service session must fail closed.", {
  status: invalidMe.response.status,
  body: invalidMe.body,
});

const invalidPermission = await requestJson(`${appUrl}/api/auth/check-permission?permission=system.admin`, {
  headers: {
    authorization: "Bearer 00000000-0000-0000-0000-000000000000",
  },
});
assert(invalidPermission.response.status === 401 && invalidPermission.body?.success === false, "Invalid Auth Service permission check must fail closed.", {
  status: invalidPermission.response.status,
  body: invalidPermission.body,
});

console.log(
  JSON.stringify(
    {
      status: "PASS",
      provider: providerStatus.body.provider,
      authServiceReady: authReady.body?.status === "ready",
      appCanReachAuthService: providerStatus.body.authService.ready,
      seededLogin: {
        loginId: seed.loginId,
        allowedPermission: seed.allowedPermission,
        deniedPermission: seed.deniedPermission,
      },
      accessTokenIssued: true,
      refreshTokenIssued: true,
      refreshTokenRotated: true,
      refreshReplayDetected: true,
      serviceTokenIssued: true,
      serviceTokenScopeValidated: true,
      jwksKeyId: login.body.accessTokenKeyId,
      seededLoginRequired: true,
    },
    null,
    2
  )
);
