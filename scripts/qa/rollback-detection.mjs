import { createHash, randomUUID } from "node:crypto";
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

function hash(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function runSql(sql, options = {}) {
  return runPsql(["-q", "-c", sql], options);
}

function scalar(sql) {
  return queryScalar(sql);
}

function existsFunction(name) {
  return scalar(`
select exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'game_engine'
    and p.proname = ${sqlString(name)}
);
`) === "t";
}

const runId = randomUUID();
const providerId = `rollback-provider:${runId}`;
const requestId = randomUUID();
const bootId = randomUUID();

addCheck("rollback detection function exists", existsFunction("detect_outcome_runtime_rollback"));

runSql(`
insert into game_engine.outcome_provider_definitions (
  id, provider_id, provider_version, provider_type, lifecycle_state, production_eligible,
  supported_outcome_primitive_types, evidence_requirements, health_readiness_capabilities,
  idempotency_model, custody_support, signing_requirements, replayability_support,
  failure_mode, capability_markers, content_hash, certification_binding, jurisdiction_profile_references
) values (
  '${randomUUID()}', ${sqlString(providerId)}, '1.0.0', 'CERTIFIED_CSPRNG', 'Active', true,
  ${sqlJson(["UniqueNumberSet"])}, ${sqlJson({ runtimeEvidence: true })}, ${sqlJson(["rollback-ready"])},
  'PerDraw', ${sqlJson(["Generated"])}, ${sqlJson({ certificateSignatureRequired: true })}, true,
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
  ${sqlString(hash(`provider:${runId}`))}, null, null
);

insert into game_engine.outcome_runtime_boot_identities (
  boot_id, runtime_instance_id, process_id, host_id, hostname, service_version,
  semantic_version, build_number, git_commit_sha, boot_timestamp, environment,
  provider_configuration_version, build_hash, runtime_framework
) values (
  '${bootId}', ${sqlString(`rollback:${runId}`)}, 3003, 'host-qa', 'host-qa', '1.0.0',
  '1.0.0', 'qa-build', ${sqlString(`commit-${runId}`)}, now(), 'QA',
  'provider-config-v1', ${sqlString(hash(`build:${runId}`))}, '.NET QA'
);

insert into game_engine.outcome_runtime_requests (
  runtime_request_id, idempotency_key, draw_request_scope, game_manifest_id, game_manifest_version,
  provider_id, provider_version, provider_type, mode, status, started_at, completed_at,
  failure_code, failure_reason, canonical_request_hash, result_reference_placeholder,
  evidence_reference_placeholder, lock_scope, lock_acquired
) values (
  '${requestId}', ${sqlString(`rollback:${runId}`)}, ${sqlString(`draw:${runId}`)},
  'manifest-rollback', '1.0.0', ${sqlString(providerId)}, '1.0.0', 'CERTIFIED_CSPRNG',
  'DryRun', 'FailedClosed', now(), now(), 'RuntimeRollbackDetected',
  'Rollback detection QA request without provenance.', ${sqlString(hash(`request:${runId}`))},
  null, 'placeholder:rollback-detection', ${sqlString(`outcome-runtime:${providerId}:1.0.0:draw:${runId}`)}, false
);
`);

addCheck("request rollback detected when provenance missing", scalar("select game_engine.detect_outcome_runtime_rollback();") === "t");

runSql(`
insert into game_engine.outcome_runtime_request_provenance (
  provenance_id, runtime_request_id, boot_id, runtime_instance_id, process_id,
  build_hash, git_commit_sha, outcome_provider_id, outcome_provider_version,
  manifest_id, manifest_version, provider_configuration_version, content_hash
) values (
  '${randomUUID()}', '${requestId}', '${bootId}', ${sqlString(`rollback:${runId}`)}, 3003,
  ${sqlString(hash(`build:${runId}`))}, ${sqlString(`commit-${runId}`)},
  ${sqlString(providerId)}, '1.0.0', 'manifest-rollback', '1.0.0',
  'provider-config-v1', ${sqlString(hash(`request-provenance:${runId}`))}
);

insert into game_engine.outcome_runtime_recovery_evidence (
  evidence_id, event_type, boot_id, runtime_instance_id, runtime_request_id,
  draw_request_scope, provider_id, provider_version, provider_type, reason_code,
  details, recovery_hash, content_hash, created_at
) values (
  '${randomUUID()}', 'RollbackDetection', '${bootId}', ${sqlString(`rollback:${runId}`)}, '${requestId}',
  ${sqlString(`draw:${runId}`)}, ${sqlString(providerId)}, '1.0.0', 'CERTIFIED_CSPRNG',
  'ROLLBACK_DETECTED', 'Detected missing provenance and failed closed.',
  ${sqlString(hash(`rollback-evidence:${runId}`))},
  ${sqlString(hash(`rollback-evidence-content:${runId}`))},
  now()
);
`);

addCheck("rollback detection evidence persists", scalar(`
select count(*) = 1
from game_engine.outcome_runtime_recovery_evidence
where runtime_request_id = '${requestId}'
  and event_type = 'RollbackDetection'
  and reason_code = 'ROLLBACK_DETECTED';
`) === "t");

const status = checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";
printJson({ status, checks });
if (status !== "PASS") {
  process.exit(1);
}
