import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const productionComposeFile = "docker-compose.production.yml";
const collectorConfigFile = "deploy/otel/collector.production.yaml";
const alertDefinitionsFile = "deploy/grafana-cloud/alerts.production.json";
const runbookFile = "docs/operations/production-observability-runbook.md";
const loggerFile = "src/lib/observability/logger.ts";
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

for (const file of [
  productionComposeFile,
  collectorConfigFile,
  alertDefinitionsFile,
  runbookFile,
  loggerFile,
  validator,
]) {
  assert(existsSync(file), `${file} is missing.`);
}

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

assert("otel-collector" in services, "Production compose must include otel-collector.", {
  serviceNames,
});
for (const forbidden of ["grafana", "prometheus"]) {
  assert(!(forbidden in services), `Production compose must not self-host ${forbidden}.`, {
    serviceNames,
  });
}

const collector = services["otel-collector"];
assert(String(collector.image ?? "").includes("otel/opentelemetry-collector-contrib"), "Collector must use OpenTelemetry contrib image.", {
  collector,
});
assert(JSON.stringify(collector.volumes ?? "").includes("collector.production.yaml"), "Collector must mount production config.", {
  volumes: collector.volumes,
});
assert((collector.environment ?? {}).OTEL_EXPORTER_OTLP_ENDPOINT, "Collector must receive Grafana Cloud OTLP endpoint.", {
  environment: collector.environment,
});
assert((collector.environment ?? {}).OTEL_EXPORTER_OTLP_HEADERS, "Collector must receive Grafana Cloud OTLP headers.", {
  environment: collector.environment,
});

const workloadNames = serviceNames.filter((name) => name !== "caddy" && name !== "otel-collector");
for (const name of workloadNames) {
  const environment = services[name]?.environment ?? {};
  assert(environment.SERVICE_NAME, `${name} must set SERVICE_NAME.`, { environment });
  assert(environment.OTEL_SERVICE_NAME === environment.SERVICE_NAME, `${name} must align OTEL_SERVICE_NAME with SERVICE_NAME.`, {
    environment,
  });
  assert(environment.OTEL_EXPORTER_OTLP_ENDPOINT === "http://otel-collector:4318", `${name} must export to the internal collector.`, {
    environment,
  });
  assert(environment.OTEL_EXPORTER_OTLP_PROTOCOL === "http/protobuf", `${name} must use OTLP HTTP/protobuf export.`, {
    environment,
  });
  assert(environment.OTEL_TRACES_EXPORTER === "otlp", `${name} must enable traces.`, { environment });
  assert(environment.OTEL_METRICS_EXPORTER === "otlp", `${name} must enable metrics.`, { environment });
  assert(environment.OTEL_LOGS_EXPORTER === "otlp", `${name} must enable logs.`, { environment });
  assert(String(environment.OTEL_RESOURCE_ATTRIBUTES ?? "").includes("deployment.environment=production"), `${name} must tag production environment.`, {
    environment,
  });
}

const collectorConfig = readFileSync(collectorConfigFile, "utf8");
for (const expected of [
  "receivers:",
  "otlp:",
  "traces:",
  "metrics:",
  "logs:",
  "otlphttp/grafana-cloud",
  "${env:OTEL_EXPORTER_OTLP_ENDPOINT}",
  "${env:OTEL_EXPORTER_OTLP_HEADERS}",
  "attributes/redact",
]) {
  assert(collectorConfig.includes(expected), `Collector config must include ${expected}.`);
}
for (const redactedKey of [
  "authorization",
  "cookie",
  "password",
  "token",
  "secret",
  "credential",
  "api_key",
  "email",
  "phone",
]) {
  assert(collectorConfig.includes(`key: ${redactedKey}`), `Collector redaction must remove ${redactedKey}.`);
}

const alerts = parseJson(readFileSync(alertDefinitionsFile, "utf8"), "Alert definitions");
const alertNames = new Set((alerts.alerts ?? []).map((alert) => alert.name));
for (const name of [
  "service_down",
  "readiness_failure",
  "queue_or_dlq_growth",
  "settlement_failure",
  "auth_failure_spike",
  "cashier_ledger_inconsistency",
]) {
  assert(alertNames.has(name), `Alert definition missing ${name}.`, { alertNames: [...alertNames].sort() });
}

const runbook = readFileSync(runbookFile, "utf8");
for (const heading of [
  "Service Down",
  "Readiness Failure",
  "Queue Or DLQ Growth",
  "Settlement Failure",
  "Auth Failure Spike",
  "Cashier Ledger Inconsistency",
]) {
  assert(runbook.includes(heading), `Runbook must include ${heading}.`);
}

const logger = readFileSync(loggerFile, "utf8");
for (const expected of ["SENSITIVE_KEY_PATTERN", "EMAIL_PATTERN", "REDACTED", "redactValue(input.metadata"]) {
  assert(logger.includes(expected), `Shared logger must include ${expected}.`);
}

const safeRuntimeEnv = {
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
  RABBITMQ_EXCHANGE_NAME: "lottery.events",
  RABBITMQ_MANAGEMENT_URL: "",
  RABBITMQ_MANAGEMENT_TOKEN_REF: "",
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

const safeRuntime = runValidator(safeRuntimeEnv);
assert(safeRuntime.ok, "Safe runtime observability environment must pass.", { result: safeRuntime });

const missingRuntimeOtel = runValidator({
  ...safeRuntimeEnv,
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
});
assert(!missingRuntimeOtel.ok, "Missing runtime OTEL endpoint must fail.", { result: missingRuntimeOtel });

const directGrafanaRuntime = runValidator({
  ...safeRuntimeEnv,
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway.grafana.net/otlp",
});
assert(!directGrafanaRuntime.ok, "Runtime must not export directly to Grafana Cloud.", {
  result: directGrafanaRuntime,
});

const safeCollector = runValidator({
  DEPLOYMENT_ENVIRONMENT: "production",
  RELEASE_VERSION: "sha-1234567890abcdef",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway.grafana.net/otlp",
  OTEL_EXPORTER_OTLP_HEADERS: "Basic StrongGrafanaCloudTelemetryCredential987",
}, "otel-collector");
assert(safeCollector.ok, "Safe collector Grafana Cloud environment must pass.", { result: safeCollector });

const missingCollectorHeader = runValidator({
  DEPLOYMENT_ENVIRONMENT: "production",
  RELEASE_VERSION: "sha-1234567890abcdef",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway.grafana.net/otlp",
}, "otel-collector");
assert(!missingCollectorHeader.ok, "Collector must require Grafana Cloud headers.", {
  result: missingCollectorHeader,
});

console.log(JSON.stringify({
  status: "PASS",
  checks: {
    collectorConfigValidates: "PASS",
    productionComposeIncludesCollector: "PASS",
    servicesHaveOtelEnv: "PASS",
    unsafeLogFieldsFlagged: "PASS",
    productionConfigRequiresObservabilityEnv: "PASS",
    noSelfHostedPrometheusGrafana: "PASS",
    alertDefinitionsPresent: "PASS",
  },
}, null, 2));
