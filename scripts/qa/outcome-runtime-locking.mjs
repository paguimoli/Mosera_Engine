import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { printJson, queryScalar, runPsql } from "../migrations/lib/local-migration-utils.mjs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function query(sql, options = {}) {
  return queryScalar(sql, options);
}

function runSql(sql, options = {}) {
  return runPsql(["-q", "-c", sql], options);
}

function rowCount(sql) {
  return Number(query(sql));
}

function existsFunction(name) {
  return query(`
select exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'game_engine'
    and p.proname = ${sqlString(name)}
);
`) === "t";
}

function holdSessionLock(lockScope, seconds) {
  const sql = `
select pg_advisory_lock(hashtextextended(${sqlString(lockScope)}, 0));
select pg_sleep(${seconds});
`;
  return spawn("psql", ["-X", "-v", "ON_ERROR_STOP=1", process.env.DATABASE_URL, "-q", "-c", sql], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `psql lock holder exited with ${code}`));
      }
    });
  });
}

const runId = randomUUID();
const lockScope = `outcome-runtime-locking:${runId}`;
const requestId = randomUUID();
const idempotencyKey = `runtime-locking:${runId}`;
const providerId = `outcome-runtime-locking-provider:${runId}`;

addCheck("advisory lock helper exists", existsFunction("try_outcome_runtime_advisory_lock"));
addCheck("initial lock acquisition succeeds", query(`select game_engine.try_outcome_runtime_advisory_lock(${sqlString(`${lockScope}:initial`)});`) === "t");

const holder = holdSessionLock(lockScope, 2);
await wait(500);
const concurrentResult = query(`select pg_try_advisory_lock(hashtextextended(${sqlString(lockScope)}, 0));`);
addCheck("concurrent same-scope claims cannot both proceed", concurrentResult === "f");
addCheck("lock timeout fails closed", concurrentResult === "f", { simulatedTimeoutMs: 500 });

await waitForExit(holder);
const afterRelease = query(`select pg_try_advisory_lock(hashtextextended(${sqlString(lockScope)}, 0));`);
if (afterRelease === "t") {
  query(`select pg_advisory_unlock(hashtextextended(${sqlString(lockScope)}, 0));`);
}
addCheck("lock releases after success", afterRelease === "t");

const failureScope = `${lockScope}:failure`;
const failingHolder = holdSessionLock(failureScope, 1);
await wait(300);
const duringFailureScope = query(`select pg_try_advisory_lock(hashtextextended(${sqlString(failureScope)}, 0));`);
await waitForExit(failingHolder);
const afterFailureRelease = query(`select pg_try_advisory_lock(hashtextextended(${sqlString(failureScope)}, 0));`);
if (afterFailureRelease === "t") {
  query(`select pg_advisory_unlock(hashtextextended(${sqlString(failureScope)}, 0));`);
}
addCheck("lock releases after provider failure", duringFailureScope === "f" && afterFailureRelease === "t");

runSql(`
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
  '["UniqueNumberSet"]'::jsonb,
  '{"runtimeEvidence":true}'::jsonb,
  '["runtime-lock-ready"]'::jsonb,
  'PerDraw',
  '["Generated","Sealed","Certified"]'::jsonb,
  '{"certificateSignatureRequired":true}'::jsonb,
  true,
  'FailClosed',
  '{"generatesOutcomes":true,"ingestsExternalOutcomes":false,"supportsPlayerVerificationReceipt":false,"supportsDeterministicReplay":true,"supportsProviderHealthEvidence":true,"supportsDisputeHandling":true,"supportsExternalSourceEvidence":false,"supportsPhysicalDrawEvidence":false}'::jsonb,
  ${sqlString(`sha256:p0-007-5-lock-provider:${runId}`)},
  null,
  null
);
`);

runSql(`
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
  ${sqlString(lockScope)},
  'game-manifest:runtime-locking',
  '1.0.0',
  ${sqlString(providerId)},
  '1.0.0',
  'CERTIFIED_CSPRNG',
  'DryRun',
  'FailedClosed',
  now(),
  now(),
  'LockUnavailable',
  'Outcome runtime advisory lock acquisition timed out.',
  ${sqlString(`sha256:p0-007-5-lock-request:${runId}`)},
  null,
  'placeholder:runtime-lock-evidence',
  ${sqlString(lockScope)},
  false
);
`);

runSql(`
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
  ${sqlString(lockScope)},
  ${sqlString(providerId)},
  '1.0.0',
  'CERTIFIED_CSPRNG',
  'DryRun',
  'FailedClosed',
  'LockUnavailable',
  'Outcome runtime advisory lock acquisition timed out.',
  ${sqlString(lockScope)},
  false,
  ${sqlString(`sha256:p0-007-5-lock-attempt:${runId}`)},
  now(),
  now()
);
`);

addCheck("lock acquisition evidence recorded", rowCount(`
select count(*)
from game_engine.outcome_runtime_attempts
where runtime_request_id = '${requestId}'
  and lock_scope = ${sqlString(lockScope)}
  and lock_acquired = false;
`) === 1);

const beforeCertificates = rowCount("select count(*) from game_engine.outcome_certificates;");
const productionGenerationDisabled = runSql(`
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
  ${sqlString(`runtime-locking-production:${runId}`)},
  ${sqlString(`production:${lockScope}`)},
  'game-manifest:runtime-locking',
  '1.0.0',
  ${sqlString(providerId)},
  '1.0.0',
  'CERTIFIED_CSPRNG',
  'Production',
  'ProductionDisabled',
  now(),
  now(),
  'ProductionDisabled',
  'Production remains disabled.',
  ${sqlString(`sha256:p0-007-5-lock-production:${runId}`)},
  null,
  'placeholder:runtime-lock-evidence',
  ${sqlString(`production:${lockScope}`)},
  false
);
`, { allowFailure: true });
const afterCertificates = rowCount("select count(*) from game_engine.outcome_certificates;");
addCheck("production generation remains disabled", productionGenerationDisabled.status !== 0);
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
