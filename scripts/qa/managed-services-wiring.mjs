import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

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

function runValidator(env, role = "app") {
  return run("sh", [validator, role], { env: { PATH: process.env.PATH, ...env } });
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

const safeManagedEnvironment = {
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
  NEXT_PUBLIC_SUPABASE_URL: "https://supabase.lotteryplatform.com",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk_live_lotteryplatform_StrongPublishable987",
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

assert(existsSync(productionComposeFile), "Production compose file is missing.", {
  productionComposeFile,
});
assert(existsSync(validator), "Production config validator is missing.", { validator });

const safeResult = runValidator(safeManagedEnvironment);
assert(safeResult.ok, "Synthetic managed production environment must pass validation.", {
  result: safeResult,
});

const localManagedUrls = runValidator({
  ...safeManagedEnvironment,
  DATABASE_URL: "postgresql://runtime_user:StrongRuntimeCredential987@localhost:5432/lottery_prod?sslmode=require",
  MIGRATIONS_DATABASE_URL: "postgresql://migration_user:StrongMigrationCredential987@local-postgres:5432/lottery_prod?sslmode=require",
  REDIS_URL: "rediss://:StrongRedisCredential987@localhost:6380/0",
  RABBITMQ_URL: "amqps://prod_mq_user:StrongMqCredential987@rabbitmq:5672/lottery_prod",
});
assert(!localManagedUrls.ok, "Localhost/local managed service URLs must fail validation.", {
  result: localManagedUrls,
});

const missingTlsPosture = runValidator({
  ...safeManagedEnvironment,
  DATABASE_URL: "postgresql://runtime_user:StrongRuntimeCredential987@postgres.managed.vendor.net:5432/lottery_prod?sslmode=disable",
  MIGRATIONS_DATABASE_URL: "postgresql://migration_user:StrongMigrationCredential987@postgres.managed.vendor.net:5432/lottery_prod",
  DATABASE_SSL_MODE: "disable",
  REDIS_URL: "redis://:StrongRedisCredential987@redis.managed.vendor.net:6379/0",
  REDIS_TLS: "false",
  RABBITMQ_URL: "amqp://prod_mq_user:StrongMqCredential987@rabbitmq.managed.vendor.net/lottery_prod",
});
assert(!missingTlsPosture.ok, "Missing managed TLS posture must fail validation.", {
  result: missingTlsPosture,
});

const missingMigrationUrl = runValidator({
  ...safeManagedEnvironment,
  MIGRATIONS_DATABASE_URL: "",
});
assert(!missingMigrationUrl.ok, "MIGRATIONS_DATABASE_URL must be required separately.", {
  result: missingMigrationUrl,
});

const sharedMigrationUrl = runValidator({
  ...safeManagedEnvironment,
  MIGRATIONS_DATABASE_URL: safeManagedEnvironment.DATABASE_URL,
});
assert(!sharedMigrationUrl.ok, "Runtime and migration database variables must be separate values.", {
  result: sharedMigrationUrl,
});

const configResult = run("docker", [
  "compose",
  "-f",
  productionComposeFile,
  "config",
  "--format",
  "json",
]);
assert(configResult.ok, "Production compose config must be valid.", {
  result: configResult,
});

const config = parseJson(configResult.stdout, "Production compose config");
const services = config.services ?? {};
const serviceNames = Object.keys(services).sort();

for (const forbidden of ["local-postgres", "postgres", "redis", "rabbitmq", "devtools"]) {
  assert(!(forbidden in services), `${forbidden} must not be present in production compose.`, {
    serviceNames,
  });
}
assert("otel-collector" in services, "Production compose must include the OpenTelemetry collector.", {
  serviceNames,
});

const appEnvironment = services.app?.environment ?? {};
for (const name of [
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
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
]) {
  assert(name in appEnvironment, `Production app environment must include ${name}.`, {
    appEnvironment,
  });
}

for (const [name, service] of Object.entries(services)) {
  if (name === "caddy" || name === "otel-collector") continue;
  const commandText = JSON.stringify(service.command ?? service.entrypoint ?? "");
  const environment = service.environment ?? {};
  assert(commandText.includes("validate-production-config.sh"), `${name} must run production config validation.`, {
    command: service.command,
    entrypoint: service.entrypoint,
  });
  assert(
    environment.MANAGED_DEPENDENCY_READINESS_REQUIRED === "true",
    `${name} must require managed dependency readiness.`,
    { environment }
  );
}

for (const name of ["auth-service", "game-engine", "ledger-service", "credit-wallet-service", "settlement-service"]) {
  const healthcheckText = JSON.stringify(services[name]?.healthcheck ?? {});
  assert(healthcheckText.includes("/health/ready"), `${name} must wire readiness command through /health/ready.`, {
    healthcheck: services[name]?.healthcheck,
  });
}

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
assert(manualConfigResult.ok, "Production manual profile compose config must be valid.", {
  result: manualConfigResult,
});
const manualConfig = parseJson(manualConfigResult.stdout, "Production manual profile compose config");
const migrationRunnerEnvironment = manualConfig.services?.["migration-runner"]?.environment ?? {};
assert(
  "MIGRATIONS_DATABASE_URL" in migrationRunnerEnvironment,
  "Production migration-runner must receive MIGRATIONS_DATABASE_URL.",
  { migrationRunnerEnvironment }
);

console.log(JSON.stringify({
  status: "PASS",
  checks: {
    syntheticManagedEnvPasses: "PASS",
    localManagedUrlsFail: "PASS",
    missingTlsPostureFails: "PASS",
    separateMigrationDatabaseUrlRequired: "PASS",
    noLocalInfrastructureContainers: "PASS",
    managedReadinessCommandsWired: "PASS",
  },
}, null, 2));
