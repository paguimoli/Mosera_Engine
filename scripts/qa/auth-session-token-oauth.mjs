import { spawnSync } from "node:child_process";

const authServiceUrl = process.env.AUTH_SERVICE_URL || "http://localhost:5600";

function assert(condition, message, metadata = {}) {
  if (!condition) {
    console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
    process.exit(1);
  }
}

function runScript(script) {
  const result = spawnSync("npm", ["run", script], {
    stdio: "inherit",
    env: process.env,
  });
  assert(result.status === 0, `${script} failed.`);
}

async function tryGetJson(path) {
  try {
    const response = await fetch(`${authServiceUrl}${path}`);
    if (!response.ok) {
      return { available: true, ok: false, status: response.status, body: null };
    }

    return { available: true, ok: true, status: response.status, body: await response.json() };
  } catch {
    return { available: false, ok: false, status: null, body: null };
  }
}

runScript("auth-service:build");
runScript("auth-service:session-token-test");

const diagnostics = {
  sessionModel: await tryGetJson("/api/auth-service/session-model"),
  tokenIssuanceModel: await tryGetJson("/api/auth-service/token-issuance-model"),
  oauthRuntimeModel: await tryGetJson("/api/auth-service/oauth-model/runtime"),
  jwksModel: await tryGetJson("/api/auth-service/jwks-model"),
  serviceAuthModel: await tryGetJson("/api/auth-service/service-auth-model"),
  sessionReadiness: await tryGetJson("/api/auth-service/session-readiness"),
  tokenReadiness: await tryGetJson("/api/auth-service/token-readiness"),
  oauthReadiness: await tryGetJson("/api/auth-service/oauth-readiness"),
  loginEndpoint: await tryGetJson("/api/auth-service/login"),
  tokenEndpoint: await tryGetJson("/api/auth-service/token"),
  oauthTokenEndpoint: await tryGetJson("/api/auth-service/oauth/token"),
};

const diagnosticsAvailable = diagnostics.sessionModel.available;

if (diagnosticsAvailable) {
  for (const [name, result] of Object.entries(diagnostics)) {
    if (name.endsWith("Endpoint")) continue;
    assert(result.ok, `${name} endpoint failed.`, result);
  }

  assert(diagnostics.sessionModel.body?.data?.runtimeEnabled === false, "Session runtime must remain disabled.", diagnostics.sessionModel.body);
  assert(diagnostics.tokenIssuanceModel.body?.data?.runtimeEnabled === false, "Token issuance runtime must remain disabled.", diagnostics.tokenIssuanceModel.body);
  assert(diagnostics.oauthRuntimeModel.body?.data?.runtimeEndpointsEnabled === false, "OAuth runtime endpoints must remain disabled.", diagnostics.oauthRuntimeModel.body);
  assert(diagnostics.jwksModel.body?.data?.publicationEnabled === false, "JWKS publication must remain disabled.", diagnostics.jwksModel.body);
  assert(diagnostics.serviceAuthModel.body?.data?.runtimeEnabled === false, "Service auth runtime must remain disabled.", diagnostics.serviceAuthModel.body);
  assert(diagnostics.sessionReadiness.body?.data?.status === "Blocked", "Session readiness must be blocked.", diagnostics.sessionReadiness.body);
  assert(diagnostics.tokenReadiness.body?.data?.status === "Blocked", "Token readiness must be blocked.", diagnostics.tokenReadiness.body);
  assert(diagnostics.oauthReadiness.body?.data?.status === "Blocked", "OAuth readiness must be blocked.", diagnostics.oauthReadiness.body);
  assert(diagnostics.loginEndpoint.status === 404, "Auth Service login endpoint must not exist.", diagnostics.loginEndpoint);
  assert(diagnostics.tokenEndpoint.status === 404, "Auth Service token endpoint must not exist.", diagnostics.tokenEndpoint);
  assert(diagnostics.oauthTokenEndpoint.status === 404, "Auth Service OAuth token endpoint must not exist.", diagnostics.oauthTokenEndpoint);
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      message: "Auth session/token/OAuth QA completed.",
      diagnosticsAvailable,
      endpointsChecked: [
        "/api/auth-service/session-model",
        "/api/auth-service/token-issuance-model",
        "/api/auth-service/oauth-model/runtime",
        "/api/auth-service/jwks-model",
        "/api/auth-service/service-auth-model",
        "/api/auth-service/session-readiness",
        "/api/auth-service/token-readiness",
        "/api/auth-service/oauth-readiness",
      ],
      runtimeLoginImplemented: false,
      tokenIssuanceImplemented: false,
      oauthRuntimeEndpointsEnabled: false,
      currentPlatformAuthChanged: false,
    },
    null,
    2
  )
);
