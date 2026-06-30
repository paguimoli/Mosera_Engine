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
run("npm", ["run", "game-engine:keno-test"]);

for (const path of [
  "services/game-engine/src/GameEngine.Modules/Keno/KenoModule.cs",
  "services/game-engine/tests/GameEngine.Modules.Tests/Program.cs",
  "docs/architecture/phase-22-6i-keno-game-module-reference.md",
  "docs/architecture/adr/ADR-016-keno-module-reference-implementation.md",
]) {
  assert(existsSync(path), "Required Keno module artifact missing.", { path });
}

const modulesResult = await requestJson(`${gameEngineUrl}/api/game-engine/modules`);
assert(modulesResult.response.status === 200 && modulesResult.body?.success === true, "Game Engine modules endpoint failed.", {
  status: modulesResult.response.status,
  body: modulesResult.body,
});
const modules = modulesResult.body.modules;
const keno = modules.find((moduleStatus) => moduleStatus.manifest?.moduleId === "KENO_GENERIC");
assert(keno, "Generic Keno module must be discovered.", { modules });
assert(keno.manifest.moduleName === "Generic Keno Module", "Keno module must be generic.", { keno });
assert(keno.registrationStatus === "Registered", "Keno module must register successfully.", { keno });
assert(keno.healthStatus === "Healthy", "Keno module health must be Healthy.", { keno });
assert(keno.productionReady === false, "Keno module must not be production active.", { keno });
assert(keno.manifest.supportsInternalDrawGeneration === false, "Keno internal draw generation must be disabled by default.", { keno });

for (const wagerType of [
  "KenoSpot",
  "KenoBullseye",
  "KenoBigSmall",
  "KenoOddEven",
  "KenoUpDown",
  "KenoDragonTiger",
  "KenoSumOverUnder",
  "KenoElement",
]) {
  assert(keno.manifest.supportedWagerTypes.includes(wagerType), `Keno wager type ${wagerType} must be visible.`, { keno });
}

const moduleDetail = await requestJson(`${gameEngineUrl}/api/game-engine/modules/KENO_GENERIC`);
assert(moduleDetail.response.status === 200 && moduleDetail.body?.success === true, "Keno module detail endpoint failed.", {
  status: moduleDetail.response.status,
  body: moduleDetail.body,
});
assert(moduleDetail.body.module.productionReady === false, "Keno detail must remain non-production.", {
  module: moduleDetail.body.module,
});

const versions = await requestJson(`${gameEngineUrl}/api/game-engine/modules/KENO_GENERIC/versions`);
assert(versions.response.status === 200 && versions.body?.success === true && versions.body.versions.length >= 1, "Keno versions endpoint failed.", {
  status: versions.response.status,
  body: versions.body,
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

pass("Keno module QA completed.", {
  gameEngineUrl,
  moduleId: keno.manifest.moduleId,
  moduleVersion: keno.manifest.moduleVersion,
  wagerTypes: keno.manifest.supportedWagerTypes,
  productionReady: keno.productionReady,
  internalDrawGeneration: keno.manifest.supportsInternalDrawGeneration,
});
