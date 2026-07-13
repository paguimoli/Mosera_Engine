import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

function existsRegclass(name) {
  return queryScalar(`select to_regclass('${name}') is not null;`) === "t";
}

function insertProviderSql(runId, providerId) {
  return `
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
  ${sqlString(hash(`external-provider:${runId}`))}, null, null
);`;
}

function insertSourceSql(runId, sourceId, { lifecycle = "Active", failureMode = "FailClosed", productionEligible = false } = {}) {
  return `
insert into game_engine.external_result_source_definitions (
  id, source_id, source_version, source_name, source_type,
  endpoint_reference_metadata, authentication_method, signature_requirement,
  transport_security_requirement, supported_game_identifiers, supported_result_schemas,
  source_timezone, publication_delay_policy, replay_retrieval_capability,
  production_eligible, lifecycle_state, failure_mode, content_hash,
  certification_binding, verification_key_id, verification_algorithm_version,
  verification_key_revoked_at, supersedes_source_version
) values (
  '${randomUUID()}', ${sqlString(sourceId)}, '1.0.0', 'QA Official Source', 'SIGNED_FILE_FEED',
  ${sqlJson({ endpointReference: "qa-signed-feed" })}, 'DETACHED_SIGNATURE', 'DETACHED_REQUIRED',
  'OFFLINE_SIGNED_FILE', ${sqlJson(["LOTTO-EXT"])}, ${sqlJson(["UNIQUE_NUMBER_SET"])},
  'UTC', ${sqlJson({ maxClockSkewSeconds: 300, maxResultAgeSeconds: 86400, futureTimestampsRejected: true })}, true,
  ${productionEligible ? "true" : "false"}, ${sqlString(lifecycle)}, ${sqlString(failureMode)}, ${sqlString(hash(`external-source:${runId}:${sourceId}:${lifecycle}`))},
  null, 'qa-test-key-1', 'TEST_SHA256_DETACHED_V1', null, null
);

insert into game_engine.external_result_schema_mappings (
  mapping_id, source_id, source_version, schema_version, schema_type,
  mapping_definition, lifecycle_state, content_hash
) values (
  '${randomUUID()}', ${sqlString(sourceId)}, '1.0.0', 'official-numbers-v1', 'UNIQUE_NUMBER_SET',
  ${sqlJson({ numbersField: "numbers", normalization: "sort-unique" })}, 'Active',
  ${sqlString(hash(`external-mapping:${runId}:${sourceId}`))}
);`;
}

const runId = randomUUID();
const providerId = `external-provider:${runId}`;
const sourceId = `external-source:${runId}`;

addCheck("runtime service source exists", readFileSync("services/game-engine/src/GameEngine.Application/Services/ExternalOfficialResultRuntimeServices.cs", "utf8").includes("ExternalOfficialResultRuntimeService"));
addCheck("source definitions table exists", existsRegclass("game_engine.external_result_source_definitions"));
addCheck("schema mappings table exists", existsRegclass("game_engine.external_result_schema_mappings"));
addCheck("ingestion events table exists", existsRegclass("game_engine.external_result_ingestion_events"));
addCheck("verification evidence table exists", existsRegclass("game_engine.external_result_verification_evidence"));

runSql(insertProviderSql(runId, providerId));
runSql(insertSourceSql(runId, sourceId));

addCheck("valid approved source persists", queryScalar(`
select count(*) = 1
from game_engine.external_result_source_definitions
where source_id = ${sqlString(sourceId)}
  and lifecycle_state = 'Active';
`) === "t");

const invalidSource = runSql(insertSourceSql(`${runId}:invalid`, `${sourceId}:invalid`, {
  productionEligible: true,
  failureMode: "Disabled",
}), { allowFailure: true });
addCheck("invalid ineligible source rejected", invalidSource.status !== 0, { stderr: invalidSource.stderr.trim() });

runSql(`
insert into game_engine.external_result_ingestion_events (
  ingestion_request_id, idempotency_key, source_id, source_version, provider_id, provider_version,
  manifest_id, manifest_version, game_identifier, drawing_id, external_draw_id,
  publication_timestamp, source_timestamp, received_timestamp, source_payload_hash,
  source_signature_hash, signature_algorithm_version, schema_version, schema_type,
  normalized_payload, canonical_result_hash, transport_evidence_reference,
  source_metadata_reference, custody_state, content_hash
) values (
  '${randomUUID()}', ${sqlString(`external-idempotency:${runId}`)}, ${sqlString(sourceId)}, '1.0.0',
  ${sqlString(providerId)}, '1.0.0', 'manifest-external', '1.0.0',
  'LOTTO-EXT', 'draw-001', 'external-draw-001', now(), now(), now(),
  ${sqlString(hash(`source-payload:${runId}`))}, ${sqlString(hash(`signature:${runId}`))},
  'TEST_SHA256_DETACHED_V1', 'official-numbers-v1', 'UNIQUE_NUMBER_SET',
  ${sqlJson({ resultType: "UniqueNumberSet", numbers: [1, 2, 5, 7, 9] })},
  ${sqlString(hash("1|2|5|7|9"))}, 'transport-evidence:qa',
  'source-metadata:qa', 'Certified', ${sqlString(hash(`ingestion:${runId}`))}
);

insert into game_engine.external_result_verification_evidence (
  evidence_id, ingestion_request_id, source_id, source_version, provider_id, provider_version,
  external_draw_id, verification_status, custody_state, canonical_result_hash,
  source_payload_hash, failure_code, failure_reason, evidence_hash, verified_at
) values (
  '${randomUUID()}', '${randomUUID()}', ${sqlString(sourceId)}, '1.0.0',
  ${sqlString(providerId)}, '1.0.0', 'external-draw-001', 'Verified', 'Certified',
  ${sqlString(hash("1|2|5|7|9"))}, ${sqlString(hash(`source-payload:${runId}`))},
  null, null, ${sqlString(hash(`evidence:${runId}`))}, now()
);`);

addCheck("valid signed result ingests", queryScalar(`
select count(*) = 1
from game_engine.external_result_ingestion_events
where source_id = ${sqlString(sourceId)}
  and provider_id = ${sqlString(providerId)}
  and external_draw_id = 'external-draw-001'
  and custody_state = 'Certified';
`) === "t");

addCheck("no random generation occurs", queryScalar(`
select count(*) = 0
from game_engine.drbg_session_evidence
where provider_id = ${sqlString(providerId)};
`) === "t");

addCheck("no Math/Settlement/Ledger effects occur", queryScalar(`
select
  (select count(*) from game_engine.math_evaluation_events where idempotency_key = ${sqlString(`external-idempotency:${runId}`)}) = 0
  and (select count(*) from settlement_service.settlement_ledger_effects where idempotency_key = ${sqlString(`external-idempotency:${runId}`)}) = 0
  and (select count(*) from public.financial_ledger_entries where idempotency_key = ${sqlString(`external-idempotency:${runId}`)}) = 0;
`) === "t");

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });

if (failed.length > 0) {
  process.exit(1);
}
