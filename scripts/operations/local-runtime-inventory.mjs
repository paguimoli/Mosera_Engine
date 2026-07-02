import { spawnSync } from "node:child_process";
import net from "node:net";

const endpoints = [
  { name: "app", url: process.env.APP_URL || "http://localhost:3000", required: true },
  { name: "game-engine", url: process.env.GAME_ENGINE_URL || "http://localhost:5500/health", required: true },
  { name: "settlement-service", url: process.env.SETTLEMENT_SERVICE_URL || "http://localhost:5400/health", required: true },
  { name: "ledger-service", url: process.env.LEDGER_SERVICE_URL || "http://localhost:5200/health", required: true },
  { name: "credit-wallet-service", url: process.env.CREDIT_SERVICE_URL || "http://localhost:5300/health", required: true },
];

const authServiceUrl = process.env.AUTH_SERVICE_URL || "http://localhost:5600/health";

function withHealthPath(url) {
  return url.endsWith("/health") || url.endsWith("/ready") ? url : `${url.replace(/\/$/, "")}/health`;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function parseComposePs(stdout) {
  if (!stdout) return [];
  return stdout
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseDockerPsLabels(stdout) {
  if (!stdout) return [];
  return stdout
    .split("\n")
    .map((line) => {
      const [name, service] = line.trim().split(/\s+/, 2);
      return name && service ? { Name: name, Service: service, State: "running" } : null;
    })
    .filter(Boolean);
}

async function checkHttp(name, url) {
  try {
    const response = await fetch(url);
    return {
      name,
      url,
      status: response.ok ? "UP" : "DEGRADED",
      httpStatus: response.status,
    };
  } catch (error) {
    return {
      name,
      url,
      status: "DOWN",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkTcp(name, host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port), timeout: 1500 });
    socket.on("connect", () => {
      socket.destroy();
      resolve({ name, host, port: Number(port), status: "UP" });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ name, host, port: Number(port), status: "DOWN", error: "timeout" });
    });
    socket.on("error", (error) => {
      resolve({ name, host, port: Number(port), status: "DOWN", error: error.message });
    });
  });
}

const composeServicesResult = run("docker", ["compose", "config", "--services"]);
const composeServices = composeServicesResult.ok
  ? composeServicesResult.stdout.split("\n").filter(Boolean).sort()
  : [];
const psResult = run("docker", ["compose", "ps", "--format", "json"]);
const dockerPsResult = run("docker", [
  "ps",
  "--format",
  "{{.Names}} {{.Label \"com.docker.compose.service\"}}",
]);
const runningContainers = parseComposePs(psResult.stdout);
const visibleRunningContainers =
  runningContainers.length > 0 ? runningContainers : parseDockerPsLabels(dockerPsResult.stdout);
const runningServiceNames = new Set(
  visibleRunningContainers.map((container) => container.Service).filter(Boolean)
);

const serviceHealth = [];
for (const endpoint of endpoints) {
  const url = endpoint.name === "app" ? endpoint.url : withHealthPath(endpoint.url);
  serviceHealth.push(await checkHttp(endpoint.name, url));
}

const authRegistered = composeServices.includes("auth-service");
const authHealth = authRegistered
  ? await checkHttp("auth-service", withHealthPath(authServiceUrl))
  : { name: "auth-service", status: "NOT_REGISTERED", url: authServiceUrl };

const rabbitmqManagement = await checkHttp(
  "rabbitmq-management",
  process.env.RABBITMQ_MANAGEMENT_URL || "http://localhost:15672"
);
const rabbitmqBroker = await checkTcp(
  "rabbitmq-broker",
  process.env.RABBITMQ_HOST || "localhost",
  process.env.RABBITMQ_PORT || "5672"
);
const redis = await checkTcp(
  "redis",
  process.env.REDIS_HOST || "localhost",
  process.env.REDIS_PORT || "6379"
);

const expectedServices = [
  "app",
  "game-engine",
  "settlement-service",
  "ledger-service",
  "credit-wallet-service",
  "rabbitmq",
  "redis",
];

const missingServices = expectedServices.filter((service) => !composeServices.includes(service));
const notRunning = expectedServices.filter(
  (service) => composeServices.includes(service) && !runningServiceNames.has(service)
);

const report = {
  status: missingServices.length === 0 ? "OK" : "DEGRADED",
  generatedAt: new Date().toISOString(),
  compose: {
    services: composeServices,
    configAvailable: composeServicesResult.ok,
    runningContainers: visibleRunningContainers,
    missingServices,
    notRunning,
  },
  exposedPorts: {
    app: 3000,
    gameEngine: 5500,
    settlementService: 5400,
    ledgerService: 5200,
    creditWalletService: 5300,
    rabbitmqBroker: 5672,
    rabbitmqManagement: 15672,
    redis: 6379,
  },
  serviceHealth: [...serviceHealth, authHealth, rabbitmqManagement, rabbitmqBroker, redis],
  expectedVsActual: expectedServices.map((service) => ({
    service,
    registered: composeServices.includes(service),
    running: runningServiceNames.has(service),
  })),
};

console.log(JSON.stringify(report, null, 2));
