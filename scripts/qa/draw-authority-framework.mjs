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
run("npm", ["run", "game-engine:draw-authority-test"]);

for (const path of [
  "services/game-engine/src/GameEngine.Domain/Model/DrawAuthorityModels.cs",
  "services/game-engine/src/GameEngine.Domain/DrawAuthorities/DrawAuthorityContracts.cs",
  "services/game-engine/src/GameEngine.Application/Services/DrawAuthorityRegistry.cs",
  "services/game-engine/src/GameEngine.Application/Services/DrawProviderPlaceholders.cs",
  "services/game-engine/src/GameEngine.Application/Services/DrawAuthorityServices.cs",
  "docs/architecture/phase-22-6d-draw-authority-framework.md",
  "docs/architecture/adr/ADR-008-draw-authority-approval-gates.md",
]) {
  assert(existsSync(path), "Required Draw Authority artifact missing.", { path });
}

const registryStatus = await requestJson(`${gameEngineUrl}/api/game-engine/draw-authority-registry-status`);
assert(registryStatus.response.status === 200 && registryStatus.body?.success === true, "Draw Authority registry status endpoint failed.", {
  status: registryStatus.response.status,
  body: registryStatus.body,
});
assert(registryStatus.body.registryStatus.registeredAuthorityCount >= 5, "Draw Authority registry must expose placeholder authorities.", {
  registryStatus: registryStatus.body.registryStatus,
});
assert(registryStatus.body.registryStatus.productionReadyAuthorityCount === 0, "No Draw Authority should be production-ready in Phase 22.6D.", {
  registryStatus: registryStatus.body.registryStatus,
});

const authoritiesResult = await requestJson(`${gameEngineUrl}/api/game-engine/draw-authorities`);
assert(authoritiesResult.response.status === 200 && authoritiesResult.body?.success === true, "Draw Authorities endpoint failed.", {
  status: authoritiesResult.response.status,
  body: authoritiesResult.body,
});
const authorities = authoritiesResult.body.drawAuthorities;
const providers = authoritiesResult.body.providers;
assert(Array.isArray(authorities) && authorities.length >= 5, "Draw Authority placeholders must be visible.", { authorities });
assert(Array.isArray(providers) && providers.length >= 5, "Draw provider placeholders must be visible.", { providers });
assert(providers.every((provider) => provider.productionRngImplemented === false), "No production RNG implementation may be exposed.", { providers });

const byCode = new Map(authorities.map((entry) => [entry.authority?.code, entry]));
for (const code of [
  "manual-certified-entry",
  "official-feed-placeholder",
  "internal-production-prng",
  "internal-test-prng",
  "external-rng-placeholder",
]) {
  assert(byCode.has(code), `${code} Draw Authority missing.`, { authorities });
}

const testPrng = byCode.get("internal-test-prng");
assert(testPrng.productionReady === false, "Internal Test PRNG must not be production-ready.", { testPrng });

const manual = byCode.get("manual-certified-entry");
assert(
  manual.authority.capabilities.includes("RequiresOperatorCertification"),
  "Manual Certified Result provider must require operator certification metadata.",
  { manual }
);

const manualHealth = await requestJson(`${gameEngineUrl}/api/game-engine/draw-authorities/${manual.authority.id}/health`);
assert(manualHealth.response.status === 200 && manualHealth.body?.success === true, "Draw Authority health endpoint failed.", {
  status: manualHealth.response.status,
  body: manualHealth.body,
});

const versions = await requestJson(`${gameEngineUrl}/api/game-engine/draw-authorities/${manual.authority.id}/versions`);
assert(versions.response.status === 200 && versions.body?.versions?.length >= 1, "Draw Authority versions endpoint failed.", {
  status: versions.response.status,
  body: versions.body,
});

const submissionsResult = await requestJson(`${gameEngineUrl}/api/game-engine/draw-result-submissions`);
assert(submissionsResult.response.status === 200 && submissionsResult.body?.success === true, "Draw result submissions endpoint failed.", {
  status: submissionsResult.response.status,
  body: submissionsResult.body,
});
assert(submissionsResult.body.drawResultSubmissions.length >= 2, "Multiple result submissions must be visible.", {
  submissions: submissionsResult.body.drawResultSubmissions,
});
assert(submissionsResult.body.immutable === true, "Draw result submissions must be reported immutable.", {
  body: submissionsResult.body,
});

const officialResults = await requestJson(`${gameEngineUrl}/api/game-engine/official-certified-results`);
assert(officialResults.response.status === 200 && officialResults.body?.success === true, "Official certified results endpoint failed.", {
  status: officialResults.response.status,
  body: officialResults.body,
});
assert(officialResults.body.settlementIntegrationEnabled === false, "Settlement integration must remain disabled.", {
  body: officialResults.body,
});

const approve = await requestJson(`${gameEngineUrl}/api/game-engine/draw-authorities/${manual.authority.id}/approve`, {
  method: "POST",
});
assert(approve.response.status === 202 && approve.body?.productionUseEnabled === false, "Approval endpoint must remain placeholder-only.", {
  status: approve.response.status,
  body: approve.body,
});

const manualResult = await requestJson(`${gameEngineUrl}/api/game-engine/manual-results`, {
  method: "POST",
});
assert(manualResult.response.status === 202 && manualResult.body?.officialCertifiedResultCreated === false, "Manual result endpoint must remain placeholder-only.", {
  status: manualResult.response.status,
  body: manualResult.body,
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

pass("Draw Authority framework QA completed.", {
  gameEngineUrl,
  registeredAuthorityCount: registryStatus.body.registryStatus.registeredAuthorityCount,
  productionReadyAuthorityCount: registryStatus.body.registryStatus.productionReadyAuthorityCount,
  providerCount: providers.length,
  resultSubmissionCount: submissionsResult.body.drawResultSubmissions.length,
});
