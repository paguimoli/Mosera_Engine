#!/usr/bin/env bash
set -Eeuo pipefail

readonly EVIDENCE_DIR="${INTEGRATION_EVIDENCE_DIR:-${RUNNER_TEMP:-/tmp}/mosera-integration-evidence}"
readonly SERVICE_LOG_DIR="${EVIDENCE_DIR}/services"
readonly STATUS_DIR="${EVIDENCE_DIR}/status"
declare -a PIDS=()

mkdir -p \
  "${EVIDENCE_DIR}/migration" \
  "${EVIDENCE_DIR}/qa" \
  "${SERVICE_LOG_DIR}" \
  "${STATUS_DIR}"

set_phase() {
  printf '%s\n' "$1" >"${STATUS_DIR}/current-phase.txt"
}

set_status() {
  local name=$1
  local status=$2
  printf '%s\n' "${status}" >"${STATUS_DIR}/${name}.status"
}

run_with_evidence() {
  local phase=$1
  local output_file=$2
  shift 2

  set_phase "${phase}"
  set_status "${phase}" "RUNNING"

  if "$@" > >(tee "${output_file}") 2> >(tee "${output_file%.json}.stderr.log" >&2); then
    set_status "${phase}" "PASS"
    return 0
  fi

  set_status "${phase}" "FAIL"
  return 1
}

cleanup() {
  local exit_code=$?

  for pid in "${PIDS[@]:-}"; do
    kill "${pid}" 2>/dev/null || true
  done

  if [ "${exit_code}" -eq 0 ]; then
    set_phase "complete"
    set_status "canonical-integration-validation" "PASS"
  else
    set_status "canonical-integration-validation" "FAIL"
    echo "Canonical integration validation failed during $(cat "${STATUS_DIR}/current-phase.txt" 2>/dev/null || echo unknown)." >&2
  fi

  exit "${exit_code}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

set_phase "environment-validation"

required_env=(
  DATABASE_URL
  ALLOW_DISPOSABLE_DB_MIGRATIONS
  RABBITMQ_URL
  REDIS_URL
  APP_URL
  AUTH_SERVICE_URL
  GAME_ENGINE_URL
  LEDGER_SERVICE_URL
  CREDIT_SERVICE_URL
  SETTLEMENT_SERVICE_URL
)

for name in "${required_env[@]}"; do
  if [ -z "${!name:-}" ]; then
    echo "${name} is required for CI integration validation." >&2
    exit 1
  fi
done

if [ "${CI:-}" != "true" ] || [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  echo "Canonical integration validation may only run inside GitHub Actions." >&2
  exit 1
fi

if [ "${ALLOW_DISPOSABLE_DB_MIGRATIONS}" != "true" ]; then
  echo "Disposable migration approval must be explicit inside the CI job." >&2
  exit 1
fi

if [ "${AUTH_AUTHORITY:-MONOLITH}" != "MONOLITH" ]; then
  echo "AUTH_AUTHORITY must remain MONOLITH during integration validation." >&2
  exit 1
fi

set_status "environment-validation" "PASS"

run_with_evidence \
  "migration-apply" \
  "${EVIDENCE_DIR}/migration/apply.json" \
  env NODE_ENV=test npm --silent run migrations:local:run

run_with_evidence \
  "migration-validation" \
  "${EVIDENCE_DIR}/migration/validation.json" \
  env NODE_ENV=test npm --silent run migrations:local:validate

run_with_evidence \
  "qa-local-migrations" \
  "${EVIDENCE_DIR}/qa/local-migrations.json" \
  env NODE_ENV=test npm --silent run qa:local-migrations

run_with_evidence \
  "qa-launch-configuration-freeze" \
  "${EVIDENCE_DIR}/qa/launch-configuration-freeze.json" \
  npm --silent run qa:launch-configuration-freeze

set_phase "migration-076-verification"
if node scripts/migrations/query-local-postgres.mjs -- -A -t -c \
  "select json_build_object(
    'migrationId', '076_add_authentication_authority_consolidation',
    'historyApplied', exists (
      select 1
      from platform_migrations.migration_history
      where migration_id = '076_add_authentication_authority_consolidation'
        and status = 'APPLIED'
    ),
    'identityProfiles', to_regclass('auth_service.identity_profiles') is not null,
    'passwordCredentialVersions', to_regclass('auth_service.password_credential_versions') is not null,
    'canonicalSessions', to_regclass('auth_service.canonical_sessions') is not null,
    'authenticationAuditEvidence', to_regclass('auth_service.authentication_audit_evidence') is not null
  );" >"${EVIDENCE_DIR}/migration/migration-076-verification.json" &&
  node -e '
    const fs = require("node:fs");
    const evidence = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const checks = [
      "historyApplied",
      "identityProfiles",
      "passwordCredentialVersions",
      "canonicalSessions",
      "authenticationAuditEvidence"
    ];
    if (!checks.every((name) => evidence[name] === true)) process.exit(1);
  ' "${EVIDENCE_DIR}/migration/migration-076-verification.json"; then
  set_status "migration-076-verification" "PASS"
else
  set_status "migration-076-verification" "FAIL"
  exit 1
fi

start_process() {
  local name=$1
  shift

  "$@" >"${SERVICE_LOG_DIR}/${name}.log" 2>&1 &
  PIDS+=("$!")
}

wait_for_url() {
  local name=$1
  local url=$2
  local attempts=${3:-90}

  set_phase "readiness-${name}"
  set_status "readiness-${name}" "RUNNING"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl --fail --silent --show-error "${url}" >"${EVIDENCE_DIR}/qa/${name}-readiness.json"; then
      echo "${name} ready: ${url}"
      set_status "readiness-${name}" "PASS"
      return 0
    fi
    sleep 2
  done

  set_status "readiness-${name}" "FAIL"
  echo "${name} did not become ready: ${url}" >&2
  return 1
}

set_phase "runtime-start"

start_process auth-service \
  env ASPNETCORE_URLS=http://127.0.0.1:5600 \
  dotnet run --project services/auth-service/src/AuthService.Api/AuthService.Api.csproj \
    --configuration Release --no-build

start_process game-engine \
  env ASPNETCORE_URLS=http://127.0.0.1:5500 \
  dotnet run --project services/game-engine/src/GameEngine.Api/GameEngine.Api.csproj \
    --configuration Release --no-build

start_process ledger-service \
  env ASPNETCORE_URLS=http://127.0.0.1:5200 \
  dotnet run --project services/ledger-service/LedgerService.csproj \
    --configuration Release --no-build

start_process credit-wallet-service \
  env ASPNETCORE_URLS=http://127.0.0.1:5300 \
  dotnet run --project services/credit-wallet-service/CreditWalletService.csproj \
    --configuration Release --no-build

start_process settlement-service \
  env ASPNETCORE_URLS=http://127.0.0.1:5400 \
  dotnet run --project services/settlement-service/SettlementService.csproj \
    --configuration Release --no-build

wait_for_url auth-service "${AUTH_SERVICE_URL}/health/ready"
wait_for_url game-engine "${GAME_ENGINE_URL}/health/ready"
wait_for_url ledger-service "${LEDGER_SERVICE_URL}/health/ready"
wait_for_url credit-wallet-service "${CREDIT_SERVICE_URL}/health/ready"
wait_for_url settlement-service "${SETTLEMENT_SERVICE_URL}/health/ready"

start_process app npm run start
wait_for_url app "${APP_URL}/api/health"

run_with_evidence \
  "qa-auth-service-cutover" \
  "${EVIDENCE_DIR}/qa/auth-service-cutover.json" \
  npm --silent run qa:auth-service-cutover

run_with_evidence \
  "qa-local-integrated-runtime" \
  "${EVIDENCE_DIR}/qa/local-integrated-runtime.json" \
  npm --silent run qa:local-integrated-runtime
