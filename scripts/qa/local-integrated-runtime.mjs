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

for (const name of [
  "app",
  "game-engine",
  "settlement-service",
  "ledger-service",
  "credit-wallet-service",
]) {
  assert(health(name)?.status === "UP", `${name} must be reachable.`, { service: health(name) });
}

const auth = health("auth-service");
assert(
  auth?.status === "UP" || auth?.status === "NOT_REGISTERED",
  "Auth Service must be healthy when registered, or explicitly NOT_REGISTERED.",
  { auth }
);

const rabbitmqManagement = health("rabbitmq-management");
const rabbitmqBroker = health("rabbitmq-broker");
assert(
  rabbitmqManagement?.status === "UP" || rabbitmqBroker?.status === "UP",
  "RabbitMQ management or broker must be reachable.",
  { rabbitmqManagement, rabbitmqBroker }
);

const redis = health("redis");
assert(redis?.status === "UP", "Redis must be reachable.", { redis });

console.log(
  JSON.stringify(
    {
      status: "PASS",
      message: "Local integrated runtime baseline is reachable.",
      authServiceStatus: auth.status,
      checkedServices: inventory.serviceHealth.map((item) => ({
        name: item.name,
        status: item.status,
      })),
    },
    null,
    2
  )
);
