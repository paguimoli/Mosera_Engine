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

function insertProvider(runId, providerId) {
  runSql(`
insert into game_engine.outcome_provider_definitions (
  id, provider_id, provider_version, provider_type, lifecycle_state, production_eligible,
  supported_outcome_primitive_types, evidence_requirements, health_readiness_capabilities,
  idempotency_model, custody_support, signing_requirements, replayability_support,
  failure_mode, capability_markers, content_hash, certification_binding, jurisdiction_profile_references
) values (
  '${randomUUID()}', ${sqlString(providerId)}, '1.0.0', 'PHYSICAL_DRAW_RESULT', 'Active', false,
  ${sqlJson(["UniqueNumberSet"])}, ${sqlJson({ physicalDrawEvidence: true })}, ${sqlJson(["physical-draw-runtime-ready"])},
  'PerPhysicalDraw', ${sqlJson(["Received", "Certified", "Disputed"])}, ${sqlJson({ custodyEvidence: "required" })}, true,
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
  ${sqlString(hash(`physical-authority-provider:${runId}`))}, null, null
);`);
}

function authoritySql(runId, authorityId, overrides = {}) {
  return `
insert into game_engine.physical_draw_authorities (
  id, authority_id, authority_version, authority_name, authority_type, country, jurisdiction,
  operator, facility, draw_machine_identifier, ball_set_identifier, approved_procedures_version,
  supported_game_identifiers, supported_result_schemas, witness_policy, timestamp_policy,
  production_eligible, lifecycle_state, failure_mode, content_hash, certification_binding
) values (
  '${randomUUID()}', ${sqlString(authorityId)}, '1.0.0', 'QA Physical Authority', 'GOVERNMENT_LOTTERY', 'CR', null,
  'QA Operator', 'QA Studio', 'machine-alpha', 'ball-set-alpha', 'procedures-v1',
  ${sqlJson(["LOTTO-PHYS"])}, ${sqlJson(["UNIQUE_NUMBER_SET"])},
  ${sqlJson(overrides.witnessPolicy ?? { operatorRequired: true, primaryWitnessRequired: true, secondaryWitnessRequired: false, regulatorWitnessRequired: false, minimumWitnessCount: 2 })},
  ${sqlJson({ maxClockSkewSeconds: 300, maxDrawAgeSeconds: 86400, futureTimestampsRejected: true })},
  ${overrides.productionEligible ? "true" : "false"}, ${sqlString(overrides.lifecycle ?? "Active")}, ${sqlString(overrides.failureMode ?? "FailClosed")},
  ${sqlString(hash(`physical-authority:${runId}:${authorityId}:${overrides.lifecycle ?? "Active"}:${JSON.stringify(overrides.witnessPolicy ?? {})}`))}, null
);`;
}

function eventSql(runId, providerId, authorityId, overrides = {}) {
  const drawIdentifier = overrides.drawIdentifier ?? `draw-${runId}`;
  return `
insert into game_engine.physical_draw_events (
  draw_event_id, idempotency_key, draw_identifier, provider_id, provider_version,
  authority_id, authority_version, manifest_id, manifest_version, game_identifier,
  draw_timestamp, scheduled_timestamp, received_timestamp, schema_type,
  normalized_payload, canonical_result_hash, winning_numbers, bonus_numbers, alternate_balls,
  equipment_references, machine_id, ball_set_id, draw_operator, witness_references, media_references,
  video_hash, image_hash, official_report_reference, procedural_evidence_hash, custody_state, content_hash
) values (
  '${randomUUID()}', ${sqlString(`physical-authority-idem:${runId}:${drawIdentifier}`)}, ${sqlString(drawIdentifier)},
  ${sqlString(providerId)}, '1.0.0', ${sqlString(authorityId)}, '1.0.0', 'manifest-physical', '1.0.0', ${sqlString(overrides.game ?? "LOTTO-PHYS")},
  ${overrides.future ? "now() + interval '1 day'" : "now() - interval '2 minutes'"}, now() - interval '5 minutes', now(), ${sqlString(overrides.schema ?? "UNIQUE_NUMBER_SET")},
  ${sqlJson({ resultType: "UniqueNumberSet", numbers: [1, 2, 3, 4, 5] })},
  ${sqlString(hash(`canonical:${runId}:${drawIdentifier}`))}, ${sqlJson([1, 2, 3, 4, 5])}, '[]'::jsonb, '[]'::jsonb,
  ${sqlJson(overrides.equipment ?? [
    { EquipmentId: "machine-alpha", EquipmentType: "DRAW_MACHINE", EquipmentVersion: "machine-v1", LifecycleState: "Active", InspectionReference: "inspection:qa", MaintenanceReference: "maintenance:qa", CalibrationReference: "calibration:qa", SealReference: "seal:qa", Approved: true }
  ])},
  ${sqlString(overrides.machineId ?? "machine-alpha")}, ${sqlString(overrides.ballSetId ?? "ball-set-alpha")}, 'operator-qa',
  ${sqlJson(overrides.witnesses ?? { OperatorIdentity: "operator-qa", PrimaryWitness: "primary-witness-qa" })},
  ${sqlJson(["media:qa"])}, null, null, 'official-report:qa', ${sqlString(hash(`procedure:${runId}`))}, 'Certified',
  ${sqlString(hash(`event:${runId}:${drawIdentifier}`))}
);`;
}

const runId = randomUUID();
const providerId = `physical-authority-provider:${runId}`;
const authorityId = `physical-authority:${runId}`;
insertProvider(runId, providerId);
runSql(authoritySql(runId, authorityId));

const inactiveAuthorityEvent = runSql(`
${authoritySql(`${runId}:inactive`, `${authorityId}:inactive`, { lifecycle: "Suspended" })}
${eventSql(`${runId}:inactive`, providerId, `${authorityId}:inactive`)}
`, { allowFailure: true });
addCheck("inactive authority rejected", inactiveAuthorityEvent.status !== 0, { stderr: inactiveAuthorityEvent.stderr.trim() });

const machineMismatch = runSql(eventSql(`${runId}:machine`, providerId, authorityId, { machineId: "machine-beta" }), { allowFailure: true });
addCheck("equipment machine mismatch rejected", machineMismatch.status !== 0, { stderr: machineMismatch.stderr.trim() });

const retiredEquipment = runSql(eventSql(`${runId}:retired`, providerId, authorityId, {
  equipment: [{ EquipmentId: "machine-alpha", EquipmentType: "DRAW_MACHINE", EquipmentVersion: "machine-v1", LifecycleState: "Retired", InspectionReference: "inspection:qa", MaintenanceReference: "maintenance:qa", CalibrationReference: "calibration:qa", SealReference: "seal:qa", Approved: true }],
}), { allowFailure: true });
addCheck("retired equipment rejected", retiredEquipment.status !== 0, { stderr: retiredEquipment.stderr.trim() });

const missingWitness = runSql(eventSql(`${runId}:witness`, providerId, authorityId, {
  witnesses: { OperatorIdentity: "operator-qa" },
}), { allowFailure: true });
addCheck("missing required witness rejected", missingWitness.status !== 0, { stderr: missingWitness.stderr.trim() });

const wrongGame = runSql(eventSql(`${runId}:game`, providerId, authorityId, { game: "UNSUPPORTED-GAME" }), { allowFailure: true });
addCheck("wrong game rejected", wrongGame.status !== 0, { stderr: wrongGame.stderr.trim() });

const futureTimestamp = runSql(eventSql(`${runId}:future`, providerId, authorityId, { future: true }), { allowFailure: true });
addCheck("draw timestamp policy enforced", futureTimestamp.status !== 0, { stderr: futureTimestamp.stderr.trim() });

runSql(`
insert into game_engine.physical_draw_equipment (
  equipment_event_id, draw_event_id, authority_id, authority_version, equipment_id, equipment_type,
  equipment_version, lifecycle_state, inspection_reference, maintenance_reference, calibration_reference,
  seal_reference, approved, evidence_hash
) values (
  '${randomUUID()}', '${randomUUID()}', ${sqlString(authorityId)}, '1.0.0', 'machine-alpha', 'DRAW_MACHINE',
  'machine-v1', 'Active', 'inspection:qa', 'maintenance:qa', 'calibration:qa', 'seal:qa', true,
  ${sqlString(hash(`equipment:${runId}`))}
);`);
addCheck("approved active equipment evidence persists", queryScalar(`
select count(*) = 1
from game_engine.physical_draw_equipment
where authority_id = ${sqlString(authorityId)}
  and approved = true
  and lifecycle_state = 'Active';
`) === "t");

const invalidEquipmentEvidence = runSql(`
insert into game_engine.physical_draw_equipment (
  equipment_event_id, draw_event_id, authority_id, authority_version, equipment_id, equipment_type,
  equipment_version, lifecycle_state, inspection_reference, maintenance_reference, calibration_reference,
  seal_reference, approved, evidence_hash
) values (
  '${randomUUID()}', '${randomUUID()}', ${sqlString(authorityId)}, '1.0.0', 'machine-alpha', 'DRAW_MACHINE',
  'machine-v1', 'Retired', 'inspection:qa', 'maintenance:qa', 'calibration:qa', 'seal:qa', true,
  ${sqlString(hash(`equipment-invalid:${runId}`))}
);`, { allowFailure: true });
addCheck("retired equipment evidence rejected", invalidEquipmentEvidence.status !== 0, { stderr: invalidEquipmentEvidence.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });

if (failed.length > 0) {
  process.exit(1);
}
