import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const gameEngineUrl =
  process.env.QA_GAME_ENGINE_URL ||
  (existsSync("/.dockerenv") || appUrl.includes("app:3000")
    ? "http://game-engine:8080"
    : "http://localhost:5500");
let sessionToken = process.env.QA_ADMIN_SESSION_TOKEN || process.env.OPS_ADMIN_SESSION_TOKEN;
const adminUsername = process.env.QA_ADMIN_USERNAME || "admin2";
const adminPassword = process.env.QA_ADMIN_PASSWORD || "";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function pass(message, metadata = {}) {
  console.log(JSON.stringify({ status: "PASS", message, ...metadata }, null, 2));
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

function run(command, args, metadata = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });

  assert(result.status === 0, `${command} ${args.join(" ")} failed.`, {
    ...metadata,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

async function ensureSessionToken() {
  if (sessionToken) return;
  if (!adminPassword) return;

  const login = await requestJson(`${appUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: adminUsername,
      password: adminPassword,
    }),
  });

  assert(login.response.status === 200 && login.body?.success === true && login.body.sessionToken, "Admin login failed.", {
    status: login.response.status,
    body: login.body,
  });

  sessionToken = login.body.sessionToken;
}

run("npm", ["run", "game-engine:build"]);
run("npm", ["run", "game-engine:test"]);
run("npm", ["run", "game-engine:certification-test"]);

for (const path of [
  "services/game-engine/src/GameEngine.Domain/Model/RandomnessCertificationModels.cs",
  "services/game-engine/src/GameEngine.Domain/Randomness/RandomnessContracts.cs",
  "services/game-engine/src/GameEngine.Application/Services/RandomnessProviders.cs",
  "services/game-engine/src/GameEngine.Application/Services/DrawGenerationFramework.cs",
  "services/game-engine/src/GameEngine.Application/Services/CertificationSuite.cs",
  "services/game-engine/src/GameEngine.Application/Services/ValidationSuite.cs",
  "docs/architecture/phase-22-6e-randomness-certification-infrastructure.md",
  "docs/architecture/adr/ADR-009-randomness-provider-abstraction.md",
  "docs/architecture/adr/ADR-010-certification-suite.md",
  "docs/architecture/adr/ADR-011-validation-suite.md",
  "docs/architecture/adr/ADR-012-certification-packages.md",
]) {
  assert(existsSync(path), "Required randomness/certification artifact missing.", { path });
}

const randomness = await requestJson(`${gameEngineUrl}/api/game-engine/randomness`);
assert(randomness.response.status === 200 && randomness.body?.success === true, "Randomness endpoint failed.", {
  status: randomness.response.status,
  body: randomness.body,
});
assert(randomness.body.productionRngImplemented === false, "Production RNG must not be implemented in Phase 22.6E.", {
  body: randomness.body,
});

const providersResult = await requestJson(`${gameEngineUrl}/api/game-engine/randomness/providers`);
assert(providersResult.response.status === 200 && providersResult.body?.success === true, "Randomness providers endpoint failed.", {
  status: providersResult.response.status,
  body: providersResult.body,
});
const providers = providersResult.body.providers;
assert(Array.isArray(providers) && providers.length >= 2, "Production and test randomness providers must be discoverable.", { providers });
assert(providers.every((provider) => provider.metadata.productionRngImplemented === false), "No provider may claim production RNG implementation.", {
  providers,
});
assert(
  providers.some((provider) => provider.metadata.providerId === "deterministic-test-prng" && provider.metadata.deterministic === true),
  "Deterministic test PRNG provider missing.",
  { providers }
);

const certification = await requestJson(`${gameEngineUrl}/api/game-engine/certification`);
assert(certification.response.status === 200 && certification.body?.success === true, "Certification status endpoint failed.", {
  status: certification.response.status,
  body: certification.body,
});
assert(certification.body.archiveGenerationEnabled === false, "Archive/PDF generation must remain disabled.", {
  body: certification.body,
});

const packagesResult = await requestJson(`${gameEngineUrl}/api/game-engine/certification/packages`);
assert(packagesResult.response.status === 200 && packagesResult.body?.success === true, "Certification packages endpoint failed.", {
  status: packagesResult.response.status,
  body: packagesResult.body,
});
const packages = packagesResult.body.certificationPackages;
assert(Array.isArray(packages) && packages.length >= 1, "Certification package must be generated.", { packages });
const certificationPackage = packages[0];
assert(certificationPackage.prngMetadata.productionRngImplemented === false, "Certification package must not certify production RNG.", {
  certificationPackage,
});
assert(certificationPackage.checksums?.some((checksum) => checksum.algorithm === "Sha256"), "Certification package must include SHA256 evidence.", {
  certificationPackage,
});
assert(certificationPackage.gameMetadata?.productionGameLogicEnabled === false, "Certification package must not enable production game logic.", {
  certificationPackage,
});

const validation = await requestJson(`${gameEngineUrl}/api/game-engine/validation`);
assert(validation.response.status === 200 && validation.body?.success === true, "Validation endpoint failed.", {
  status: validation.response.status,
  body: validation.body,
});
assert(validation.body.longRunningExecutionEnabled === false, "Validation endpoint must be framework-only.", {
  body: validation.body,
});
assert(validation.body.validation.length >= 10, "Validation suite must expose validators and benchmarks.", {
  validation: validation.body.validation,
});

const statistics = await requestJson(`${gameEngineUrl}/api/game-engine/statistics`);
assert(statistics.response.status === 200 && statistics.body?.success === true, "Statistics endpoint failed.", {
  status: statistics.response.status,
  body: statistics.body,
});
assert(statistics.body.algorithmStatus === "FRAMEWORK_ONLY", "Statistical algorithms must remain framework-only.", {
  body: statistics.body,
});

const evidence = await requestJson(`${gameEngineUrl}/api/game-engine/evidence`);
assert(evidence.response.status === 200 && evidence.body?.success === true, "Evidence endpoint failed.", {
  status: evidence.response.status,
  body: evidence.body,
});
assert(evidence.body.checksumAlgorithm === "SHA256", "Evidence must report SHA256 support.", {
  body: evidence.body,
});
assert(evidence.body.mutationPerformed === false, "Evidence endpoint must be read-only.", {
  body: evidence.body,
});

const build = await requestJson(`${gameEngineUrl}/api/game-engine/certification/build`, {
  method: "POST",
});
assert(build.response.status === 202 && build.body?.archiveGenerated === false, "Certification build endpoint must remain placeholder-only.", {
  status: build.response.status,
  body: build.body,
});

const validationRun = await requestJson(`${gameEngineUrl}/api/game-engine/validation/run`, {
  method: "POST",
});
assert(validationRun.response.status === 202 && validationRun.body?.longRunningExecutionStarted === false, "Validation run endpoint must remain placeholder-only.", {
  status: validationRun.response.status,
  body: validationRun.body,
});

await ensureSessionToken();
if (sessionToken) {
  const authority = await requestJson(`${appUrl}/api/authority/status`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert(authority.response.status === 200 && authority.body?.success === true, "Authority status failed.", {
    status: authority.response.status,
    body: authority.body,
  });
  assert(authority.body.authority.settlement.authority === "SERVICE", "Settlement authority changed.", {
    authority: authority.body.authority,
  });
  assert(authority.body.authority.ledger.authority === "SERVICE", "Ledger authority changed.", {
    authority: authority.body.authority,
  });
  assert(authority.body.authority.credit.authority === "SERVICE", "Credit authority changed.", {
    authority: authority.body.authority,
  });
}

pass("Randomness and certification infrastructure QA completed.", {
  gameEngineUrl,
  providerCount: providers.length,
  packageCount: packages.length,
  validationCount: validation.body.validation.length,
  evidenceCount: evidence.body.evidence.length,
});
