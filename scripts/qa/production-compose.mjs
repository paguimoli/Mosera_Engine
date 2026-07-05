import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const productionComposeFile = "docker-compose.production.yml";
const caddyFile = "deploy/caddy/Caddyfile";
const productionConfigValidator = "deploy/production/validate-production-config.sh";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_VERSION: "qa-production-compose",
      PRODUCTION_HOSTNAME: "qa.example.com",
    },
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
  };
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${label} was not valid JSON.`, {
      error: error instanceof Error ? error.message : String(error),
      value,
    });
  }
}

assert(existsSync(productionComposeFile), "Production compose file is missing.", {
  productionComposeFile,
});
assert(existsSync(caddyFile), "Caddyfile is missing.", { caddyFile });
assert(existsSync(productionConfigValidator), "Production config validator is missing.", {
  productionConfigValidator,
});

const configResult = run("docker", [
  "compose",
  "-f",
  productionComposeFile,
  "config",
  "--format",
  "json",
]);
assert(configResult.ok, "Production compose config failed.", {
  stdout: configResult.stdout,
  stderr: configResult.stderr,
  status: configResult.status,
});

const manualConfigResult = run("docker", [
  "compose",
  "-f",
  productionComposeFile,
  "--profile",
  "manual",
  "config",
  "--format",
  "json",
]);
assert(manualConfigResult.ok, "Production compose manual profile config failed.", {
  stdout: manualConfigResult.stdout,
  stderr: manualConfigResult.stderr,
  status: manualConfigResult.status,
});

const config = parseJson(configResult.stdout, "Production compose config");
const manualConfig = parseJson(manualConfigResult.stdout, "Production compose manual profile config");
const services = config.services ?? {};
const manualServices = manualConfig.services ?? {};
const serviceNames = Object.keys(services).sort();

const requiredServices = [
  "app",
  "auth-service",
  "game-engine",
  "ledger-service",
  "credit-wallet-service",
  "settlement-service",
  "outbox-dispatcher",
  "worker-critical-financial",
  "worker-ticket-lifecycle",
  "worker-settlement",
  "worker-accounting",
  "worker-commission",
  "worker-reconciliation",
  "worker-operational-access",
  "worker-reporting",
  "caddy",
  "otel-collector",
];

for (const service of requiredServices) {
  assert(serviceNames.includes(service), `${service} must be present in production compose.`, {
    serviceNames,
  });
}

assert("migration-runner" in manualServices, "migration-runner must be present only in the manual profile.", {
  manualServices: Object.keys(manualServices).sort(),
});
assert(!("migration-runner" in services), "migration-runner must not run in the default production stack.", {
  serviceNames,
});
assert(
  JSON.stringify(manualServices["migration-runner"]?.command ?? "").includes("validate-production-config.sh"),
  "manual migration-runner must validate production configuration before execution.",
  { command: manualServices["migration-runner"]?.command }
);
assert(
  JSON.stringify(manualServices["migration-runner"]?.command ?? "").includes("migrations:production:dry-run"),
  "manual migration-runner must use production migration governance dry-run.",
  { command: manualServices["migration-runner"]?.command }
);
assert(
  JSON.stringify(manualServices["migration-runner"]?.volumes ?? "").includes("validate-production-config.sh"),
  "manual migration-runner must mount the production config validator.",
  { volumes: manualServices["migration-runner"]?.volumes }
);

for (const forbidden of ["local-postgres", "postgres", "redis", "rabbitmq", "devtools", "dotnet-template-service", "grafana", "prometheus"]) {
  assert(!(forbidden in services), `${forbidden} must not be present in production compose.`, {
    serviceNames,
  });
}

for (const [name, service] of Object.entries(services)) {
  const ports = service.ports ?? [];
  if (name === "caddy") {
    const published = ports.map((port) => String(port.published)).sort();
    assert(published.includes("80") && published.includes("443"), "Caddy must expose only HTTP/HTTPS.", {
      ports,
    });
    continue;
  }

  assert(ports.length === 0, `${name} must not expose public ports.`, { ports });
}

assert(services.app?.healthcheck, "app must have a healthcheck.", {
  service: services.app,
});

for (const name of ["auth-service", "game-engine", "ledger-service", "credit-wallet-service", "settlement-service"]) {
  assert(services[name]?.healthcheck, `${name} must have a healthcheck.`, {
    service: services[name],
  });
}

const appEnvironment = services.app?.environment ?? {};
assert(appEnvironment.AUTH_PROVIDER === "auth-service", "Production app must use Auth Service provider.", {
  appEnvironment,
});
assert(appEnvironment.SECURITY_ENFORCE_PRODUCTION_SECRETS === "true", "Production secret enforcement must be enabled.", {
  appEnvironment,
});
for (const requiredManagedVariable of [
  "DATABASE_URL",
  "MIGRATIONS_DATABASE_URL",
  "DATABASE_SSL_MODE",
  "REDIS_URL",
  "REDIS_TLS",
  "RABBITMQ_URL",
  "MANAGED_POSTGRES_REQUIRED",
  "MANAGED_REDIS_REQUIRED",
  "MANAGED_RABBITMQ_REQUIRED",
  "MANAGED_DEPENDENCY_READINESS_REQUIRED",
]) {
  assert(
    requiredManagedVariable in appEnvironment,
    `Production app must include ${requiredManagedVariable} for managed service wiring.`,
    { appEnvironment }
  );
}

for (const [name, service] of Object.entries(services)) {
  if (name === "caddy" || name === "otel-collector") continue;
  const image = String(service.image ?? "");
  assert(image.includes("ghcr.io/"), "Production services must use GHCR image references.", {
    service,
    image,
  });
}

const composeText = readFileSync(productionComposeFile, "utf8");
for (const forbidden of ["=lottery_dev_password", "dummy-service-role-key", "dummy-anon-key"]) {
  assert(!composeText.includes(`${forbidden}`), "Production compose must not contain local placeholder credentials.", {
    forbidden,
  });
}

assert(composeText.includes("PRODUCTION_REQUIRED"), "Production compose must fail fast on missing required variables.");
assert(
  composeText.includes("validate-production-config.sh"),
  "Production compose must use the shared production config validator."
);
assert(
  composeText.includes("SECURITY_ENFORCE_PRODUCTION_SECRETS: \"true\""),
  "Production compose must enforce production secret validation."
);
assert(composeText.includes("condition: service_started"), "Production compose must define an internal dependency graph.");
for (const governanceVariable of [
  "PRODUCTION_MIGRATION_BACKUP_CHECKPOINT",
  "PRODUCTION_MIGRATION_STAGING_REHEARSAL_EVIDENCE",
  "PRODUCTION_MIGRATION_APPROVAL_TOKEN",
  "PRODUCTION_MIGRATION_APPROVED",
  "PRODUCTION_MIGRATION_DRIFT_CHECK",
  "PRODUCTION_MIGRATION_DRIFT_RESULT",
]) {
  assert(composeText.includes(governanceVariable), `Production compose must include ${governanceVariable}.`);
}

for (const observabilityVariable of [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_RESOURCE_ATTRIBUTES",
]) {
  assert(composeText.includes(observabilityVariable), `Production compose must include ${observabilityVariable}.`);
}

const otelCollector = services["otel-collector"] ?? {};
assert(
  String(otelCollector.image ?? "").includes("otel/opentelemetry-collector-contrib"),
  "Production compose must use the OpenTelemetry Collector contrib image.",
  { otelCollector }
);
assert(
  JSON.stringify(otelCollector.volumes ?? "").includes("collector.production.yaml"),
  "OpenTelemetry Collector must mount the production collector config.",
  { volumes: otelCollector.volumes }
);
assert(
  (otelCollector.environment ?? {}).OTEL_EXPORTER_OTLP_ENDPOINT,
  "OpenTelemetry Collector must receive the Grafana Cloud OTLP endpoint.",
  { environment: otelCollector.environment }
);
assert(
  (otelCollector.environment ?? {}).OTEL_EXPORTER_OTLP_HEADERS,
  "OpenTelemetry Collector must receive Grafana Cloud OTLP headers.",
  { environment: otelCollector.environment }
);

for (const [name, service] of Object.entries(services)) {
  if (name === "caddy" || name === "otel-collector") continue;
  const commandText = JSON.stringify(service.command ?? service.entrypoint ?? "");
  const volumesText = JSON.stringify(service.volumes ?? "");
  const environment = service.environment ?? {};
  assert(environment.OTEL_EXPORTER_OTLP_ENDPOINT === "http://otel-collector:4318", `${name} must export OTEL to the internal collector.`, {
    environment,
  });
  assert(environment.OTEL_TRACES_EXPORTER === "otlp", `${name} must enable OTEL trace export.`, { environment });
  assert(environment.OTEL_METRICS_EXPORTER === "otlp", `${name} must enable OTEL metric export.`, { environment });
  assert(environment.OTEL_LOGS_EXPORTER === "otlp", `${name} must enable OTEL log export.`, { environment });
  assert(environment.SERVICE_NAME, `${name} must define SERVICE_NAME for telemetry resource identity.`, { environment });
  assert(commandText.includes("validate-production-config.sh"), `${name} must run production config validation before startup.`, {
    command: service.command,
    entrypoint: service.entrypoint,
  });
  assert(volumesText.includes("validate-production-config.sh"), `${name} must mount the production config validator.`, {
    volumes: service.volumes,
  });
}

const caddyCommandText = JSON.stringify(services.caddy?.command ?? "");
const caddyVolumesText = JSON.stringify(services.caddy?.volumes ?? "");
assert(caddyCommandText.includes("validate-production-config.sh"), "Caddy must validate production hostname before startup.", {
  command: services.caddy?.command,
});
assert(caddyVolumesText.includes("validate-production-config.sh"), "Caddy must mount the production config validator.", {
  volumes: services.caddy?.volumes,
});

const caddyText = readFileSync(caddyFile, "utf8");
assert(caddyText.includes("reverse_proxy app:3000"), "Caddy must reverse proxy to the app container.");
assert(caddyText.includes("X-Forwarded-For"), "Caddy must forward X-Forwarded-For.");
assert(caddyText.includes("X-Forwarded-Proto"), "Caddy must forward X-Forwarded-Proto.");
assert(caddyText.includes("X-Request-ID"), "Caddy must forward X-Request-ID.");

console.log(JSON.stringify({
  status: "PASS",
  checks: {
    productionComposeConfig: "PASS",
    manualMigrationProfileConfig: "PASS",
    noLocalInfrastructureContainers: "PASS",
    caddyConfigured: "PASS",
    internalPortsNotPublished: "PASS",
    healthChecksConfigured: "PASS",
    productionFailFastEnvValidation: "PASS",
  },
  services: serviceNames,
}, null, 2));
