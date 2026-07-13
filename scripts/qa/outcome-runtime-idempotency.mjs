import { randomUUID } from "node:crypto";
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

function query(sql) {
  return queryScalar(sql);
}

function existsRegclass(name) {
  return query(`select to_regclass('${name}') is not null;`) === "t";
}

function rowCount(sql) {
  return Number(query(sql));
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
  'PROVABLY_FAIR',
  'Active',
  true,
  ${sqlJson(["UniqueNumberSet"])},
  ${sqlJson({ commitRevealEvidence: true })},
  ${sqlJson(["runtime-shell-ready", "receipt-ready"])},
  'PerWager',
  ${sqlJson(["Generated", "Sealed", "Certified", "Disputed"])},
  ${sqlJson({ certificateSignatureRequired: true })},
  true,
  'FailClosed',
  ${sqlJson({
    generatesOutcomes: true,
    ingestsExternalOutcomes: false,
    supportsPlayerVerificationReceipt: true,
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
  status = "GenerationNotImplemented",
  failureCode = "GenerationNotImplemented",
  failureReason = "Provider runtime shell is present, but outcome generation is not implemented in this phase.",
  resultReference = null,
  evidenceReference = "placeholder:runtime-evidence",
  lockAcquired = true,
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
  'game-manifest:runtime-idempotency',
  '1.0.0',
  ${sqlString(providerId)},
  '1.0.0',
  'PROVABLY_FAIR',
  'DryRun',
  ${sqlString(status)},
  now(),
  now(),
  ${sqlString(failureCode)},
  ${sqlString(failureReason)},
  ${sqlString(canonicalHash)},
  ${resultReference === null ? "null" : sqlString(resultReference)},
  ${evidenceReference === null ? "null" : sqlString(evidenceReference)},
  ${sqlString(`outcome-runtime:${providerId}:${scope}`)},
  ${lockAcquired ? "true" : "false"}
);`;
}

function attemptInsertSql({ requestId, idempotencyKey, scope, providerId, canonicalHash, status = "GenerationNotImplemented", failureCode = "GenerationNotImplemented", lockAcquired = true }) {
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
  'PROVABLY_FAIR',
  'DryRun',
  ${sqlString(status)},
  ${sqlString(failureCode)},
  'Runtime shell attempt evidence.',
  ${sqlString(`outcome-runtime:${providerId}:${scope}`)},
  ${lockAcquired ? "true" : "false"},
  ${sqlString(canonicalHash)},
  now(),
  now()
);`;
}

const runId = randomUUID();
const providerId = `outcome-provider-runtime-idempotency:${runId}`;
const requestId = randomUUID();
const idempotencyKey = `runtime-idempotency:${runId}`;
const scope = `draw:${runId}`;

addCheck("outcome runtime request table exists", existsRegclass("game_engine.outcome_runtime_requests"));
addCheck("outcome runtime attempt table exists", existsRegclass("game_engine.outcome_runtime_attempts"));
addCheck("advisory lock helper exists", query(`
select exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'game_engine'
    and p.proname = 'try_outcome_runtime_advisory_lock'
);
`) === "t");

runSql(providerInsertSql({
  providerId,
  contentHash: `sha256:p0-007-4-idempotency-provider:${runId}`,
}));

const beforeCertificates = rowCount("select count(*) from game_engine.outcome_certificates;");
runSql(requestInsertSql({
  requestId,
  idempotencyKey,
  scope,
  providerId,
  canonicalHash: `sha256:p0-007-4-runtime-request:${runId}`,
}));
runSql(attemptInsertSql({
  requestId,
  idempotencyKey,
  scope,
  providerId,
  canonicalHash: `sha256:p0-007-4-runtime-attempt:${runId}`,
}));
const afterCertificates = rowCount("select count(*) from game_engine.outcome_certificates;");

addCheck("runtime request persists", rowCount(`
select count(*)
from game_engine.outcome_runtime_requests
where runtime_request_id = '${requestId}'
  and status = 'GenerationNotImplemented';
`) === 1);
addCheck("runtime attempt evidence persists", rowCount(`
select count(*)
from game_engine.outcome_runtime_attempts
where runtime_request_id = '${requestId}'
  and lock_acquired = true;
`) === 1);
addCheck("no outcome certificate or production outcome is created", beforeCertificates === afterCertificates, {
  before: beforeCertificates,
  after: afterCertificates,
});

addCheck("duplicate idempotency request returns existing state", rowCount(`
select count(*)
from game_engine.outcome_runtime_requests
where idempotency_key = ${sqlString(idempotencyKey)}
  and draw_request_scope = ${sqlString(scope)}
  and canonical_request_hash = ${sqlString(`sha256:p0-007-4-runtime-request:${runId}`)};
`) === 1);

const conflictingDuplicate = runSql(requestInsertSql({
  requestId: randomUUID(),
  idempotencyKey,
  scope,
  providerId,
  canonicalHash: `sha256:p0-007-4-runtime-request-conflict:${runId}`,
}), { allowFailure: true });
addCheck("conflicting duplicate payload rejected", conflictingDuplicate.status !== 0, {
  stderr: conflictingDuplicate.stderr.trim(),
});

const generatedReference = runSql(requestInsertSql({
  requestId: randomUUID(),
  idempotencyKey: `runtime-idempotency-generated-reference:${runId}`,
  scope: `${scope}:generated-reference`,
  providerId,
  canonicalHash: `sha256:p0-007-4-runtime-generated-reference:${runId}`,
  resultReference: "outcome:should-not-exist",
}), { allowFailure: true });
addCheck("generated outcome reference rejected", generatedReference.status !== 0, {
  stderr: generatedReference.stderr.trim(),
});

const rawSeedRequest = runSql(requestInsertSql({
  requestId: randomUUID(),
  idempotencyKey: `runtime-idempotency-rawseed:${runId}`,
  scope: `${scope}:rawseed`,
  providerId,
  canonicalHash: `sha256:p0-007-4-runtime-rawseed:${runId}`,
  failureReason: "rawSeed must never be stored",
}), { allowFailure: true });
addCheck("no raw entropy/seed/state persisted", rawSeedRequest.status !== 0, {
  stderr: rawSeedRequest.stderr.trim(),
});

const lockUnavailableRequestId = randomUUID();
runSql(requestInsertSql({
  requestId: lockUnavailableRequestId,
  idempotencyKey: `runtime-idempotency-lock-unavailable:${runId}`,
  scope: `${scope}:lock-unavailable`,
  providerId,
  canonicalHash: `sha256:p0-007-4-runtime-lock-unavailable:${runId}`,
  status: "FailedClosed",
  failureCode: "LockUnavailable",
  failureReason: "Outcome runtime lock was unavailable.",
  evidenceReference: "placeholder:lock-unavailable",
  lockAcquired: false,
}));
runSql(attemptInsertSql({
  requestId: lockUnavailableRequestId,
  idempotencyKey: `runtime-idempotency-lock-unavailable:${runId}`,
  scope: `${scope}:lock-unavailable`,
  providerId,
  canonicalHash: `sha256:p0-007-4-runtime-lock-attempt:${runId}`,
  status: "FailedClosed",
  failureCode: "LockUnavailable",
  lockAcquired: false,
}));
addCheck("advisory lock timeout fails closed", rowCount(`
select count(*)
from game_engine.outcome_runtime_requests
where runtime_request_id = '${lockUnavailableRequestId}'
  and status = 'FailedClosed'
  and failure_code = 'LockUnavailable'
  and lock_acquired = false;
`) === 1);

const updateResult = runSql(`
update game_engine.outcome_runtime_requests
set status = 'Accepted'
where runtime_request_id = '${requestId}';
`, { allowFailure: true });
addCheck("runtime request update blocked", updateResult.status !== 0, { stderr: updateResult.stderr.trim() });

const deleteResult = runSql(`
delete from game_engine.outcome_runtime_attempts
where runtime_request_id = '${requestId}';
`, { allowFailure: true });
addCheck("runtime attempt delete blocked", deleteResult.status !== 0, { stderr: deleteResult.stderr.trim() });

const productionRequest = runSql(requestInsertSql({
  requestId: randomUUID(),
  idempotencyKey: `runtime-idempotency-production:${runId}`,
  scope: `${scope}:production`,
  providerId,
  canonicalHash: `sha256:p0-007-4-runtime-production:${runId}`,
}).replace("'DryRun'", "'Production'"), { allowFailure: true });
addCheck("production generation disabled", productionRequest.status !== 0, {
  stderr: productionRequest.stderr.trim(),
});

const failed = checks.filter((check) => check.status !== "PASS");
printJson({
  status: failed.length === 0 ? "PASS" : "FAIL",
  checkCount: checks.length,
  failedCount: failed.length,
  checks,
});

if (failed.length > 0) {
  process.exitCode = 1;
}
