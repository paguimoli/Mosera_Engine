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

function insertProvider(providerId, runId) {
  runSql(`
insert into game_engine.outcome_provider_definitions (
  id, provider_id, provider_version, provider_type, lifecycle_state, production_eligible,
  supported_outcome_primitive_types, evidence_requirements, health_readiness_capabilities,
  idempotency_model, custody_support, signing_requirements, replayability_support,
  failure_mode, capability_markers, content_hash, certification_binding, jurisdiction_profile_references
) values (
  '${randomUUID()}', ${sqlString(providerId)}, '1.0.0', 'EXTERNAL_OFFICIAL_RESULT', 'Active', false,
  ${sqlJson(["UniqueNumberSet"])}, ${sqlJson({ sourceEvidence: true })}, ${sqlJson(["external-runtime-ready"])},
  'PerExternalResult', ${sqlJson(["Ingested", "Certified", "Disputed"])}, ${sqlJson({ sourceSignature: "required" })}, true,
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
  ${sqlString(hash(`signature-provider:${runId}`))}, null, null
);`);
}

function insertSource(sourceId, runId, { revoked = false, lifecycle = "Active" } = {}) {
  runSql(`
insert into game_engine.external_result_source_definitions (
  id, source_id, source_version, source_name, source_type,
  endpoint_reference_metadata, authentication_method, signature_requirement,
  transport_security_requirement, supported_game_identifiers, supported_result_schemas,
  source_timezone, publication_delay_policy, replay_retrieval_capability,
  production_eligible, lifecycle_state, failure_mode, content_hash,
  certification_binding, verification_key_id, verification_algorithm_version,
  verification_key_revoked_at, supersedes_source_version
) values (
  '${randomUUID()}', ${sqlString(sourceId)}, '1.0.0', 'QA Signed Source', 'SIGNED_FILE_FEED',
  ${sqlJson({ endpointReference: "qa-signed-feed" })}, 'DETACHED_SIGNATURE', 'DETACHED_REQUIRED',
  'OFFLINE_SIGNED_FILE', ${sqlJson(["LOTTO-SIG"])}, ${sqlJson(["UNIQUE_NUMBER_SET"])},
  'UTC', ${sqlJson({ maxClockSkewSeconds: 300, maxResultAgeSeconds: 3600, futureTimestampsRejected: true })}, true,
  false, ${sqlString(lifecycle)}, 'FailClosed', ${sqlString(hash(`signature-source:${runId}:${sourceId}:${revoked}:${lifecycle}`))},
  null, 'qa-test-key-1', 'TEST_SHA256_DETACHED_V1', ${revoked ? "now() - interval '1 minute'" : "null"}, null
);

insert into game_engine.external_result_schema_mappings (
  mapping_id, source_id, source_version, schema_version, schema_type,
  mapping_definition, lifecycle_state, content_hash
) values (
  '${randomUUID()}', ${sqlString(sourceId)}, '1.0.0', 'official-numbers-v1', 'UNIQUE_NUMBER_SET',
  ${sqlJson({ numbersField: "numbers" })}, 'Active',
  ${sqlString(hash(`signature-mapping:${runId}:${sourceId}`))}
);`);
}

function ingestionSql({ runId, providerId, sourceId, drawId, sourceSignatureHash = hash(`signature:${runId}`), game = "LOTTO-SIG", schema = "UNIQUE_NUMBER_SET", sourceTimestamp = "now()" }) {
  return `
insert into game_engine.external_result_ingestion_events (
  ingestion_request_id, idempotency_key, source_id, source_version, provider_id, provider_version,
  manifest_id, manifest_version, game_identifier, drawing_id, external_draw_id,
  publication_timestamp, source_timestamp, received_timestamp, source_payload_hash,
  source_signature_hash, signature_algorithm_version, schema_version, schema_type,
  normalized_payload, canonical_result_hash, transport_evidence_reference,
  source_metadata_reference, custody_state, content_hash
) values (
  '${randomUUID()}', ${sqlString(`signature-idempotency:${runId}:${drawId}`)}, ${sqlString(sourceId)}, '1.0.0',
  ${sqlString(providerId)}, '1.0.0', 'manifest-signature', '1.0.0',
  ${sqlString(game)}, 'draw-signature', ${sqlString(drawId)}, now(), ${sourceTimestamp}, now(),
  ${sqlString(hash(`signature-payload:${runId}:${drawId}`))}, ${sourceSignatureHash === null ? "null" : sqlString(sourceSignatureHash)},
  'TEST_SHA256_DETACHED_V1', 'official-numbers-v1', ${sqlString(schema)},
  ${sqlJson({ resultType: "UniqueNumberSet", numbers: [3, 4, 8] })},
  ${sqlString(hash(`signature-result:${runId}:${drawId}`))}, 'transport-evidence:signature',
  'source-metadata:signature', 'Certified', ${sqlString(hash(`signature-ingestion:${runId}:${drawId}`))}
);`;
}

const runId = randomUUID();
const providerId = `external-signature-provider:${runId}`;
const sourceId = `external-signature-source:${runId}`;
insertProvider(providerId, runId);
insertSource(sourceId, runId);

runSql(ingestionSql({ runId, providerId, sourceId, drawId: "valid-signature" }));
addCheck("valid signed result ingests", queryScalar(`
select count(*) = 1
from game_engine.external_result_ingestion_events
where source_id = ${sqlString(sourceId)}
  and external_draw_id = 'valid-signature';
`) === "t");

const unsigned = runSql(ingestionSql({ runId, providerId, sourceId, drawId: "unsigned", sourceSignatureHash: null }), { allowFailure: true });
addCheck("unsigned result rejected when signature required", unsigned.status !== 0, { stderr: unsigned.stderr.trim() });

const wrongGame = runSql(ingestionSql({ runId, providerId, sourceId, drawId: "wrong-game", game: "WRONG-GAME" }), { allowFailure: true });
addCheck("wrong game rejected", wrongGame.status !== 0, { stderr: wrongGame.stderr.trim() });

const schemaMismatch = runSql(ingestionSql({ runId, providerId, sourceId, drawId: "wrong-schema", schema: "SYMBOL_SEQUENCE" }), { allowFailure: true });
addCheck("schema mismatch rejected", schemaMismatch.status !== 0, { stderr: schemaMismatch.stderr.trim() });

const future = runSql(ingestionSql({ runId, providerId, sourceId, drawId: "future", sourceTimestamp: "now() + interval '1 hour'" }), { allowFailure: true });
addCheck("future timestamp policy enforced", future.status !== 0, { stderr: future.stderr.trim() });

const stale = runSql(ingestionSql({ runId, providerId, sourceId, drawId: "stale", sourceTimestamp: "now() - interval '2 hours'" }), { allowFailure: true });
addCheck("stale timestamp policy enforced", stale.status !== 0, { stderr: stale.stderr.trim() });

const revokedSourceId = `${sourceId}:revoked`;
insertSource(revokedSourceId, `${runId}:revoked`, { revoked: true });
const revoked = runSql(ingestionSql({ runId: `${runId}:revoked`, providerId, sourceId: revokedSourceId, drawId: "revoked" }), { allowFailure: true });
addCheck("revoked source key rejected", revoked.status !== 0, { stderr: revoked.stderr.trim() });

const inactiveSourceId = `${sourceId}:inactive`;
insertSource(inactiveSourceId, `${runId}:inactive`, { lifecycle: "Suspended" });
const inactive = runSql(ingestionSql({ runId: `${runId}:inactive`, providerId, sourceId: inactiveSourceId, drawId: "inactive" }), { allowFailure: true });
addCheck("inactive source rejected", inactive.status !== 0, { stderr: inactive.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });

if (failed.length > 0) {
  process.exit(1);
}
