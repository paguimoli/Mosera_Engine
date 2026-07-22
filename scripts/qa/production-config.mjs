import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const validator = "deploy/production/validate-production-config.sh";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

function runValidator(env, role = "app") {
  const result = spawnSync("sh", [validator, role], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...env,
    },
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
  };
}

function runDockerCompose(args) {
  const result = spawnSync("docker", ["compose", ...args], {
    encoding: "utf8",
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
  };
}

const safeProductionEnvironment = {
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
  DATABASE_URL: "postgresql://prod_user:StrongProdCredential987@postgres.managed.vendor.net:5432/lottery_prod?sslmode=require",
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
  AUTH_AUTHORITY: "MONOLITH",
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
  CADDY_CLOUDFLARE_MODE: "origin",
};

assert(existsSync(validator), "Production config validator is missing.", { validator });
assert(existsSync(".env.production.example"), "Production env template is missing.");

const missingRequired = runValidator({});
assert(!missingRequired.ok, "Missing production environment must fail validation.", {
  result: missingRequired,
});

const unsafeProductionEnvironment = {
  ...safeProductionEnvironment,
  DATABASE_URL: "postgresql://postgres:lottery_dev_password@localhost:55432/lottery?sslmode=disable",
  REDIS_URL: "redis://localhost:6379/0",
  RABBITMQ_URL: "amqp://rabbitmq:5672",
  SECURITY_ENFORCE_PRODUCTION_SECRETS: "false",
  AUTH_SIGNING_KEY_REF: "replace-with-secret",
  APP_BASE_URL: "http://localhost:3000",
};
const unsafeResult = runValidator(unsafeProductionEnvironment);
assert(!unsafeResult.ok, "Unsafe production environment must fail validation.", {
  result: unsafeResult,
});

const monolithWithoutApproval = runValidator({
  ...safeProductionEnvironment,
  ALLOW_MONOLITH_AUTHORITY_IN_PRODUCTION: "false",
});
assert(!monolithWithoutApproval.ok, "MONOLITH authority must require an explicit production exception.", {
  result: monolithWithoutApproval,
});

const safeResult = runValidator(safeProductionEnvironment);
assert(safeResult.ok, "Safe synthetic production environment must pass validation.", {
  result: safeResult,
});

const missingObservability = runValidator({
  ...safeProductionEnvironment,
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
});
assert(!missingObservability.ok, "Production runtime must fail when observability export is missing.", {
  result: missingObservability,
});

const unsafeObservability = runValidator({
  ...safeProductionEnvironment,
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway.grafana.net/otlp",
});
assert(!unsafeObservability.ok, "Application runtime must export to the internal collector, not directly to Grafana Cloud.", {
  result: unsafeObservability,
});

const safeCollectorResult = runValidator({
  DEPLOYMENT_ENVIRONMENT: "production",
  RELEASE_VERSION: "sha-1234567890abcdef",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway.grafana.net/otlp",
  OTEL_EXPORTER_OTLP_HEADERS: "Basic StrongGrafanaCloudTelemetryCredential987",
}, "otel-collector");
assert(safeCollectorResult.ok, "OTEL collector Grafana Cloud configuration must pass validation.", {
  result: safeCollectorResult,
});

const missingCollectorHeaders = runValidator({
  DEPLOYMENT_ENVIRONMENT: "production",
  RELEASE_VERSION: "sha-1234567890abcdef",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway.grafana.net/otlp",
}, "otel-collector");
assert(!missingCollectorHeaders.ok, "OTEL collector must require Grafana Cloud authorization headers.", {
  result: missingCollectorHeaders,
});

const caddyUnsafeResult = runValidator({ PRODUCTION_HOSTNAME: "localhost" }, "caddy");
assert(!caddyUnsafeResult.ok, "Unsafe Caddy hostname must fail validation.", {
  result: caddyUnsafeResult,
});

const caddySafeResult = runValidator({ PRODUCTION_HOSTNAME: "app.lotteryplatform.com" }, "caddy");
assert(caddySafeResult.ok, "Safe Caddy hostname must pass validation.", {
  result: caddySafeResult,
});

const localComposeResult = runDockerCompose(["config", "--services"]);
assert(localComposeResult.ok, "Local compose config must remain valid.", {
  result: localComposeResult,
});

const localServices = localComposeResult.stdout.split("\n").filter(Boolean).sort();
for (const service of ["app", "rabbitmq", "redis", "local-postgres"]) {
  assert(localServices.includes(service), `Local compose must still include ${service}.`, {
    localServices,
  });
}
assert(!localServices.includes("caddy"), "Local compose must not gain the production Caddy proxy.", {
  localServices,
});

console.log(JSON.stringify({
  status: "PASS",
  checks: {
    missingRequiredEnvFails: "PASS",
    unsafeProductionEnvFails: "PASS",
    localAuthorityRequiresExplicitException: "PASS",
    safeSyntheticProductionEnvPasses: "PASS",
    observabilityEnvRequired: "PASS",
    otelCollectorValidation: "PASS",
    caddyHostnameValidation: "PASS",
    localComposeUnaffected: "PASS",
  },
}, null, 2));
