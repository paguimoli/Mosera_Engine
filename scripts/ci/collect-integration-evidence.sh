#!/usr/bin/env bash
set -u

readonly EVIDENCE_DIR="${INTEGRATION_EVIDENCE_DIR:-${RUNNER_TEMP:-/tmp}/mosera-integration-evidence}"
readonly STATUS_DIR="${EVIDENCE_DIR}/status"

mkdir -p \
  "${EVIDENCE_DIR}/docker" \
  "${EVIDENCE_DIR}/endpoints" \
  "${EVIDENCE_DIR}/environment" \
  "${EVIDENCE_DIR}/infrastructure/postgresql" \
  "${EVIDENCE_DIR}/infrastructure/rabbitmq" \
  "${EVIDENCE_DIR}/infrastructure/redis" \
  "${EVIDENCE_DIR}/summary" \
  "${STATUS_DIR}"

capture_url() {
  local name=$1
  local url=$2
  local output="${EVIDENCE_DIR}/endpoints/${name}.txt"
  local status

  status=$(curl --silent --show-error \
    --connect-timeout 3 \
    --max-time 10 \
    --output "${output}.body" \
    --write-out "%{http_code}" \
    "${url}" 2>"${output}.stderr")
  local curl_exit=$?

  {
    printf 'url=%s\n' "${url}"
    printf 'curl_exit=%s\n' "${curl_exit}"
    printf 'http_status=%s\n' "${status:-000}"
    printf '%s\n' '--- body ---'
    cat "${output}.body" 2>/dev/null
    printf '\n%s\n' '--- stderr ---'
    cat "${output}.stderr" 2>/dev/null
  } >"${output}"

  rm -f "${output}.body" "${output}.stderr"
}

capture_url app-health "${APP_URL:-http://127.0.0.1:3000}/api/health"
capture_url auth-live "${AUTH_SERVICE_URL:-http://127.0.0.1:5600}/health/live"
capture_url auth-ready "${AUTH_SERVICE_URL:-http://127.0.0.1:5600}/health/ready"
capture_url game-engine-live "${GAME_ENGINE_URL:-http://127.0.0.1:5500}/health/live"
capture_url game-engine-ready "${GAME_ENGINE_URL:-http://127.0.0.1:5500}/health/ready"
capture_url ledger-live "${LEDGER_SERVICE_URL:-http://127.0.0.1:5200}/health/live"
capture_url ledger-ready "${LEDGER_SERVICE_URL:-http://127.0.0.1:5200}/health/ready"
capture_url credit-wallet-live "${CREDIT_SERVICE_URL:-http://127.0.0.1:5300}/health/live"
capture_url credit-wallet-ready "${CREDIT_SERVICE_URL:-http://127.0.0.1:5300}/health/ready"
capture_url settlement-live "${SETTLEMENT_SERVICE_URL:-http://127.0.0.1:5400}/health/live"
capture_url settlement-ready "${SETTLEMENT_SERVICE_URL:-http://127.0.0.1:5400}/health/ready"

{
  printf 'CI=%s\n' "${CI:-unset}"
  printf 'GITHUB_ACTIONS=%s\n' "${GITHUB_ACTIONS:-unset}"
  printf 'GITHUB_REPOSITORY=%s\n' "${GITHUB_REPOSITORY:-unset}"
  printf 'GITHUB_REF=%s\n' "${GITHUB_REF:-unset}"
  printf 'GITHUB_SHA=%s\n' "${GITHUB_SHA:-unset}"
  printf 'RUNNER_OS=%s\n' "${RUNNER_OS:-unset}"
  printf 'AUTH_PROVIDER=%s\n' "${AUTH_PROVIDER:-unset}"
  printf 'AUTH_AUTHORITY=%s\n' "${AUTH_AUTHORITY:-unset}"
  printf 'LEDGER_AUTHORITY=%s\n' "${LEDGER_AUTHORITY:-unset}"
  printf 'CREDIT_AUTHORITY=%s\n' "${CREDIT_AUTHORITY:-unset}"
  printf 'SETTLEMENT_AUTHORITY=%s\n' "${SETTLEMENT_AUTHORITY:-unset}"
  printf 'ALLOW_DISPOSABLE_DB_MIGRATIONS=%s\n' "${ALLOW_DISPOSABLE_DB_MIGRATIONS:-unset}"
  printf 'ASPNETCORE_ENVIRONMENT=%s\n' "${ASPNETCORE_ENVIRONMENT:-unset}"
  printf 'NODE_ENV=%s\n' "${NODE_ENV:-unset}"
} >"${EVIDENCE_DIR}/environment/non-secret-environment.txt"

node -e '
const names = [
  "DATABASE_URL", "RABBITMQ_URL", "REDIS_URL", "APP_URL", "AUTH_SERVICE_URL",
  "GAME_ENGINE_URL", "LEDGER_SERVICE_URL", "CREDIT_SERVICE_URL", "SETTLEMENT_SERVICE_URL"
];
for (const name of names) {
  const value = process.env[name];
  if (!value) {
    console.log(`${name}=unset`);
    continue;
  }
  try {
    const url = new URL(value);
    console.log(`${name}=${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`);
  } catch {
    console.log(`${name}=configured-unparseable`);
  }
}
' >"${EVIDENCE_DIR}/environment/sanitized-endpoints.txt" 2>&1

if command -v docker >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  node scripts/migrations/query-local-postgres.mjs -- -qAt -c \
    "select 'ready';" \
    >"${EVIDENCE_DIR}/infrastructure/postgresql/readiness.txt" 2>&1
  node scripts/migrations/query-local-postgres.mjs -- -c \
    "select version(), current_database(), current_user, now();" \
    >"${EVIDENCE_DIR}/infrastructure/postgresql/server.txt" 2>&1
  node scripts/migrations/query-local-postgres.mjs -- -c \
    "select migration_id, filename, status, applied_at, duration_ms, error_message
     from platform_migrations.migration_history
     order by applied_at, migration_id;" \
    >"${EVIDENCE_DIR}/infrastructure/postgresql/migration-history.txt" 2>&1
  node scripts/migrations/query-local-postgres.mjs -- -c \
    "select pid, usename, application_name, client_addr, state, wait_event_type, wait_event
     from pg_stat_activity
     where datname = current_database()
     order by pid;" \
    >"${EVIDENCE_DIR}/infrastructure/postgresql/activity.txt" 2>&1
fi

if [ -n "${RABBITMQ_MANAGEMENT_URL:-}" ]; then
  rabbit_auth=()
  if [ -n "${RABBITMQ_DIAGNOSTIC_USER:-}" ] && [ -n "${RABBITMQ_DIAGNOSTIC_PASSWORD:-}" ]; then
    rabbit_auth=(--user "${RABBITMQ_DIAGNOSTIC_USER}:${RABBITMQ_DIAGNOSTIC_PASSWORD}")
  fi
  curl --silent --show-error "${rabbit_auth[@]}" \
    "${RABBITMQ_MANAGEMENT_URL}/api/overview" \
    >"${EVIDENCE_DIR}/infrastructure/rabbitmq/overview.json" 2>&1
  curl --silent --show-error "${rabbit_auth[@]}" \
    "${RABBITMQ_MANAGEMENT_URL}/api/queues" \
    >"${EVIDENCE_DIR}/infrastructure/rabbitmq/queues.json" 2>&1
  curl --silent --show-error "${rabbit_auth[@]}" \
    "${RABBITMQ_MANAGEMENT_URL}/api/exchanges" \
    >"${EVIDENCE_DIR}/infrastructure/rabbitmq/exchanges.json" 2>&1
fi

docker ps -a --no-trunc >"${EVIDENCE_DIR}/docker/container-inventory.txt" 2>&1
while IFS= read -r container_id; do
  [ -n "${container_id}" ] || continue
  container_name=$(docker inspect --format '{{.Name}}' "${container_id}" 2>/dev/null | tr -cd '[:alnum:]_.-')
  container_name=${container_name#/}
  [ -n "${container_name}" ] || container_name="${container_id:0:12}"
  docker inspect "${container_id}" >"${EVIDENCE_DIR}/docker/${container_name}.inspect.json" 2>&1
  docker logs --timestamps "${container_id}" >"${EVIDENCE_DIR}/docker/${container_name}.log" 2>&1
done < <(docker ps -aq 2>/dev/null)

redis_container=$(docker ps -aq --filter ancestor=redis:7-alpine 2>/dev/null | head -n 1)
if [ -n "${redis_container}" ]; then
  docker exec "${redis_container}" redis-cli PING \
    >"${EVIDENCE_DIR}/infrastructure/redis/ping.txt" 2>&1
  docker exec "${redis_container}" redis-cli INFO server \
    >"${EVIDENCE_DIR}/infrastructure/redis/server-info.txt" 2>&1
fi

current_phase=$(cat "${STATUS_DIR}/current-phase.txt" 2>/dev/null || printf 'unknown')
canonical_status=$(cat "${STATUS_DIR}/canonical-integration-validation.status" 2>/dev/null || printf 'FAIL')
migration_status=$(cat "${STATUS_DIR}/migration-validation.status" 2>/dev/null || printf 'NOT_RUN')

failed_service="none identified"
case "${current_phase}" in
  readiness-*) failed_service=${current_phase#readiness-} ;;
  qa-auth-service-cutover) failed_service="Auth Service or Next.js auth integration" ;;
  qa-local-integrated-runtime) failed_service="integrated runtime; inspect endpoint table" ;;
  migration-*) failed_service="PostgreSQL migration layer" ;;
esac

recommended="Open qa/local-integrated-runtime.json and the failing service readiness response."
case "${current_phase}" in
  migration-*|qa-local-migrations) recommended="Start with migration/validation.json and infrastructure/postgresql/migration-history.txt." ;;
  readiness-*) recommended="Start with services/${failed_service}.log and endpoints/${failed_service}-ready.txt." ;;
  qa-auth-service-cutover) recommended="Start with qa/auth-service-cutover.json, services/auth-service.log, and services/app.log." ;;
esac

{
  printf '# Canonical Integration Validation\n\n'
  printf -- '- Result: **%s**\n' "${canonical_status}"
  printf -- '- Failed/current phase: `%s`\n' "${current_phase}"
  printf -- '- Service implicated: %s\n' "${failed_service}"
  printf -- '- Migration validation: **%s**\n' "${migration_status}"
  printf -- '- Recommended first investigation: %s\n\n' "${recommended}"
  printf '## Health and Readiness\n\n'
  printf '| Endpoint | HTTP status |\n'
  printf '| --- | --- |\n'
  for endpoint in "${EVIDENCE_DIR}"/endpoints/*.txt; do
    [ -f "${endpoint}" ] || continue
    status=$(sed -n 's/^http_status=//p' "${endpoint}" | head -n 1)
    printf '| `%s` | `%s` |\n' "$(basename "${endpoint}" .txt)" "${status:-000}"
  done
  printf '\nThe evidence artifact contains migration reports, QA JSON, service logs, dependency diagnostics, endpoint responses, sanitized environment metadata, and container logs.\n'
} >"${EVIDENCE_DIR}/summary/job-summary.md"

exit 0
