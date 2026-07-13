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

function setup(runId, providerId, sourceId) {
  runSql(`
insert into game_engine.outcome_provider_definitions (
  id, provider_id, provider_version, provider_type, lifecycle_state, production_eligible,
  supported_outcome_primitive_types, evidence_requirements, health_readiness_capabilities,
  idempotency_model, custody_support, signing_requirements, replayability_support,
  failure_mode, capability_markers, content_hash, certification_binding, jurisdiction_profile_references
) values (
  '${randomUUID()}', ${sqlString(providerId)}, '1.0.0', 'EXTERNAL_OFFICIAL_RESULT', 'Active', false,
  ${sqlJson(["UniqueNumberSet"])}, ${sqlJson({ sourceEvidence: true })}, ${sqlJson(["external-runtime-ready"])},
  'PerExternalResult', ${sqlJson(["Ingested", "Certified", "Disputed", "Superseded"])}, ${sqlJson({ sourceSignature: "required" })}, true,
  'FailClosed',
  ${sqlJson({
    generatesOutcomes: false,
    ingestsExternalOutcomes: true,
    supportsPlayerVerificationReceipt: false,
    supportsDeterministicReplay: true,
    supportsProviderHealthEvidence: true,
    supportsDisputeHandling: true,
    supportsExternalSourceEvidence: true,
    supportsPhysicalDrawEvidence: false,
  })},
  ${sqlString(hash(`conflict-provider:${runId}`))}, null, null
);

insert into game_engine.external_result_source_definitions (
  id, source_id, source_version, source_name, source_type,
  endpoint_reference_metadata, authentication_method, signature_requirement,
  transport_security_requirement, supported_game_identifiers, supported_result_schemas,
  source_timezone, publication_delay_policy, replay_retrieval_capability,
  production_eligible, lifecycle_state, failure_mode, content_hash,
  certification_binding, verification_key_id, verification_algorithm_version,
  verification_key_revoked_at, supersedes_source_version
) values (
  '${randomUUID()}', ${sqlString(sourceId)}, '1.0.0', 'QA Conflict Source', 'SIGNED_FILE_FEED',
  ${sqlJson({ endpointReference: "qa-conflict-feed" })}, 'DETACHED_SIGNATURE', 'DETACHED_REQUIRED',
  'OFFLINE_SIGNED_FILE', ${sqlJson(["LOTTO-CONFLICT"])}, ${sqlJson(["UNIQUE_NUMBER_SET"])},
  'UTC', ${sqlJson({ maxClockSkewSeconds: 300, maxResultAgeSeconds: 86400, futureTimestampsRejected: true })}, true,
  false, 'Active', 'FailClosed', ${sqlString(hash(`conflict-source:${runId}`))},
  null, 'qa-test-key-1', 'TEST_SHA256_DETACHED_V1', null, null
);

insert into game_engine.external_result_schema_mappings (
  mapping_id, source_id, source_version, schema_version, schema_type,
  mapping_definition, lifecycle_state, content_hash
) values (
  '${randomUUID()}', ${sqlString(sourceId)}, '1.0.0', 'official-numbers-v1', 'UNIQUE_NUMBER_SET',
  ${sqlJson({ numbersField: "numbers" })}, 'Active',
  ${sqlString(hash(`conflict-mapping:${runId}`))}
);`);
}

function ingestionSql({ runId, providerId, sourceId, drawId, resultHash, contentHash, idempotencyKey, numbers }) {
  return `
insert into game_engine.external_result_ingestion_events (
  ingestion_request_id, idempotency_key, source_id, source_version, provider_id, provider_version,
  manifest_id, manifest_version, game_identifier, drawing_id, external_draw_id,
  publication_timestamp, source_timestamp, received_timestamp, source_payload_hash,
  source_signature_hash, signature_algorithm_version, schema_version, schema_type,
  normalized_payload, canonical_result_hash, transport_evidence_reference,
  source_metadata_reference, custody_state, content_hash
) values (
  '${randomUUID()}', ${sqlString(idempotencyKey)}, ${sqlString(sourceId)}, '1.0.0',
  ${sqlString(providerId)}, '1.0.0', 'manifest-conflict', '1.0.0',
  'LOTTO-CONFLICT', 'draw-conflict', ${sqlString(drawId)}, now(), now(), now(),
  ${sqlString(hash(`conflict-source-payload:${runId}:${contentHash}`))}, ${sqlString(hash(`conflict-signature:${runId}:${contentHash}`))},
  'TEST_SHA256_DETACHED_V1', 'official-numbers-v1', 'UNIQUE_NUMBER_SET',
  ${sqlJson({ resultType: "UniqueNumberSet", numbers })},
  ${sqlString(resultHash)}, 'transport-evidence:conflict',
  'source-metadata:conflict', 'Certified', ${sqlString(contentHash)}
);`;
}

const runId = randomUUID();
const providerId = `external-conflict-provider:${runId}`;
const sourceId = `external-conflict-source:${runId}`;
const drawId = "external-conflict-draw-001";
const canonicalResultHash = hash("conflict-result:1,2,3,4,5");
setup(runId, providerId, sourceId);

runSql(ingestionSql({
  runId,
  providerId,
  sourceId,
  drawId,
  resultHash: canonicalResultHash,
  contentHash: hash(`conflict-ingestion:${runId}:primary`),
  idempotencyKey: `conflict-idempotency:${runId}:primary`,
  numbers: [1, 2, 3, 4, 5],
}));

const duplicateIdentical = runSql(ingestionSql({
  runId,
  providerId,
  sourceId,
  drawId,
  resultHash: canonicalResultHash,
  contentHash: hash(`conflict-ingestion:${runId}:duplicate`),
  idempotencyKey: `conflict-idempotency:${runId}:duplicate`,
  numbers: [1, 2, 3, 4, 5],
}), { allowFailure: true });
addCheck("duplicate identical result is idempotent or blocked without conflict", duplicateIdentical.status !== 0, { stderr: duplicateIdentical.stderr.trim() });

const conflicting = runSql(ingestionSql({
  runId,
  providerId,
  sourceId,
  drawId,
  resultHash: hash("conflict-result:1,2,3,4,9"),
  contentHash: hash(`conflict-ingestion:${runId}:conflicting`),
  idempotencyKey: `conflict-idempotency:${runId}:conflicting`,
  numbers: [1, 2, 3, 4, 9],
}), { allowFailure: true });
addCheck("duplicate conflicting result fails closed", conflicting.status !== 0, { stderr: conflicting.stderr.trim() });

runSql(`
insert into game_engine.external_result_verification_evidence (
  evidence_id, ingestion_request_id, source_id, source_version, provider_id, provider_version,
  external_draw_id, verification_status, custody_state, canonical_result_hash,
  source_payload_hash, failure_code, failure_reason, evidence_hash, verified_at
) values (
  '${randomUUID()}', '${randomUUID()}', ${sqlString(sourceId)}, '1.0.0',
  ${sqlString(providerId)}, '1.0.0', ${sqlString(drawId)}, 'Conflict', 'Disputed',
  ${sqlString(hash("conflict-result:1,2,3,4,9"))}, ${sqlString(hash(`conflict-source-payload:${runId}:conflicting`))},
  'RESULT_CONFLICT', 'External result conflicts with certified result; supersession required.',
  ${sqlString(hash(`conflict-evidence:${runId}`))}, now()
);`);
addCheck("custody conflict evidence persists", queryScalar(`
select count(*) = 1
from game_engine.external_result_verification_evidence
where source_id = ${sqlString(sourceId)}
  and external_draw_id = ${sqlString(drawId)}
  and verification_status = 'Conflict'
  and custody_state = 'Disputed';
`) === "t");

const updateAttempt = runSql(`
update game_engine.external_result_ingestion_events
set custody_state = 'Superseded'
where source_id = ${sqlString(sourceId)}
  and external_draw_id = ${sqlString(drawId)};
`, { allowFailure: true });
addCheck("update blocked", updateAttempt.status !== 0, { stderr: updateAttempt.stderr.trim() });

const deleteAttempt = runSql(`
delete from game_engine.external_result_verification_evidence
where source_id = ${sqlString(sourceId)}
  and external_draw_id = ${sqlString(drawId)};
`, { allowFailure: true });
addCheck("delete blocked", deleteAttempt.status !== 0, { stderr: deleteAttempt.stderr.trim() });

addCheck("no credentials or secrets persist", queryScalar(`
select
  (select count(*) from information_schema.columns where table_schema = 'game_engine' and table_name = 'external_result_ingestion_events' and column_name in ('source_signature', 'credential', 'secret', 'api_key')) = 0
  and not exists (
    select 1
    from game_engine.external_result_source_definitions
    where source_id = ${sqlString(sourceId)}
      and endpoint_reference_metadata::text ilike '%secret%'
  );
`) === "t");

const productionAttempt = runSql(`
insert into game_engine.outcome_runtime_attempts (
  attempt_id, runtime_request_id, idempotency_key, draw_request_scope,
  provider_id, provider_version, provider_type, mode, status, failure_code,
  failure_reason, lock_scope, lock_acquired, canonical_attempt_hash, started_at, completed_at
) values (
  '${randomUUID()}', '${randomUUID()}', ${sqlString(`external-production:${runId}`)}, 'draw-conflict',
  ${sqlString(providerId)}, '1.0.0', 'EXTERNAL_OFFICIAL_RESULT', 'Production', 'Accepted', 'None',
  null, ${sqlString(`outcome-runtime:${providerId}:1.0.0:draw-conflict`)}, true,
  ${sqlString(hash(`external-production-attempt:${runId}`))}, now(), now()
);`, { allowFailure: true });
addCheck("production mode remains disabled", productionAttempt.status !== 0, { stderr: productionAttempt.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });

if (failed.length > 0) {
  process.exit(1);
}
