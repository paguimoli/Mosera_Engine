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

function setupSql(runId, providerId, authorityId) {
  return `
insert into game_engine.outcome_provider_definitions (
  id, provider_id, provider_version, provider_type, lifecycle_state, production_eligible,
  supported_outcome_primitive_types, evidence_requirements, health_readiness_capabilities,
  idempotency_model, custody_support, signing_requirements, replayability_support,
  failure_mode, capability_markers, content_hash, certification_binding, jurisdiction_profile_references
) values (
  '${randomUUID()}', ${sqlString(providerId)}, '1.0.0', 'PHYSICAL_DRAW_RESULT', 'Active', false,
  ${sqlJson(["UniqueNumberSet"])}, ${sqlJson({ physicalDrawEvidence: true })}, ${sqlJson(["physical-draw-runtime-ready"])},
  'PerPhysicalDraw', ${sqlJson(["Received", "Certified", "Disputed", "Superseded"])}, ${sqlJson({ custodyEvidence: "required" })}, true,
  'FailClosed',
  ${sqlJson({
    generatesOutcomes: false,
    ingestsExternalOutcomes: true,
    supportsPlayerVerificationReceipt: false,
    supportsDeterministicReplay: true,
    supportsProviderHealthEvidence: true,
    supportsDisputeHandling: true,
    supportsExternalSourceEvidence: false,
    supportsPhysicalDrawEvidence: true,
  })},
  ${sqlString(hash(`physical-custody-provider:${runId}`))}, null, null
);

insert into game_engine.physical_draw_authorities (
  id, authority_id, authority_version, authority_name, authority_type, country, jurisdiction,
  operator, facility, draw_machine_identifier, ball_set_identifier, approved_procedures_version,
  supported_game_identifiers, supported_result_schemas, witness_policy, timestamp_policy,
  production_eligible, lifecycle_state, failure_mode, content_hash, certification_binding
) values (
  '${randomUUID()}', ${sqlString(authorityId)}, '1.0.0', 'QA Physical Authority', 'GOVERNMENT_LOTTERY', 'CR', null,
  'QA Operator', 'QA Studio', 'machine-alpha', 'ball-set-alpha', 'procedures-v1',
  ${sqlJson(["LOTTO-PHYS"])}, ${sqlJson(["UNIQUE_NUMBER_SET"])},
  ${sqlJson({ operatorRequired: true, primaryWitnessRequired: true, secondaryWitnessRequired: false, regulatorWitnessRequired: false, minimumWitnessCount: 2 })},
  ${sqlJson({ maxClockSkewSeconds: 300, maxDrawAgeSeconds: 86400, futureTimestampsRejected: true })},
  false, 'Active', 'FailClosed', ${sqlString(hash(`physical-custody-authority:${runId}`))}, null
);`;
}

function drawEventSql(runId, providerId, authorityId, drawIdentifier, numbers, suffix = "") {
  const canonicalHash = hash(numbers.slice().sort((a, b) => a - b).join("|"));
  const eventHash = hash(`physical-custody-event:${runId}:${drawIdentifier}:${canonicalHash}:${suffix}`);
  return `
insert into game_engine.physical_draw_events (
  draw_event_id, idempotency_key, draw_identifier, provider_id, provider_version,
  authority_id, authority_version, manifest_id, manifest_version, game_identifier,
  draw_timestamp, scheduled_timestamp, received_timestamp, schema_type,
  normalized_payload, canonical_result_hash, winning_numbers, bonus_numbers, alternate_balls,
  equipment_references, machine_id, ball_set_id, draw_operator, witness_references, media_references,
  video_hash, image_hash, official_report_reference, procedural_evidence_hash, custody_state, content_hash
) values (
  '${randomUUID()}', ${sqlString(`physical-custody-idem:${runId}:${drawIdentifier}:${suffix}`)}, ${sqlString(drawIdentifier)},
  ${sqlString(providerId)}, '1.0.0', ${sqlString(authorityId)}, '1.0.0', 'manifest-physical', '1.0.0', 'LOTTO-PHYS',
  now() - interval '2 minutes', now() - interval '5 minutes', now(), 'UNIQUE_NUMBER_SET',
  ${sqlJson({ resultType: "UniqueNumberSet", numbers: numbers.slice().sort((a, b) => a - b) })},
  ${sqlString(canonicalHash)}, ${sqlJson(numbers)}, '[]'::jsonb, '[]'::jsonb,
  ${sqlJson([{ EquipmentId: "machine-alpha", EquipmentType: "DRAW_MACHINE", EquipmentVersion: "machine-v1", LifecycleState: "Active", InspectionReference: "inspection:qa", MaintenanceReference: "maintenance:qa", CalibrationReference: "calibration:qa", SealReference: "seal:qa", Approved: true }])},
  'machine-alpha', 'ball-set-alpha', 'operator-qa',
  ${sqlJson({ OperatorIdentity: "operator-qa", PrimaryWitness: "primary-witness-qa" })},
  ${sqlJson(["media:qa"])}, null, null, 'official-report:qa', ${sqlString(hash(`procedure:${runId}`))}, 'Certified',
  ${sqlString(eventHash)}
);`;
}

const runId = randomUUID();
const providerId = `physical-custody-provider:${runId}`;
const authorityId = `physical-custody-authority:${runId}`;
const drawIdentifier = "physical-custody-draw-001";
runSql(setupSql(runId, providerId, authorityId));

runSql(drawEventSql(runId, providerId, authorityId, drawIdentifier, [4, 8, 15, 16, 23], "first"));
addCheck("canonical outcome generation persists", queryScalar(`
select count(*) = 1
from game_engine.physical_draw_events
where authority_id = ${sqlString(authorityId)}
  and draw_identifier = ${sqlString(drawIdentifier)}
  and canonical_result_hash = ${sqlString(hash("4|8|15|16|23"))};
`) === "t");

const duplicateSame = runSql(drawEventSql(runId, providerId, authorityId, drawIdentifier, [23, 16, 15, 8, 4], "same"), { allowFailure: true });
addCheck("duplicate identical draw blocked or idempotent without conflict", duplicateSame.status !== 0, { stderr: duplicateSame.stderr.trim() });

const duplicateConflict = runSql(drawEventSql(runId, providerId, authorityId, drawIdentifier, [1, 2, 3, 4, 5], "conflict"), { allowFailure: true });
addCheck("duplicate conflicting draw fails closed", duplicateConflict.status !== 0 && duplicateConflict.stderr.includes("supersession"), { stderr: duplicateConflict.stderr.trim() });

runSql(`
insert into game_engine.physical_draw_evidence (
  evidence_id, draw_event_id, authority_id, authority_version, provider_id, provider_version,
  draw_identifier, verification_status, custody_state, canonical_result_hash, event_content_hash,
  failure_code, failure_reason, evidence_hash, verified_at
) values (
  '${randomUUID()}', '${randomUUID()}', ${sqlString(authorityId)}, '1.0.0', ${sqlString(providerId)}, '1.0.0',
  ${sqlString(drawIdentifier)}, 'Conflict', 'Disputed', ${sqlString(hash("1|2|3|4|5"))},
  ${sqlString(hash(`conflict-event:${runId}`))}, 'PHYSICAL_DRAW_CONFLICT', 'Governed supersession required',
  ${sqlString(hash(`conflict-evidence:${runId}`))}, now()
);`);
addCheck("custody conflict evidence persists", queryScalar(`
select count(*) = 1
from game_engine.physical_draw_evidence
where authority_id = ${sqlString(authorityId)}
  and verification_status = 'Conflict'
  and custody_state = 'Disputed';
`) === "t");

const invalidCustody = runSql(`
insert into game_engine.physical_draw_evidence (
  evidence_id, draw_event_id, authority_id, authority_version, provider_id, provider_version,
  draw_identifier, verification_status, custody_state, canonical_result_hash, event_content_hash,
  failure_code, failure_reason, evidence_hash, verified_at
) values (
  '${randomUUID()}', '${randomUUID()}', ${sqlString(authorityId)}, '1.0.0', ${sqlString(providerId)}, '1.0.0',
  ${sqlString(drawIdentifier)}, 'Conflict', 'Certified', ${sqlString(hash("1|2|3|4|5"))},
  ${sqlString(hash(`invalid-custody-event:${runId}`))}, 'PHYSICAL_DRAW_CONFLICT', 'Invalid custody',
  ${sqlString(hash(`invalid-custody-evidence:${runId}`))}, now()
);`, { allowFailure: true });
addCheck("invalid custody transition rejected", invalidCustody.status !== 0, { stderr: invalidCustody.stderr.trim() });

const updateBlocked = runSql(`
update game_engine.physical_draw_events
set custody_state = 'Disputed'
where authority_id = ${sqlString(authorityId)};
`, { allowFailure: true });
addCheck("event update blocked", updateBlocked.status !== 0, { stderr: updateBlocked.stderr.trim() });

const deleteBlocked = runSql(`
delete from game_engine.physical_draw_evidence
where authority_id = ${sqlString(authorityId)};
`, { allowFailure: true });
addCheck("evidence delete blocked", deleteBlocked.status !== 0, { stderr: deleteBlocked.stderr.trim() });

const productionAttempt = runSql(`
insert into game_engine.outcome_runtime_attempts (
  attempt_id, runtime_request_id, idempotency_key, draw_request_scope, provider_id, provider_version,
  provider_type, mode, status, failure_code, failure_reason, lock_scope, lock_acquired,
  canonical_attempt_hash, started_at, completed_at
) values (
  '${randomUUID()}', '${randomUUID()}', ${sqlString(`physical-production:${runId}`)}, ${sqlString(drawIdentifier)},
  ${sqlString(providerId)}, '1.0.0', 'PHYSICAL_DRAW_RESULT', 'Production', 'Accepted', 'None', null,
  ${sqlString(`physical:${drawIdentifier}`)}, true, ${sqlString(hash(`physical-production-attempt:${runId}`))}, now(), now()
);`, { allowFailure: true });
addCheck("production mode remains disabled", productionAttempt.status !== 0, { stderr: productionAttempt.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });

if (failed.length > 0) {
  process.exit(1);
}
