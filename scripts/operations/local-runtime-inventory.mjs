import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

const runningInContainer = existsSync("/.dockerenv");

const endpoints = [
  {
    name: "app",
    url: process.env.APP_URL || "http://localhost:3000",
    livePath: "/api/health",
    readyPath: null,
    port: 3000,
    profile: "default",
    required: true,
  },
  {
    name: "auth-service",
    url: process.env.AUTH_SERVICE_URL || "http://localhost:5600/health",
    livePath: "/health/live",
    readyPath: "/health/ready",
    port: 5600,
    profile: "default",
    required: true,
  },
  {
    name: "game-engine",
    url: process.env.GAME_ENGINE_URL || "http://localhost:5500/health",
    livePath: "/health/live",
    readyPath: "/health/ready",
    port: 5500,
    profile: "default",
    required: true,
  },
  {
    name: "settlement-service",
    url: process.env.SETTLEMENT_SERVICE_URL || "http://localhost:5400/health",
    livePath: "/health/live",
    readyPath: "/health/ready",
    port: 5400,
    profile: "default",
    required: true,
  },
  {
    name: "ledger-service",
    url: process.env.LEDGER_SERVICE_URL || "http://localhost:5200/health",
    livePath: "/health/live",
    readyPath: "/health/ready",
    port: 5200,
    profile: "default",
    required: true,
  },
  {
    name: "credit-wallet-service",
    url: process.env.CREDIT_SERVICE_URL || "http://localhost:5300/health",
    livePath: "/health/live",
    readyPath: "/health/ready",
    port: 5300,
    profile: "default",
    required: true,
  },
];
const infrastructure = [
  {
    name: "rabbitmq-management",
    kind: "http",
    url: process.env.RABBITMQ_MANAGEMENT_URL || "http://localhost:15672",
    port: 15672,
    profile: "default",
    service: "rabbitmq",
  },
  {
    name: "rabbitmq-broker",
    kind: "tcp",
    host: process.env.RABBITMQ_HOST || "localhost",
    port: Number(process.env.RABBITMQ_PORT || "5672"),
    profile: "default",
    service: "rabbitmq",
  },
  {
    name: "redis",
    kind: "tcp",
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || "6379"),
    profile: "default",
    service: "redis",
  },
  {
    name: "local-postgres",
    kind: "tcp",
    host: process.env.LOCAL_POSTGRES_HOST || (runningInContainer ? "local-postgres" : "localhost"),
    port: Number(process.env.LOCAL_POSTGRES_PORT || (runningInContainer ? "5432" : "55432")),
    profile: "devtools/local",
    service: "local-postgres",
  },
];

function withHealthPath(url) {
  return url.endsWith("/health") || url.endsWith("/ready") ? url : `${url.replace(/\/$/, "")}/health`;
}

function serviceBaseUrl(url) {
  return url
    .replace(/\/health\/ready$/, "")
    .replace(/\/health\/live$/, "")
    .replace(/\/health$/, "")
    .replace(/\/ready$/, "")
    .replace(/\/$/, "");
}

function withServicePath(endpoint, path) {
  return `${serviceBaseUrl(endpoint.url)}${path}`;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
  };
}

function runOptional(command, args) {
  try {
    return run(command, args);
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
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

function normalizeContainer(container) {
  return {
    name: container.Name ?? container.Names ?? container.name ?? null,
    service: container.Service ?? container.service ?? null,
    state: container.State ?? container.state ?? container.Status ?? null,
    health: container.Health ?? container.health ?? null,
  };
}

function isRunning(container) {
  return String(container?.state ?? "").toLowerCase().includes("running");
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

async function fetchJson(name, url) {
  try {
    const response = await fetch(url);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    return {
      name,
      url,
      ok: response.ok,
      httpStatus: response.status,
      body,
    };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      body: null,
    };
  }
}

function normalizeDependencyStatus(value) {
  if (typeof value === "string") {
    if (value === "ready" || value === "ok") return "READY";
    if (value === "not_configured") return "NOT_CONFIGURED";
    return "NOT_READY";
  }
  if (typeof value === "boolean") return value ? "READY" : "NOT_READY";
  if (value && typeof value === "object" && "ready" in value) return value.ready ? "READY" : "NOT_READY";
  if (value && typeof value === "object" && "Ready" in value) return value.Ready ? "READY" : "NOT_READY";

  return "NOT_READY";
}

function normalizeDependencies(body) {
  const dependencies = body?.dependencies;
  if (!dependencies || typeof dependencies !== "object") return [];

  return Object.entries(dependencies).map(([name, value]) => ({
    name,
    status: normalizeDependencyStatus(value),
    raw: value,
  }));
}

const authorityDomains = [
  {
    key: "settlement",
    domain: "SETTLEMENT",
    authorityEnv: "SETTLEMENT_AUTHORITY",
    serviceName: "settlement-service",
    serviceUrlEnv: "SETTLEMENT_SERVICE_URL",
    markerPrefix: "SETTLEMENT_SERVICE",
  },
  {
    key: "ledger",
    domain: "LEDGER",
    authorityEnv: "LEDGER_AUTHORITY",
    serviceName: "ledger-service",
    serviceUrlEnv: "LEDGER_SERVICE_URL",
    markerPrefix: "LEDGER_SERVICE",
  },
  {
    key: "credit",
    domain: "CREDIT",
    authorityEnv: "CREDIT_AUTHORITY",
    serviceName: "credit-wallet-service",
    serviceUrlEnv: "CREDIT_SERVICE_URL",
    markerPrefix: "CREDIT_SERVICE",
  },
];

function envEnabled(environment, name) {
  return String(environment?.[name] ?? "").trim().toUpperCase() === "ENABLED";
}

function envPresent(environment, name) {
  return String(environment?.[name] ?? "").trim().length > 0;
}

function getServiceEnvironment(serviceName) {
  return composeConfig?.services?.[serviceName]?.environment ?? {};
}

function normalizeCapabilities(body) {
  const capabilities = body?.capabilities ?? {};
  const mutationScope = String(capabilities.mutationCapabilityScope ?? "full").trim();
  const idempotencyScope = String(capabilities.idempotencySupportScope ?? "full").trim();

  return {
    mutationCapabilityEnabled:
      capabilities.mutationCapabilityEnabled === true &&
      (mutationScope === "" || mutationScope === "full" || mutationScope === "productionAuthority"),
    durablePersistenceConfigured: capabilities.durablePersistenceConfigured === true,
    idempotencySupportConfigured:
      capabilities.idempotencySupportConfigured === true &&
      (idempotencyScope === "" || idempotencyScope === "full" || idempotencyScope === "productionAuthority"),
    qaCapabilityMarkerPresent: String(capabilities.qaCapabilityMarker ?? "").trim().length > 0,
    raw: capabilities,
  };
}

function evaluateFinancialAuthorityGuardrails({ appEnvironment, serviceHealth, serviceReadiness }) {
  const domains = {};
  const blockers = [];
  const warnings = [];

  for (const domain of authorityDomains) {
    const targetServiceEnvironment = getServiceEnvironment(domain.serviceName);
    const authority =
      String(appEnvironment?.[domain.authorityEnv] ?? "MONOLITH").trim().toUpperCase() === "SERVICE"
        ? "SERVICE"
        : "MONOLITH";
    const readiness = serviceReadiness.find((item) => item.name === domain.serviceName);
    const serviceCapabilities = readiness?.capabilities ?? {};
    const capabilityEvidence = {
      serviceReachable: serviceHealth.find((item) => item.name === domain.serviceName)?.status === "UP",
      readinessHealthy: readiness?.status === "READY",
      mutationCapabilityEnabled:
        serviceCapabilities.mutationCapabilityEnabled === true ||
        envEnabled(targetServiceEnvironment, `${domain.markerPrefix}_MUTATION_CAPABILITY`) ||
        envEnabled(appEnvironment, `${domain.markerPrefix}_MUTATION_CAPABILITY`),
      durablePersistenceConfigured:
        serviceCapabilities.durablePersistenceConfigured === true ||
        envEnabled(targetServiceEnvironment, `${domain.markerPrefix}_DURABLE_PERSISTENCE`) ||
        envEnabled(appEnvironment, `${domain.markerPrefix}_DURABLE_PERSISTENCE`),
      idempotencySupportConfigured:
        serviceCapabilities.idempotencySupportConfigured === true ||
        envEnabled(targetServiceEnvironment, `${domain.markerPrefix}_IDEMPOTENCY_SUPPORT`) ||
        envEnabled(appEnvironment, `${domain.markerPrefix}_IDEMPOTENCY_SUPPORT`),
      qaCapabilityMarkerPresent:
        serviceCapabilities.qaCapabilityMarkerPresent === true ||
        envPresent(targetServiceEnvironment, `${domain.markerPrefix}_QA_CAPABILITY_MARKER`) ||
        envPresent(appEnvironment, `${domain.markerPrefix}_QA_CAPABILITY_MARKER`),
    };
    const domainBlockers = [];
    const domainWarnings = [];

    if (authority === "SERVICE") {
      if (!capabilityEvidence.serviceReachable) {
        domainBlockers.push(`${domain.domain} service is not reachable.`);
      }
      if (!capabilityEvidence.readinessHealthy) {
        domainBlockers.push(`${domain.domain} service readiness endpoint is not healthy.`);
      }
      if (!capabilityEvidence.mutationCapabilityEnabled) {
        domainBlockers.push(`${domain.domain} service mutation capability is not explicitly enabled.`);
      }
      if (!capabilityEvidence.durablePersistenceConfigured) {
        domainBlockers.push(`${domain.domain} service durable persistence is not configured.`);
      }
      if (!capabilityEvidence.idempotencySupportConfigured) {
        domainBlockers.push(`${domain.domain} service idempotency support is not configured.`);
      }
      if (!capabilityEvidence.qaCapabilityMarkerPresent) {
        domainBlockers.push(`${domain.domain} service QA capability marker is missing.`);
      }
    } else {
      domainWarnings.push(`${domain.domain} authority remains MONOLITH; service production mutation capability is not required.`);
    }

    const productionReady = authority === "SERVICE" && domainBlockers.length === 0;
    domains[domain.key] = {
      domain: domain.domain,
      authority,
      service: domain.serviceName,
      serviceUrl: appEnvironment?.[domain.serviceUrlEnv] ?? null,
      productionStatus:
        authority === "MONOLITH"
          ? "MONOLITH_ALLOWED"
          : productionReady
            ? "PRODUCTION_READY"
            : "NOT_PRODUCTION_READY",
      productionReady,
      allowedToRun: authority === "MONOLITH" || productionReady,
      failClosed: authority === "SERVICE" && !productionReady,
      capabilityEvidence,
      blockers: domainBlockers,
      warnings: domainWarnings,
    };
    blockers.push(...domainBlockers);
    warnings.push(...domainWarnings);
  }

  return {
    status: blockers.length === 0 ? "PASS" : "FAIL",
    productionReady: authorityDomains.every((domain) => domains[domain.key]?.productionReady),
    domains,
    blockers,
    warnings,
  };
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

const composeServicesResult = run("docker", [
  "compose",
  "--profile",
  "local",
  "--profile",
  "devtools",
  "config",
  "--services",
]);
const composeConfigResult = runOptional("docker", [
  "compose",
  "--profile",
  "local",
  "--profile",
  "devtools",
  "config",
  "--format",
  "json",
]);
const composeServices = composeServicesResult.ok
  ? composeServicesResult.stdout.split("\n").filter(Boolean).sort()
  : [];
let composeConfig = null;
try {
  composeConfig = composeConfigResult.ok ? JSON.parse(composeConfigResult.stdout) : null;
} catch {
  composeConfig = null;
}
const psResult = run("docker", ["compose", "ps", "--format", "json"]);
const dockerPsResult = run("docker", [
  "ps",
  "--format",
  "{{.Names}} {{.Label \"com.docker.compose.service\"}}",
]);
const runningContainers = parseComposePs(psResult.stdout);
const visibleRunningContainers =
  runningContainers.length > 0 ? runningContainers : parseDockerPsLabels(dockerPsResult.stdout);
const normalizedContainers = visibleRunningContainers.map(normalizeContainer);
const runningServiceNames = new Set(
  normalizedContainers.filter(isRunning).map((container) => container.service).filter(Boolean)
);

const serviceHealth = [];
const serviceReadiness = [];
const dependencyReadiness = [];
for (const endpoint of endpoints) {
  const url = endpoint.livePath ? withServicePath(endpoint, endpoint.livePath) : withHealthPath(endpoint.url);
  serviceHealth.push({
    ...(await checkHttp(endpoint.name, url)),
    service: endpoint.name,
    port: endpoint.port,
    profile: endpoint.profile,
    registered: composeServices.includes(endpoint.name),
    running: runningServiceNames.has(endpoint.name),
  });

  if (endpoint.readyPath) {
    const readiness = await fetchJson(endpoint.name, withServicePath(endpoint, endpoint.readyPath));
    const dependencies = normalizeDependencies(readiness.body);
    const capabilities = normalizeCapabilities(readiness.body);
    serviceReadiness.push({
      name: endpoint.name,
      url: readiness.url,
      status: readiness.ok ? "READY" : "NOT_READY",
      httpStatus: readiness.httpStatus,
      service: endpoint.name,
      port: endpoint.port,
      profile: endpoint.profile,
      registered: composeServices.includes(endpoint.name),
      running: runningServiceNames.has(endpoint.name),
      dependencies,
      capabilities,
      error: readiness.error,
    });

    for (const dependency of dependencies) {
      dependencyReadiness.push({
        service: endpoint.name,
        dependency: dependency.name,
        status: dependency.status,
        raw: dependency.raw,
      });
    }
  } else {
    serviceReadiness.push({
      name: endpoint.name,
      url: null,
      status: "NOT_CONFIGURED",
      service: endpoint.name,
      port: endpoint.port,
      profile: endpoint.profile,
      registered: composeServices.includes(endpoint.name),
      running: runningServiceNames.has(endpoint.name),
      dependencies: [],
    });
  }
}

const infrastructureHealth = [];
for (const dependency of infrastructure) {
  const health =
    dependency.kind === "http"
      ? await checkHttp(dependency.name, dependency.url)
      : await checkTcp(dependency.name, dependency.host, dependency.port);
  infrastructureHealth.push({
    ...health,
    service: dependency.service,
    port: dependency.port,
    profile: dependency.profile,
    registered: composeServices.includes(dependency.service),
    running: runningServiceNames.has(dependency.service),
  });
}

const gameEngineBaseUrl = (process.env.GAME_ENGINE_URL || "http://localhost:5500").replace(/\/health$/, "").replace(/\/$/, "");
const gameEngineStorageStatus = await fetchJson(
  "game-engine-evaluation-storage-status",
  `${gameEngineBaseUrl}/api/game-engine/evaluation-storage-status`
);
const storageStatus = gameEngineStorageStatus.body?.evaluationStorageStatus ?? null;
const gameEngineDatabaseUrl = composeConfig?.services?.["game-engine"]?.environment?.DATABASE_URL ?? "";
const creditWalletDatabaseUrl = composeConfig?.services?.["credit-wallet-service"]?.environment?.DATABASE_URL ?? "";
const appEnvironment = composeConfig?.services?.app?.environment ?? {};
const appDatabaseUrl = appEnvironment.DATABASE_URL ?? "";
const migrationValidationResult = runOptional("node", ["scripts/migrations/validate-local-migrations.mjs"]);
const financialAuthorityGuardrails = evaluateFinancialAuthorityGuardrails({
  appEnvironment,
  serviceHealth,
  serviceReadiness,
});

const expectedServices = [
  "app",
  "auth-service",
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
    runningContainers: normalizedContainers,
    missingServices,
    notRunning,
  },
  exposedPorts: {
    app: 3000,
    gameEngine: 5500,
    settlementService: 5400,
    ledgerService: 5200,
    creditWalletService: 5300,
    authService: 5600,
    rabbitmqBroker: 5672,
    rabbitmqManagement: 15672,
    redis: 6379,
    localPostgres: 55432,
  },
  serviceHealth: [...serviceHealth, ...infrastructureHealth],
  serviceReadiness,
  dependencyReadiness,
  durablePersistence: {
    gameEngineDatabaseUrlConfigured: gameEngineDatabaseUrl.length > 0,
    gameEngineDatabaseUrlHost: gameEngineDatabaseUrl.length > 0
      ? (() => {
          try {
            return new URL(gameEngineDatabaseUrl).hostname;
          } catch {
            return null;
          }
        })()
      : null,
    gameEngineStorageStatusReachable: gameEngineStorageStatus.ok,
    gameEngineDurablePersistenceModeActive: Boolean(storageStatus?.durableRepositoryWiringEnabled),
    creditWalletDatabaseUrlConfigured: creditWalletDatabaseUrl.length > 0,
    creditWalletDatabaseUrlHost: creditWalletDatabaseUrl.length > 0
      ? (() => {
          try {
            return new URL(creditWalletDatabaseUrl).hostname;
          } catch {
            return null;
          }
        })()
      : null,
    gameEngineStorageStatus: storageStatus,
    settlementDatabaseUrlConfigured: appDatabaseUrl.length > 0,
    settlementDatabaseUrlHost: appDatabaseUrl.length > 0
      ? (() => {
          try {
            return new URL(appDatabaseUrl).hostname;
          } catch {
            return null;
          }
        })()
      : null,
    settlementPersistenceSchemaCurrent: migrationValidationResult.ok,
    migrationsCurrent: migrationValidationResult.ok,
    migrationValidationStatus: migrationValidationResult.status,
    migrationValidationError: migrationValidationResult.ok ? null : migrationValidationResult.stderr || migrationValidationResult.stdout,
  },
  authProvider: {
    configuredProvider: appEnvironment.AUTH_PROVIDER ?? null,
    authServiceUrlConfigured: Boolean(appEnvironment.AUTH_SERVICE_URL),
    authServiceUrlHost: appEnvironment.AUTH_SERVICE_URL
      ? (() => {
          try {
            return new URL(appEnvironment.AUTH_SERVICE_URL).hostname;
          } catch {
            return null;
          }
        })()
      : null,
  },
  financialAuthorityGuardrails,
  expectedVsActual: expectedServices.map((service) => ({
    service,
    registered: composeServices.includes(service),
    running: runningServiceNames.has(service),
  })),
};

console.log(JSON.stringify(report, null, 2));
