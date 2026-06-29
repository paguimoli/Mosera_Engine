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

for (const path of [
  "services/game-engine/GameEngine.sln",
  "services/game-engine/src/GameEngine.Api/GameEngine.Api.csproj",
  "services/game-engine/src/GameEngine.Domain/Model/GameEngineModels.cs",
  "services/game-engine/src/GameEngine.Domain/Modules/GameModuleContracts.cs",
  "services/game-engine/database/001_game_engine_schema_draft.sql",
  "docs/architecture/phase-22-6a-game-engine-architecture-specification.md",
  "docs/architecture/adr/ADR-001-game-engine-dotnet-service.md",
  "docs/architecture/adr/ADR-002-draw-authority-provider-agnostic-certified-result.md",
  "docs/architecture/adr/ADR-003-game-modules-own-game-math.md",
  "docs/architecture/adr/ADR-004-game-evaluation-records-feed-settlement.md",
  "docs/architecture/adr/ADR-005-game-engine-shared-schema-ownership.md",
]) {
  assert(existsSync(path), "Required Game Engine skeleton artifact missing.", { path });
}

const health = await requestJson(`${gameEngineUrl}/health`);
assert(health.response.status === 200 && health.body?.status === "ok", "Game Engine health endpoint failed.", {
  gameEngineUrl,
  status: health.response.status,
  body: health.body,
});

const status = await requestJson(`${gameEngineUrl}/api/game-engine/status`);
assert(status.response.status === 200 && status.body?.success === true, "Game Engine status endpoint failed.", {
  status: status.response.status,
  body: status.body,
});
assert(status.body.data.productionGameLogicEnabled === false, "Production game logic must remain disabled.", {
  body: status.body,
});
assert(status.body.data.productionRngEnabled === false, "Production RNG must remain disabled.", {
  body: status.body,
});
assert(status.body.data.settlementIntegrationEnabled === false, "Settlement integration must remain disabled.", {
  body: status.body,
});

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

pass("Game Engine skeleton QA completed.", {
  gameEngineUrl,
  productionGameLogicEnabled: status.body.data.productionGameLogicEnabled,
  productionRngEnabled: status.body.data.productionRngEnabled,
  settlementIntegrationEnabled: status.body.data.settlementIntegrationEnabled,
});
