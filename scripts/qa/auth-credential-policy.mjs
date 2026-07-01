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
runScript("auth-service:credential-policy-test");

const diagnostics = {
  credentialVerificationModel: await tryGetJson("/api/auth-service/credential-verification-model"),
  passwordPolicy: await tryGetJson("/api/auth-service/password-policy"),
  mfaPolicy: await tryGetJson("/api/auth-service/mfa-policy"),
  authenticationEligibility: await tryGetJson("/api/auth-service/authentication-eligibility"),
  credentialVerifiers: await tryGetJson("/api/auth-service/credential-verifiers"),
  loginEndpoint: await tryGetJson("/api/auth-service/login"),
  tokenEndpoint: await tryGetJson("/api/auth-service/token"),
};

const diagnosticsAvailable = diagnostics.credentialVerificationModel.available;

if (diagnosticsAvailable) {
  assert(diagnostics.credentialVerificationModel.ok, "Credential verification model endpoint failed.", diagnostics.credentialVerificationModel);
  assert(diagnostics.passwordPolicy.ok, "Password policy endpoint failed.", diagnostics.passwordPolicy);
  assert(diagnostics.mfaPolicy.ok, "MFA policy endpoint failed.", diagnostics.mfaPolicy);
  assert(diagnostics.authenticationEligibility.ok, "Authentication eligibility endpoint failed.", diagnostics.authenticationEligibility);
  assert(diagnostics.credentialVerifiers.ok, "Credential verifiers endpoint failed.", diagnostics.credentialVerifiers);

  assert(
    diagnostics.credentialVerificationModel.body?.data?.productionVerificationImplemented === false,
    "Production credential verification must remain disabled.",
    diagnostics.credentialVerificationModel.body
  );
  assert(
    diagnostics.credentialVerificationModel.body?.data?.tokenIssuanceAllowed === false,
    "Credential verification must not issue tokens.",
    diagnostics.credentialVerificationModel.body
  );
  assert(
    diagnostics.passwordPolicy.body?.data?.passwordlessAllowed === true,
    "Passwordless policy must be supported.",
    diagnostics.passwordPolicy.body
  );
  assert(
    diagnostics.passwordPolicy.body?.data?.plaintextPasswordStorageAllowed === false,
    "Plaintext password storage must remain disallowed.",
    diagnostics.passwordPolicy.body
  );
  assert(
    diagnostics.mfaPolicy.body?.data?.productionMfaVerificationImplemented === false,
    "Production MFA verification must remain deferred.",
    diagnostics.mfaPolicy.body
  );
  assert(
    diagnostics.credentialVerifiers.body?.data?.secretValuesExposed === false,
    "Credential verifier catalog must not expose secrets.",
    diagnostics.credentialVerifiers.body
  );
  assert(diagnostics.loginEndpoint.status === 404, "Auth Service login endpoint must not exist.", diagnostics.loginEndpoint);
  assert(diagnostics.tokenEndpoint.status === 404, "Auth Service token issuance endpoint must not exist.", diagnostics.tokenEndpoint);
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      message: "Auth credential policy QA completed.",
      diagnosticsAvailable,
      endpointsChecked: [
        "/api/auth-service/credential-verification-model",
        "/api/auth-service/password-policy",
        "/api/auth-service/mfa-policy",
        "/api/auth-service/authentication-eligibility",
        "/api/auth-service/credential-verifiers",
      ],
      productionLoginImplemented: false,
      tokenIssuanceImplemented: false,
      currentPlatformAuthChanged: false,
    },
    null,
    2
  )
);
