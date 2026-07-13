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

const runId = randomUUID();
const providerId = `runtime-provenance-provider:${runId}`;
const requestId = randomUUID();
const attemptId = randomUUID();
const bootId = randomUUID();
const runtimeInstanceId = `runtime-provenance:${runId}`;
const requestHash = hash(`request:${runId}`);
const attemptHash = hash(`attempt:${runId}`);

runSql(`
insert into game_engine.outcome_provider_definitions (
  id, provider_id, provider_version, provider_type, lifecycle_state, production_eligible,
  supported_outcome_primitive_types, evidence_requirements, health_readiness_capabilities,
  idempotency_model, custody_support, signing_requirements, replayability_support,
  failure_mode, capability_markers, content_hash, certification_binding, jurisdiction_profile_references
) values (
  '${randomUUID()}', ${sqlString(providerId)}, '1.0.0', 'CERTIFIED_CSPRNG', 'Active', true,
  ${sqlJson(["UniqueNumberSet"])}, ${sqlJson({ runtimeEvidence: true })}, ${sqlJson(["runtime-provenance-ready"])},
  'PerDraw', ${sqlJson(["Generated", "Sealed", "Certified"])}, ${sqlJson({ certificateSignatureRequired: true })}, true,
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
  semantic_version, build_number, git_commit_sha, docker_image_digest, boot_timestamp,
  environment, provider_configuration_version, outcome_provider_id, outcome_provider_version,
  entropy_provider_id, entropy_provider_version, build_hash, runtime_framework
) values (
  '${bootId}', ${sqlString(runtimeInstanceId)}, 2002, 'host-qa', 'host-qa', '1.0.0',
  '1.0.0', 'qa-build', ${sqlString(`commit-${runId}`)}, 'sha256:image-digest', now(),
  'QA', 'provider-config-v1', ${sqlString(providerId)}, '1.0.0',
  'entropy-qa', '1.0.0', ${sqlString(hash(`build:${runId}`))}, '.NET QA'
);

insert into game_engine.outcome_runtime_requests (
  runtime_request_id, idempotency_key, draw_request_scope, game_manifest_id, game_manifest_version,
  provider_id, provider_version, provider_type, mode, status, started_at, completed_at,
  failure_code, failure_reason, canonical_request_hash, result_reference_placeholder,
  evidence_reference_placeholder, lock_scope, lock_acquired
) values (
  '${requestId}', ${sqlString(`runtime-provenance:${runId}`)}, ${sqlString(`draw:${runId}`)},
  'manifest-provenance', '1.0.0', ${sqlString(providerId)}, '1.0.0', 'CERTIFIED_CSPRNG',
  'DryRun', 'GenerationNotImplemented', now(), now(), 'GenerationNotImplemented',
  'Runtime provenance QA.', ${sqlString(requestHash)}, null, 'placeholder:runtime-provenance',
  ${sqlString(`outcome-runtime:${providerId}:1.0.0:draw:${runId}`)}, true
);

insert into game_engine.outcome_runtime_attempts (
  attempt_id, runtime_request_id, idempotency_key, draw_request_scope, provider_id,
  provider_version, provider_type, mode, status, failure_code, failure_reason,
  lock_scope, lock_acquired, canonical_attempt_hash, started_at, completed_at
) values (
  '${attemptId}', '${requestId}', ${sqlString(`runtime-provenance:${runId}`)}, ${sqlString(`draw:${runId}`)},
  ${sqlString(providerId)}, '1.0.0', 'CERTIFIED_CSPRNG', 'DryRun',
  'GenerationNotImplemented', 'GenerationNotImplemented', 'Runtime provenance attempt.',
  ${sqlString(`outcome-runtime:${providerId}:1.0.0:draw:${runId}`)}, true,
  ${sqlString(attemptHash)}, now(), now()
);
`);

runSql(`
insert into game_engine.outcome_runtime_request_provenance (
  provenance_id, runtime_request_id, boot_id, runtime_instance_id, process_id,
  build_hash, git_commit_sha, docker_image_digest, outcome_provider_id,
  outcome_provider_version, entropy_provider_id, entropy_provider_version,
  manifest_id, manifest_version, provider_configuration_version, content_hash
) values (
  '${randomUUID()}', '${requestId}', '${bootId}', ${sqlString(runtimeInstanceId)}, 2002,
  ${sqlString(hash(`build:${runId}`))}, ${sqlString(`commit-${runId}`)}, 'sha256:image-digest',
  ${sqlString(providerId)}, '1.0.0', 'entropy-qa', '1.0.0',
  'manifest-provenance', '1.0.0', 'provider-config-v1', ${sqlString(hash(`request-provenance:${runId}`))}
);

insert into game_engine.outcome_runtime_attempt_provenance (
  provenance_id, attempt_id, runtime_request_id, boot_id, runtime_instance_id,
  process_id, build_hash, git_commit_sha, docker_image_digest, outcome_provider_id,
  outcome_provider_version, entropy_provider_id, entropy_provider_version,
  manifest_id, manifest_version, provider_configuration_version, content_hash
) values (
  '${randomUUID()}', '${attemptId}', '${requestId}', '${bootId}', ${sqlString(runtimeInstanceId)},
  2002, ${sqlString(hash(`build:${runId}`))}, ${sqlString(`commit-${runId}`)}, 'sha256:image-digest',
  ${sqlString(providerId)}, '1.0.0', 'entropy-qa', '1.0.0',
  'manifest-provenance', '1.0.0', 'provider-config-v1', ${sqlString(hash(`attempt-provenance:${runId}`))}
);
`);

addCheck("request provenance records boot/build/provider/manifest", scalar(`
select count(*) = 1
from game_engine.outcome_runtime_request_provenance
where runtime_request_id = '${requestId}'
  and boot_id = '${bootId}'
  and outcome_provider_id = ${sqlString(providerId)}
  and manifest_id = 'manifest-provenance'
  and git_commit_sha = ${sqlString(`commit-${runId}`)};
`) === "t");

addCheck("attempt provenance records boot/build/provider/manifest", scalar(`
select count(*) = 1
from game_engine.outcome_runtime_attempt_provenance
where attempt_id = '${attemptId}'
  and runtime_request_id = '${requestId}'
  and boot_id = '${bootId}'
  and entropy_provider_id = 'entropy-qa';
`) === "t");

const duplicateRequestProvenance = runSql(`
insert into game_engine.outcome_runtime_request_provenance (
  provenance_id, runtime_request_id, boot_id, runtime_instance_id, process_id,
  build_hash, git_commit_sha, provider_configuration_version, content_hash
) values (
  '${randomUUID()}', '${requestId}', '${bootId}', ${sqlString(runtimeInstanceId)}, 2002,
  ${sqlString(hash(`build:${runId}`))}, ${sqlString(`commit-${runId}`)}, 'provider-config-v1',
  ${sqlString(hash(`request-provenance-duplicate:${runId}`))}
);
`, { allowFailure: true });
addCheck("duplicate request provenance blocked", duplicateRequestProvenance.status !== 0, {
  stderr: duplicateRequestProvenance.stderr.trim(),
});

const deleteBlocked = runSql(`
delete from game_engine.outcome_runtime_attempt_provenance
where attempt_id = '${attemptId}';
`, { allowFailure: true });
addCheck("attempt provenance delete blocked", deleteBlocked.status !== 0, { stderr: deleteBlocked.stderr.trim() });

const status = checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";
printJson({ status, checks });
if (status !== "PASS") {
  process.exit(1);
}
