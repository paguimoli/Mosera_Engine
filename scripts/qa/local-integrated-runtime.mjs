import { spawnSync } from "node:child_process";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

const result = spawnSync("node", ["scripts/operations/local-runtime-inventory.mjs"], {
  encoding: "utf8",
  env: process.env,
});

assert(result.status === 0, "Local runtime inventory script failed.", {
  stdout: result.stdout,
  stderr: result.stderr,
});

let inventory;
try {
  inventory = JSON.parse(result.stdout);
} catch (error) {
  fail("Local runtime inventory did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: result.stdout,
  });
}

function health(name) {
  return inventory.serviceHealth.find((item) => item.name === name);
}

function readiness(name) {
  return inventory.serviceReadiness?.find((item) => item.name === name);
}

for (const name of [
  "app",
  "auth-service",
  "game-engine",
  "settlement-service",
  "ledger-service",
  "credit-wallet-service",
]) {
  assert(health(name)?.status === "UP", `${name} must be reachable.`, { service: health(name) });
}

for (const name of [
  "auth-service",
  "game-engine",
  "settlement-service",
  "ledger-service",
  "credit-wallet-service",
]) {
  assert(readiness(name)?.status === "READY", `${name} readiness endpoint must pass.`, {
    readiness: readiness(name),
  });
}

const notReadyDependencies = (inventory.dependencyReadiness ?? []).filter((item) => item.status === "NOT_READY");
assert(notReadyDependencies.length === 0, "All reported service dependencies must be ready.", {
  notReadyDependencies,
});

const auth = health("auth-service");

const rabbitmqManagement = health("rabbitmq-management");
const rabbitmqBroker = health("rabbitmq-broker");
assert(
  rabbitmqManagement?.status === "UP" || rabbitmqBroker?.status === "UP",
  "RabbitMQ management or broker must be reachable.",
  { rabbitmqManagement, rabbitmqBroker }
);

const redis = health("redis");
assert(redis?.status === "UP", "Redis must be reachable.", { redis });

assert(
  inventory.durablePersistence?.gameEngineDatabaseUrlConfigured,
  "Game Engine must have DATABASE_URL configured in local runtime.",
  { durablePersistence: inventory.durablePersistence }
);
assert(
  inventory.durablePersistence?.gameEngineDurablePersistenceModeActive,
  "Game Engine durable persistence mode must be active.",
  { durablePersistence: inventory.durablePersistence }
);
assert(
  inventory.durablePersistence?.migrationsCurrent,
  "Local migrations must validate before runtime QA passes.",
  { durablePersistence: inventory.durablePersistence }
);
assert(
  inventory.authProvider?.configuredProvider === "auth-service",
  "Local runtime app must be configured for Auth Service provider mode.",
  { authProvider: inventory.authProvider }
);
assert(
  inventory.authProvider?.authServiceUrlConfigured,
  "Local runtime app must have AUTH_SERVICE_URL configured.",
  { authProvider: inventory.authProvider }
);

const authServiceCutoverResult = spawnSync("node", ["scripts/qa/auth-service-cutover.mjs"], {
  encoding: "utf8",
  env: process.env,
});

assert(authServiceCutoverResult.status === 0, "Auth Service cutover QA failed.", {
  stdout: authServiceCutoverResult.stdout,
  stderr: authServiceCutoverResult.stderr,
  exitCode: authServiceCutoverResult.status,
});

let authServiceCutover;
try {
  authServiceCutover = JSON.parse(authServiceCutoverResult.stdout);
} catch (error) {
  fail("Auth Service cutover QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: authServiceCutoverResult.stdout,
  });
}

const durableSmokeResult = spawnSync("node", ["scripts/qa/game-engine-durable-runtime-smoke.mjs"], {
  encoding: "utf8",
  env: process.env,
});

assert(durableSmokeResult.status === 0, "Game Engine durable runtime smoke QA failed.", {
  stdout: durableSmokeResult.stdout,
  stderr: durableSmokeResult.stderr,
  exitCode: durableSmokeResult.status,
});

let durableSmoke;
try {
  durableSmoke = JSON.parse(durableSmokeResult.stdout);
} catch (error) {
  fail("Game Engine durable runtime smoke QA did not return JSON.", {
    error: error instanceof Error ? error.message : String(error),
    stdout: durableSmokeResult.stdout,
  });
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      message: "Local integrated runtime baseline is reachable.",
      authServiceStatus: auth.status,
      durablePersistence: {
        gameEngineDatabaseUrlConfigured: inventory.durablePersistence.gameEngineDatabaseUrlConfigured,
        gameEngineDurablePersistenceModeActive: inventory.durablePersistence.gameEngineDurablePersistenceModeActive,
        migrationsCurrent: inventory.durablePersistence.migrationsCurrent,
      },
      authServiceCutover,
      gameEngineDurableSmoke: {
        status: durableSmoke.status,
        coverage: durableSmoke.coverage,
      },
      checkedServices: inventory.serviceHealth.map((item) => ({
        name: item.name,
        status: item.status,
      })),
      checkedReadiness: (inventory.serviceReadiness ?? []).map((item) => ({
        name: item.name,
        status: item.status,
      })),
    },
    null,
    2
  )
);
