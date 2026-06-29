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

  return result;
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
run("npm", ["run", "game-engine:contract-test"]);

for (const path of [
  "services/game-engine/src/GameEngine.Domain/Modules/GameModuleContracts.cs",
  "services/game-engine/src/GameEngine.Domain/Modules/GameModuleLifecycleGate.cs",
  "services/game-engine/src/GameEngine.Domain/Model/ValidationModels.cs",
  "services/game-engine/src/GameEngine.Domain/Model/EvaluationModels.cs",
  "services/game-engine/tests/GameEngine.Modules.Tests/GameModuleContractTestBase.cs",
  "docs/architecture/phase-22-6b-game-module-sdk-contract.md",
  "docs/architecture/adr/ADR-006-game-module-sdk-contract.md",
]) {
  assert(existsSync(path), "Required Game Module SDK artifact missing.", { path });
}

const modulesResult = await requestJson(`${gameEngineUrl}/api/game-engine/modules`);
assert(modulesResult.response.status === 200 && modulesResult.body?.success === true, "Game Engine modules endpoint failed.", {
  gameEngineUrl,
  status: modulesResult.response.status,
  body: modulesResult.body,
});

const modules = modulesResult.body.modules;
assert(Array.isArray(modules) && modules.length >= 2, "Module endpoint must return structured module status data.", {
  modules,
});

const byModuleId = new Map(modules.map((moduleStatus) => [moduleStatus.manifest?.moduleId, moduleStatus]));
for (const moduleId of ["TEST_MODULE", "HOT_SPOT"]) {
  const moduleStatus = byModuleId.get(moduleId);
  assert(moduleStatus, `${moduleId} module status missing.`, { modules });
  assert(moduleStatus.manifest.moduleVersion, `${moduleId} module version missing.`, { moduleStatus });
  assert(moduleStatus.manifest.gameTypes?.length > 0, `${moduleId} supported game types missing.`, { moduleStatus });
  assert(moduleStatus.manifest.supportedWagerTypes?.length > 0, `${moduleId} supported wager types missing.`, { moduleStatus });
  assert(moduleStatus.healthStatus === "Healthy", `${moduleId} health must be Healthy.`, { moduleStatus });
  assert(moduleStatus.productionReady === false, `${moduleId} must not be production-ready in Phase 22.6B.`, { moduleStatus });
}

await ensureSessionToken();
if (sessionToken) {
  let authority = await requestJson(`${appUrl}/api/authority/status`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if ((authority.response.status === 401 || authority.response.status === 403) && adminPassword) {
    sessionToken = "";
    await ensureSessionToken();
    authority = await requestJson(`${appUrl}/api/authority/status`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
  }

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

pass("Game Module SDK QA completed.", {
  gameEngineUrl,
  modules: modules.map((moduleStatus) => ({
    moduleId: moduleStatus.manifest.moduleId,
    lifecycleStatus: moduleStatus.manifest.lifecycleStatus,
    productionReady: moduleStatus.productionReady,
  })),
});
