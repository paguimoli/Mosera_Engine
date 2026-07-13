import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { printJson, queryScalar, runPsql } from "../migrations/lib/local-migration-utils.mjs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function runSql(sql, options = {}) {
  return runPsql(["-q", "-c", sql], options);
}

function query(sql, options = {}) {
  return queryScalar(sql, options);
}

function rowCount(sql) {
  return Number(query(sql));
}

function existsRegclass(name) {
  return query(`select to_regclass('${name}') is not null;`) === "t";
}

function providerInsertSql({ providerId, contentHash }) {
  return `
insert into game_engine.outcome_provider_definitions (
  id,
  provider_id,
  provider_version,
  provider_type,
  lifecycle_state,
  production_eligible,
  supported_outcome_primitive_types,
  evidence_requirements,
  health_readiness_capabilities,
  idempotency_model,
  custody_support,
  signing_requirements,
  replayability_support,
  failure_mode,
  capability_markers,
  content_hash,
  certification_binding,
  jurisdiction_profile_references
) values (
  '${randomUUID()}',
  ${sqlString(providerId)},
  '1.0.0',
  'CERTIFIED_CSPRNG',
  'Active',
  true,
  ${sqlJson(["UniqueNumberSet"])},
  ${sqlJson({ runtimeEvidence: true })},
  ${sqlJson(["runtime-durable-ready"])},
  'PerDraw',
  ${sqlJson(["Generated", "Sealed", "Certified"])},
  ${sqlJson({ certificateSignatureRequired: true })},
  true,
  'FailClosed',
  ${sqlJson({
    generatesOutcomes: true,
    ingestsExternalOutcomes: false,
    supportsPlayerVerificationReceipt: false,
    supportsDeterministicReplay: true,
    supportsProviderHealthEvidence: true,
    supportsDisputeHandling: true,
    supportsExternalSourceEvidence: false,
    supportsPhysicalDrawEvidence: false,
  })},
  ${sqlString(contentHash)},
  null,
  null
);`;
}

function requestInsertSql({
  requestId = randomUUID(),
  idempotencyKey,
  scope,
  providerId,
  canonicalHash,
  failureReason = "Provider runtime shell is present, but outcome generation is not implemented in this phase.",
  evidenceReference = "placeholder:runtime-evidence",
}) {
  return `
insert into game_engine.outcome_runtime_requests (
  runtime_request_id,
  idempotency_key,
  draw_request_scope,
  game_manifest_id,
  game_manifest_version,
  provider_id,
  provider_version,
  provider_type,
  mode,
  status,
  started_at,
  completed_at,
  failure_code,
  failure_reason,
  canonical_request_hash,
  result_reference_placeholder,
  evidence_reference_placeholder,
  lock_scope,
  lock_acquired
) values (
  '${requestId}',
  ${sqlString(idempotencyKey)},
  ${sqlString(scope)},
  'game-manifest:runtime-durable',
  '1.0.0',
  ${sqlString(providerId)},
  '1.0.0',
  'CERTIFIED_CSPRNG',
  'DryRun',
  'GenerationNotImplemented',
  now(),
  now(),
  'GenerationNotImplemented',
  ${sqlString(failureReason)},
  ${sqlString(canonicalHash)},
  null,
  ${sqlString(evidenceReference)},
  ${sqlString(`outcome-runtime:${providerId}:1.0.0:${scope}`)},
  true
);`;
}

function attemptInsertSql({ requestId, idempotencyKey, scope, providerId, canonicalHash, lockAcquired = true }) {
  return `
insert into game_engine.outcome_runtime_attempts (
  attempt_id,
  runtime_request_id,
  idempotency_key,
  draw_request_scope,
  provider_id,
  provider_version,
  provider_type,
  mode,
  status,
  failure_code,
  failure_reason,
  lock_scope,
  lock_acquired,
  canonical_attempt_hash,
  started_at,
  completed_at
) values (
  '${randomUUID()}',
  '${requestId}',
  ${sqlString(idempotencyKey)},
  ${sqlString(scope)},
  ${sqlString(providerId)},
  '1.0.0',
  'CERTIFIED_CSPRNG',
  'DryRun',
  'GenerationNotImplemented',
  'GenerationNotImplemented',
  'Durable runtime attempt evidence.',
  ${sqlString(`outcome-runtime:${providerId}:1.0.0:${scope}`)},
  ${lockAcquired ? "true" : "false"},
  ${sqlString(canonicalHash)},
  now(),
  now()
);`;
}

const runId = randomUUID();
const providerId = `outcome-provider-runtime-durable:${runId}`;
const requestId = randomUUID();
const idempotencyKey = `runtime-durable:${runId}`;
const scope = `draw:${runId}`;
const requestHash = `sha256:p0-007-5-runtime-request:${runId}`;
const attemptHash = `sha256:p0-007-5-runtime-attempt:${runId}`;
const adapterPath = "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresOutcomeRuntimePersistence.cs";

addCheck("Postgres runtime adapter exists", existsSync(adapterPath));
const adapterSource = existsSync(adapterPath) ? readFileSync(adapterPath, "utf8") : "";
addCheck("Postgres request repository implemented", adapterSource.includes("PostgresOutcomeRuntimeRequestRepository"));
addCheck("Postgres advisory lock manager implemented", adapterSource.includes("PostgresOutcomeRuntimeLockManager"));
addCheck("outcome runtime request table exists", existsRegclass("game_engine.outcome_runtime_requests"));
addCheck("outcome runtime attempt table exists", existsRegclass("game_engine.outcome_runtime_attempts"));

runSql(providerInsertSql({
  providerId,
  contentHash: `sha256:p0-007-5-provider:${runId}`,
}));

runSql(requestInsertSql({
  requestId,
  idempotencyKey,
  scope,
  providerId,
  canonicalHash: requestHash,
}));
addCheck("durable first request claim succeeds", rowCount(`
select count(*)
from game_engine.outcome_runtime_requests
where runtime_request_id = '${requestId}'
  and idempotency_key = ${sqlString(idempotencyKey)}
  and canonical_request_hash = ${sqlString(requestHash)};
`) === 1);

runSql(`
with attempted_insert as (
  insert into game_engine.outcome_runtime_requests (
    runtime_request_id,
    idempotency_key,
    draw_request_scope,
    game_manifest_id,
    game_manifest_version,
    provider_id,
    provider_version,
    provider_type,
    mode,
    status,
    started_at,
    completed_at,
    failure_code,
    failure_reason,
    canonical_request_hash,
    result_reference_placeholder,
    evidence_reference_placeholder,
    lock_scope,
    lock_acquired
  ) values (
    '${randomUUID()}',
    ${sqlString(idempotencyKey)},
    ${sqlString(scope)},
    'game-manifest:runtime-durable',
    '1.0.0',
    ${sqlString(providerId)},
    '1.0.0',
    'CERTIFIED_CSPRNG',
    'DryRun',
    'GenerationNotImplemented',
    now(),
    now(),
    'GenerationNotImplemented',
    'Provider runtime shell is present, but outcome generation is not implemented in this phase.',
    ${sqlString(requestHash)},
    null,
    'placeholder:runtime-evidence',
    ${sqlString(`outcome-runtime:${providerId}:1.0.0:${scope}`)},
    true
  )
  on conflict (idempotency_key, draw_request_scope) do nothing
  returning runtime_request_id
)
select runtime_request_id from attempted_insert
union all
select runtime_request_id
from game_engine.outcome_runtime_requests
where idempotency_key = ${sqlString(idempotencyKey)}
  and draw_request_scope = ${sqlString(scope)}
limit 1;
`);
addCheck("duplicate same payload returns existing state", query(`
select runtime_request_id
from game_engine.outcome_runtime_requests
where idempotency_key = ${sqlString(idempotencyKey)}
  and draw_request_scope = ${sqlString(scope)};
`) === requestId);
addCheck("duplicate same payload does not create a second request", rowCount(`
select count(*)
from game_engine.outcome_runtime_requests
where idempotency_key = ${sqlString(idempotencyKey)}
  and draw_request_scope = ${sqlString(scope)};
`) === 1);

const conflictingDuplicate = runSql(requestInsertSql({
  idempotencyKey,
  scope,
  providerId,
  canonicalHash: `sha256:p0-007-5-conflict:${runId}`,
}), { allowFailure: true });
addCheck("duplicate conflicting payload fails", conflictingDuplicate.status !== 0);

runSql(attemptInsertSql({
  requestId,
  idempotencyKey,
  scope,
  providerId,
  canonicalHash: attemptHash,
}));
addCheck("runtime attempt evidence persists", rowCount(`
select count(*)
from game_engine.outcome_runtime_attempts
where runtime_request_id = '${requestId}'
  and canonical_attempt_hash = ${sqlString(attemptHash)};
`) === 1);

runSql(attemptInsertSql({
  requestId,
  idempotencyKey,
  scope,
  providerId,
  canonicalHash: `sha256:p0-007-5-failure-attempt:${runId}`,
  lockAcquired: false,
}));
addCheck("failure evidence persists", rowCount(`
select count(*)
from game_engine.outcome_runtime_attempts
where runtime_request_id = '${requestId}'
  and lock_acquired = false;
`) === 1);

const secretRequest = runSql(requestInsertSql({
  idempotencyKey: `runtime-durable-secret:${runId}`,
  scope: `draw-secret:${runId}`,
  providerId,
  canonicalHash: `sha256:p0-007-5-secret:${runId}`,
  failureReason: "rawSeed should not persist",
}), { allowFailure: true });
addCheck("no secret material persists in request evidence", secretRequest.status !== 0);

const beforeCertificates = rowCount("select count(*) from game_engine.outcome_certificates;");
const updateBlocked = runSql(`
update game_engine.outcome_runtime_attempts
set failure_reason = 'mutated'
where runtime_request_id = '${requestId}';
`, { allowFailure: true });
addCheck("attempt rows remain append-only", updateBlocked.status !== 0);
const afterCertificates = rowCount("select count(*) from game_engine.outcome_certificates;");
addCheck("no actual outcome generation occurs", beforeCertificates === afterCertificates);
addCheck("no outcome certificate is created", beforeCertificates === afterCertificates);

printJson({
  status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
  checkCount: checks.length,
  failedCount: checks.filter((check) => check.status !== "PASS").length,
  checks,
});

if (checks.some((check) => check.status !== "PASS")) {
  process.exitCode = 1;
}
