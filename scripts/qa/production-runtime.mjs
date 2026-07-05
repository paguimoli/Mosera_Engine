import { spawnSync } from "node:child_process";

const productionComposeFile = "docker-compose.production.yml";
const validator = "deploy/production/validate-production-config.sh";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env ?? {}),
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

function runValidator(env, role = "app") {
  return run("sh", [validator, role], { env: { PATH: process.env.PATH, ...env } });
}

const safeRuntimeEnvironment = {
  DEPLOYMENT_ENVIRONMENT: "production",
  NODE_ENV: "production",
  RELEASE_VERSION: "sha-1234567890abcdef",
  SERVICE_NAME: "app",
  OTEL_SERVICE_NAME: "app",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=production,service.version=sha-1234567890abcdef",
  DATABASE_URL: "postgresql://runtime_user:StrongRuntimeCredential987@postgres.managed.vendor.net:5432/lottery_prod?sslmode=require",
  MIGRATIONS_DATABASE_URL: "postgresql://migration_user:StrongMigrationCredential987@postgres.managed.vendor.net:5432/lottery_prod?sslmode=require",
  DATABASE_SSL_MODE: "require",
  REDIS_URL: "rediss://:StrongRedisCredential987@redis.managed.vendor.net:6380/0",
  REDIS_TLS: "true",
  RABBITMQ_URL: "amqps://prod_mq_user:StrongMqCredential987@rabbitmq.managed.vendor.net/lottery_prod",
  RABBITMQ_MANAGEMENT_URL: "https://rabbitmq.managed.vendor.net/api",
  RABBITMQ_MANAGEMENT_TOKEN_REF: "infisical://production/rabbitmq/management-token",
  RABBITMQ_EXCHANGE_NAME: "lottery.events",
  MANAGED_POSTGRES_REQUIRED: "true",
  MANAGED_REDIS_REQUIRED: "true",
  MANAGED_RABBITMQ_REQUIRED: "true",
  MANAGED_DEPENDENCY_READINESS_REQUIRED: "true",
  SUPABASE_URL: "https://supabase.lotteryplatform.com",
  SUPABASE_SERVICE_ROLE_KEY: "sr_live_lotteryplatform_StrongCredential987",
  SUPABASE_ANON_KEY: "anon_live_lotteryplatform_StrongCredential987",
  AUTH_PROVIDER: "auth-service",
  AUTH_SERVICE_URL: "http://auth-service:8080",
  APP_BASE_URL: "https://app.lotteryplatform.com",
  PUBLIC_APP_URL: "https://app.lotteryplatform.com",
  PRODUCTION_HOSTNAME: "app.lotteryplatform.com",
  SECURITY_ENFORCE_PRODUCTION_SECRETS: "true",
  AUTH_SIGNING_KEY_REF: "infisical://production/auth/signing-key",
  AUTH_REFRESH_TOKEN_SECRET_REF: "infisical://production/auth/refresh-token",
  AUTH_SESSION_SECRET_REF: "infisical://production/auth/session",
  AUTH_SERVICE_TOKEN_SIGNING_KEY_REF: "infisical://production/auth/service-token-signing-key",
  LEDGER_AUTHORITY: "MONOLITH",
  CREDIT_AUTHORITY: "MONOLITH",
  SETTLEMENT_AUTHORITY: "MONOLITH",
  ALLOW_MONOLITH_AUTHORITY_IN_PRODUCTION: "true",
};

const smokeResult = runValidator(safeRuntimeEnvironment, "app");
assert(smokeResult.ok, "Production smoke config must validate.", { result: smokeResult });

const collectorResult = runValidator({
  DEPLOYMENT_ENVIRONMENT: "production",
  RELEASE_VERSION: "sha-1234567890abcdef",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway.grafana.net/otlp",
  OTEL_EXPORTER_OTLP_HEADERS: "Basic StrongGrafanaCloudTelemetryCredential987",
}, "otel-collector");
assert(collectorResult.ok, "Production OTEL collector config must validate.", {
  result: collectorResult,
});

const configResult = run("docker", [
  "compose",
  "-f",
  productionComposeFile,
  "config",
  "--format",
  "json",
]);
assert(configResult.ok, "Production compose config must render.", { result: configResult });
const config = parseJson(configResult.stdout, "Production compose config");
const services = config.services ?? {};
const serviceNames = Object.keys(services).sort();

for (const required of [
  "app",
  "auth-service",
  "game-engine",
  "ledger-service",
  "credit-wallet-service",
  "settlement-service",
  "otel-collector",
]) {
  assert(required in services, `${required} must be registered in production compose.`, {
    serviceNames,
  });
}

const appHealthcheck = JSON.stringify(services.app?.healthcheck ?? {});
assert(appHealthcheck.includes("/api/health"), "Production app healthcheck must probe /api/health.", {
  healthcheck: services.app?.healthcheck,
});

for (const serviceName of [
  "auth-service",
  "game-engine",
  "ledger-service",
  "credit-wallet-service",
  "settlement-service",
]) {
  const healthcheck = JSON.stringify(services[serviceName]?.healthcheck ?? {});
  assert(healthcheck.includes("/health/ready"), `${serviceName} must probe /health/ready.`, {
    healthcheck: services[serviceName]?.healthcheck,
  });
}

const appEnv = services.app?.environment ?? {};
assert(appEnv.MANAGED_POSTGRES_REQUIRED === "true", "Managed Postgres must be expected.");
assert(appEnv.MANAGED_REDIS_REQUIRED === "true", "Managed Redis must be expected.");
assert(appEnv.MANAGED_RABBITMQ_REQUIRED === "true", "Managed RabbitMQ must be expected.");
assert(appEnv.MANAGED_DEPENDENCY_READINESS_REQUIRED === "true", "Managed dependency readiness must be required.");
assert(appEnv.OTEL_EXPORTER_OTLP_ENDPOINT === "http://otel-collector:4318", "App must export OTEL to collector.");
assert("otel-collector" in (services.app?.depends_on ?? {}), "App must depend on the OTEL collector.", {
  dependsOn: services.app?.depends_on,
});

for (const forbidden of ["local-postgres", "postgres", "redis", "rabbitmq", "devtools"]) {
  assert(!(forbidden in services), `Production runtime must not include local infrastructure ${forbidden}.`, {
    serviceNames,
  });
}

const localConfig = run("docker", ["compose", "config", "--services"]);
assert(localConfig.ok, "Local compose config must remain valid.", { result: localConfig });
const localServices = localConfig.stdout.split("\n").filter(Boolean);
for (const service of ["app", "local-postgres", "redis", "rabbitmq"]) {
  assert(localServices.includes(service), `Local runtime must remain unaffected and include ${service}.`, {
    localServices,
  });
}

console.log(JSON.stringify({
  status: "PASS",
  checks: {
    productionSmokeConfigValidates: "PASS",
    appHealthConfigured: "PASS",
    serviceReadinessConfigured: "PASS",
    managedPostgresExpected: "PASS",
    managedRedisExpected: "PASS",
    managedRabbitMqExpected: "PASS",
    observabilityConfigured: "PASS",
    localRuntimeUnaffected: "PASS",
  },
}, null, 2));
