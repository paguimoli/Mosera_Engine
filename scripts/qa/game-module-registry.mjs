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
run("npm", ["run", "game-engine:contract-test"]);

for (const path of [
  "services/game-engine/src/GameEngine.Application/Services/GameModuleRegistry.cs",
  "services/game-engine/src/GameEngine.Domain/Model/RegistryModels.cs",
  "docs/architecture/phase-22-6c-game-module-registry.md",
  "docs/architecture/adr/ADR-007-game-module-registry.md",
]) {
  assert(existsSync(path), "Required Game Module Registry artifact missing.", { path });
}

const registryStatus = await requestJson(`${gameEngineUrl}/api/game-engine/registry-status`);
assert(registryStatus.response.status === 200 && registryStatus.body?.success === true, "Registry status endpoint failed.", {
  status: registryStatus.response.status,
  body: registryStatus.body,
});
assert(registryStatus.body.registryStatus.registeredModuleCount >= 2, "Registry must discover registered modules.", {
  registryStatus: registryStatus.body.registryStatus,
});
assert(registryStatus.body.registryStatus.health === "Warning", "Registry should warn while placeholder modules are not production-ready.", {
  registryStatus: registryStatus.body.registryStatus,
});

const modulesResult = await requestJson(`${gameEngineUrl}/api/game-engine/modules`);
assert(modulesResult.response.status === 200 && modulesResult.body?.success === true, "Modules endpoint failed.", {
  status: modulesResult.response.status,
  body: modulesResult.body,
});
const modules = modulesResult.body.modules;
assert(Array.isArray(modules) && modules.length >= 2, "Registry must expose discovered modules.", { modules });

for (const moduleId of ["TEST_MODULE", "HOT_SPOT"]) {
  const moduleDiagnostic = modules.find((item) => item.manifest?.moduleId === moduleId);
  assert(moduleDiagnostic, `${moduleId} module missing from registry.`, { modules });
  assert(moduleDiagnostic.registrationStatus === "Registered", `${moduleId} must be registered.`, { moduleDiagnostic });
  assert(moduleDiagnostic.healthStatus === "Healthy", `${moduleId} health must be Healthy.`, { moduleDiagnostic });
  assert(moduleDiagnostic.productionReady === false, `${moduleId} must not be production-ready yet.`, { moduleDiagnostic });

  const detail = await requestJson(`${gameEngineUrl}/api/game-engine/modules/${moduleId}`);
  assert(detail.response.status === 200 && detail.body?.success === true, `${moduleId} detail endpoint failed.`, {
    status: detail.response.status,
    body: detail.body,
  });

  const versions = await requestJson(`${gameEngineUrl}/api/game-engine/modules/${moduleId}/versions`);
  assert(versions.response.status === 200 && versions.body?.success === true && versions.body.versions.length >= 1, `${moduleId} versions endpoint failed.`, {
    status: versions.response.status,
    body: versions.body,
  });
}

const bindingsResult = await requestJson(`${gameEngineUrl}/api/game-engine/game-bindings`);
assert(bindingsResult.response.status === 200 && bindingsResult.body?.success === true, "Game bindings endpoint failed.", {
  status: bindingsResult.response.status,
  body: bindingsResult.body,
});
const bindings = bindingsResult.body.gameBindings;
assert(Array.isArray(bindings) && bindings.length >= 2, "Prospective game bindings must be exposed.", { bindings });
assert(bindings.every((binding) => binding.versions?.length >= 1), "Bindings must be versioned.", { bindings });
assert(bindings.every((binding) => binding.versions[0].status === "Validated"), "Default prospective bindings must validate.", { bindings });

const bindingDetail = await requestJson(`${gameEngineUrl}/api/game-engine/game-bindings/${bindings[0].id}`);
assert(bindingDetail.response.status === 200 && bindingDetail.body?.success === true, "Game binding detail endpoint failed.", {
  status: bindingDetail.response.status,
  body: bindingDetail.body,
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

pass("Game Module Registry QA completed.", {
  gameEngineUrl,
  registeredModuleCount: registryStatus.body.registryStatus.registeredModuleCount,
  productionReadyModuleCount: registryStatus.body.registryStatus.productionReadyModuleCount,
  bindingCount: bindings.length,
});
