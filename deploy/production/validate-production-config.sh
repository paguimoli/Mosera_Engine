#!/bin/sh
set -eu

role="${1:-service}"
failures=""

fail() {
  failures="${failures}
- $1"
}

value_of() {
  eval "printf '%s' \"\${$1:-}\""
}

require_var() {
  name="$1"
  value="$(value_of "$name")"
  if [ -z "$value" ]; then
    fail "$name is required."
  fi
}

reject_unsafe_value() {
  name="$1"
  value="$(value_of "$name")"
  lowered="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"

  case "$lowered" in
    ""|*__production_required_*|*production-required*|*placeholder*|*replace-with*|*changeme*|*dummy*|*sample*|*example*|*your-*|*lottery_dev_password*)
      fail "$name contains a placeholder or unsafe value."
      ;;
  esac

  case "$lowered" in
    *localhost*|*127.0.0.1*|*0.0.0.0*|*::1*|*local-postgres*|*redis:6379*|*rabbitmq:5672*)
      fail "$name points at a local development endpoint."
      ;;
  esac
}

require_safe_var() {
  require_var "$1"
  reject_unsafe_value "$1"
}

require_https_url() {
  name="$1"
  require_safe_var "$name"
  value="$(value_of "$name")"
  case "$value" in
    https://*) ;;
    *) fail "$name must use https:// in production." ;;
  esac
}

require_database_url() {
  name="$1"
  require_safe_var "$name"
  value="$(value_of "$name")"
  case "$value" in
    postgres://*|postgresql://*) ;;
    *) fail "$name must be a postgres/postgresql connection string." ;;
  esac

  case "$value" in
    *@*) ;;
    *) fail "$name must include managed PostgreSQL credentials." ;;
  esac

  lowered="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    *sslmode=disable*) fail "$name must not disable TLS." ;;
  esac

  case "$lowered|$(printf '%s' "${DATABASE_SSL_MODE:-}" | tr '[:upper:]' '[:lower:]')" in
    *sslmode=require*|*sslmode=verify-full*|*sslmode=verify-ca*|*'|require'|*'|verify-full'|*'|verify-ca') ;;
    *) fail "$name must require TLS, or DATABASE_SSL_MODE must be require/verify-full/verify-ca." ;;
  esac
}

require_redis_url() {
  require_safe_var REDIS_URL
  case "$REDIS_URL" in
    rediss://*) ;;
    *) fail "REDIS_URL must use rediss:// in production." ;;
  esac
  case "$REDIS_URL" in
    *@*) ;;
    *) fail "REDIS_URL must include managed Redis authentication credentials." ;;
  esac
  case "${REDIS_TLS:-}" in
    true|TRUE) ;;
    *) fail "REDIS_TLS must be true in production." ;;
  esac
}

require_rabbitmq_url() {
  require_safe_var RABBITMQ_URL
  case "$RABBITMQ_URL" in
    amqps://*) ;;
    *) fail "RABBITMQ_URL must use amqps:// in production." ;;
  esac
  case "$RABBITMQ_URL" in
    *@*) ;;
    *) fail "RABBITMQ_URL must include CloudAMQP credentials." ;;
  esac
}

require_secret_reference() {
  name="$1"
  require_safe_var "$name"
  value="$(value_of "$name")"
  case "$value" in
    infisical://*|doppler://*|vault://*|aws-secretsmanager://*|gcp-secretmanager://*|azure-keyvault://*) ;;
    *) fail "$name must be a secret-manager reference, not an inline secret." ;;
  esac
}

require_authority_safe() {
  name="$1"
  value="$(printf '%s' "$(value_of "$name")" | tr '[:lower:]' '[:upper:]')"
  [ -n "$value" ] || value="MONOLITH"

  case "$value" in
    SERVICE) ;;
    MONOLITH)
      if [ "${ALLOW_MONOLITH_AUTHORITY_IN_PRODUCTION:-false}" != "true" ]; then
        fail "$name=MONOLITH is blocked in production unless ALLOW_MONOLITH_AUTHORITY_IN_PRODUCTION=true is set deliberately."
      fi
      ;;
    *) fail "$name must be MONOLITH or SERVICE." ;;
  esac
}

require_optional_safe_url() {
  name="$1"
  value="$(value_of "$name")"
  if [ -n "$value" ]; then
    reject_unsafe_value "$name"
    case "$value" in
      https://*) ;;
      *) fail "$name must use https:// when configured." ;;
    esac
  fi
}

require_internal_otel_endpoint() {
  require_var OTEL_EXPORTER_OTLP_ENDPOINT
  value="$(value_of OTEL_EXPORTER_OTLP_ENDPOINT)"
  case "$value" in
    http://otel-collector:4318|http://otel-collector:4317) ;;
    *) fail "OTEL_EXPORTER_OTLP_ENDPOINT must point at the internal otel-collector for app/service/worker telemetry." ;;
  esac
}

require_otel_runtime() {
  require_internal_otel_endpoint
  require_safe_var SERVICE_NAME
  require_safe_var RELEASE_VERSION

  if [ -n "${OTEL_SERVICE_NAME:-}" ] && [ "$OTEL_SERVICE_NAME" != "$SERVICE_NAME" ]; then
    fail "OTEL_SERVICE_NAME must match SERVICE_NAME."
  fi

  case "${OTEL_EXPORTER_OTLP_PROTOCOL:-}" in
    http/protobuf|grpc) ;;
    *) fail "OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf or grpc." ;;
  esac

  for exporter_name in OTEL_TRACES_EXPORTER OTEL_METRICS_EXPORTER OTEL_LOGS_EXPORTER; do
    value="$(value_of "$exporter_name")"
    if [ "$value" != "otlp" ]; then
      fail "$exporter_name must be otlp."
    fi
  done

  case "${OTEL_RESOURCE_ATTRIBUTES:-}" in
    *deployment.environment=production*service.version=*) ;;
    *) fail "OTEL_RESOURCE_ATTRIBUTES must include deployment.environment=production and service.version." ;;
  esac
}

require_otel_collector() {
  require_safe_var DEPLOYMENT_ENVIRONMENT
  if [ "$DEPLOYMENT_ENVIRONMENT" != "production" ]; then
    fail "DEPLOYMENT_ENVIRONMENT must be production."
  fi

  require_safe_var RELEASE_VERSION
  require_https_url OTEL_EXPORTER_OTLP_ENDPOINT
  require_safe_var OTEL_EXPORTER_OTLP_HEADERS

  case "$OTEL_EXPORTER_OTLP_ENDPOINT" in
    *grafana.net*|*grafana.com*) ;;
    *) fail "OTEL_EXPORTER_OTLP_ENDPOINT must point at Grafana Cloud for the collector." ;;
  esac
}

validate_caddy() {
  require_safe_var PRODUCTION_HOSTNAME
  value="$(printf '%s' "$PRODUCTION_HOSTNAME" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    *.*) ;;
    *) fail "PRODUCTION_HOSTNAME must be a fully qualified production hostname." ;;
  esac
}

validate_runtime() {
  require_safe_var DEPLOYMENT_ENVIRONMENT
  if [ "$DEPLOYMENT_ENVIRONMENT" != "production" ]; then
    fail "DEPLOYMENT_ENVIRONMENT must be production."
  fi

  if [ "${SECURITY_ENFORCE_PRODUCTION_SECRETS:-}" != "true" ]; then
    fail "SECURITY_ENFORCE_PRODUCTION_SECRETS must be true."
  fi

  if [ "${MANAGED_POSTGRES_REQUIRED:-}" != "true" ]; then
    fail "MANAGED_POSTGRES_REQUIRED must be true."
  fi
  if [ "${MANAGED_REDIS_REQUIRED:-}" != "true" ]; then
    fail "MANAGED_REDIS_REQUIRED must be true."
  fi
  if [ "${MANAGED_RABBITMQ_REQUIRED:-}" != "true" ]; then
    fail "MANAGED_RABBITMQ_REQUIRED must be true."
  fi
  if [ "${MANAGED_DEPENDENCY_READINESS_REQUIRED:-}" != "true" ]; then
    fail "MANAGED_DEPENDENCY_READINESS_REQUIRED must be true."
  fi

  require_database_url DATABASE_URL
  require_database_url MIGRATIONS_DATABASE_URL
  if [ "$DATABASE_URL" = "$MIGRATIONS_DATABASE_URL" ]; then
    fail "MIGRATIONS_DATABASE_URL must be a separate production variable from DATABASE_URL."
  fi
  require_redis_url
  require_rabbitmq_url
  require_https_url APP_BASE_URL
  require_https_url PUBLIC_APP_URL
  require_safe_var PRODUCTION_HOSTNAME
  validate_caddy

  require_secret_reference AUTH_SIGNING_KEY_REF
  require_secret_reference AUTH_REFRESH_TOKEN_SECRET_REF
  require_secret_reference AUTH_SESSION_SECRET_REF
  require_secret_reference AUTH_SERVICE_TOKEN_SIGNING_KEY_REF

  if [ "${AUTH_PROVIDER:-}" != "auth-service" ]; then
    fail "AUTH_PROVIDER must be auth-service in production."
  fi
  require_var AUTH_SERVICE_URL
  reject_unsafe_value AUTH_SERVICE_URL

  require_authority_safe LEDGER_AUTHORITY
  require_authority_safe CREDIT_AUTHORITY
  require_authority_safe SETTLEMENT_AUTHORITY

  require_otel_runtime
  require_optional_safe_url RABBITMQ_MANAGEMENT_URL
  if [ -n "${RABBITMQ_MANAGEMENT_TOKEN_REF:-}" ]; then
    require_secret_reference RABBITMQ_MANAGEMENT_TOKEN_REF
  fi
  if [ -n "${GRAFANA_CLOUD_API_KEY:-}" ]; then
    reject_unsafe_value GRAFANA_CLOUD_API_KEY
  fi
}

case "$role" in
  caddy)
    validate_caddy
    ;;
  otel-collector)
    require_otel_collector
    ;;
  app|worker|auth-service|game-engine|ledger-service|credit-wallet-service|settlement-service|migration-runner|service)
    validate_runtime
    ;;
  *)
    fail "Unknown production config validation role: $role."
    ;;
esac

if [ -n "$failures" ]; then
  printf 'Production configuration validation failed for %s:%s\n' "$role" "$failures" >&2
  exit 1
fi

printf 'Production configuration validation passed for %s.\n' "$role"
