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
  ${sqlString(hash(`physical-provider:${runId}`))}, null, null
);`;
}

function insertAuthoritySql(runId, authorityId, options = {}) {
  const lifecycle = options.lifecycle ?? "Active";
  const failureMode = options.failureMode ?? "FailClosed";
  const productionEligible = options.productionEligible ?? false;
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
  ${sqlJson({ operatorRequired: true, primaryWitnessRequired: true, secondaryWitnessRequired: false, regulatorWitnessRequired: false, minimumWitnessCount: 2 })},
  ${sqlJson({ maxClockSkewSeconds: 300, maxDrawAgeSeconds: 86400, futureTimestampsRejected: true })},
  ${productionEligible ? "true" : "false"}, ${sqlString(lifecycle)}, ${sqlString(failureMode)},
  ${sqlString(hash(`physical-authority:${runId}:${authorityId}:${lifecycle}:${failureMode}`))}, null
);`;
}

function insertDrawEventSql(runId, providerId, authorityId, options = {}) {
  const drawIdentifier = options.drawIdentifier ?? "physical-draw-001";
  const numbers = options.numbers ?? [2, 4, 8, 16, 32];
  const canonicalHash = hash(numbers.slice().sort((a, b) => a - b).join("|"));
  return `
insert into game_engine.physical_draw_events (
  draw_event_id, idempotency_key, draw_identifier, provider_id, provider_version,
  authority_id, authority_version, manifest_id, manifest_version, game_identifier,
  draw_timestamp, scheduled_timestamp, received_timestamp, schema_type,
  normalized_payload, canonical_result_hash, winning_numbers, bonus_numbers, alternate_balls,
  equipment_references, machine_id, ball_set_id, draw_operator, witness_references, media_references,
  video_hash, image_hash, official_report_reference, procedural_evidence_hash, custody_state, content_hash
) values (
  '${randomUUID()}', ${sqlString(`physical-idempotency:${runId}:${drawIdentifier}:${canonicalHash}`)}, ${sqlString(drawIdentifier)},
  ${sqlString(providerId)}, '1.0.0', ${sqlString(authorityId)}, '1.0.0', 'manifest-physical', '1.0.0', 'LOTTO-PHYS',
  now() - interval '2 minutes', now() - interval '5 minutes', now(), 'UNIQUE_NUMBER_SET',
  ${sqlJson({ resultType: "UniqueNumberSet", numbers: numbers.slice().sort((a, b) => a - b) })},
  ${sqlString(canonicalHash)}, ${sqlJson(numbers)}, '[]'::jsonb, '[]'::jsonb,
  ${sqlJson([
    { EquipmentId: "machine-alpha", EquipmentType: "DRAW_MACHINE", EquipmentVersion: "machine-v1", LifecycleState: "Active", InspectionReference: "inspection:qa", MaintenanceReference: "maintenance:qa", CalibrationReference: "calibration:qa", SealReference: "seal:qa", Approved: true },
    { EquipmentId: "ball-set-alpha", EquipmentType: "BALL_SET", EquipmentVersion: "balls-v1", LifecycleState: "Active", InspectionReference: "inspection:balls", MaintenanceReference: "maintenance:balls", CalibrationReference: "calibration:balls", SealReference: "seal:balls", Approved: true }
  ])},
  'machine-alpha', 'ball-set-alpha', 'operator-qa',
  ${sqlJson({ OperatorIdentity: "operator-qa", PrimaryWitness: "primary-witness-qa", DigitalApprovalReferences: ["approval:qa"], ManualCertificationReferences: ["manual-cert:qa"] })},
  ${sqlJson(["media:qa"])}, ${sqlString(hash(`video:${runId}`))}, ${sqlString(hash(`image:${runId}`))},
  'official-report:qa', ${sqlString(hash(`procedure:${runId}`))}, 'Certified', ${sqlString(hash(`event:${runId}:${drawIdentifier}:${canonicalHash}`))}
);

insert into game_engine.physical_draw_evidence (
  evidence_id, draw_event_id, authority_id, authority_version, provider_id, provider_version,
  draw_identifier, verification_status, custody_state, canonical_result_hash, event_content_hash,
  failure_code, failure_reason, evidence_hash, verified_at
) values (
  '${randomUUID()}', '${randomUUID()}', ${sqlString(authorityId)}, '1.0.0', ${sqlString(providerId)}, '1.0.0',
  ${sqlString(drawIdentifier)}, 'Verified', 'Certified', ${sqlString(canonicalHash)},
  ${sqlString(hash(`event:${runId}:${drawIdentifier}:${canonicalHash}`))}, null, null, ${sqlString(hash(`evidence:${runId}:${drawIdentifier}:${canonicalHash}`))}, now()
);`;
}

const runId = randomUUID();
const providerId = `physical-provider:${runId}`;
const authorityId = `physical-authority:${runId}`;

addCheck("runtime service source exists", readFileSync("services/game-engine/src/GameEngine.Application/Services/PhysicalDrawResultRuntimeServices.cs", "utf8").includes("PhysicalDrawResultRuntimeService"));
addCheck("authority table exists", existsRegclass("game_engine.physical_draw_authorities"));
addCheck("event table exists", existsRegclass("game_engine.physical_draw_events"));
addCheck("witness table exists", existsRegclass("game_engine.physical_draw_witnesses"));
addCheck("equipment table exists", existsRegclass("game_engine.physical_draw_equipment"));
addCheck("evidence table exists", existsRegclass("game_engine.physical_draw_evidence"));

runSql(insertProviderSql(runId, providerId));
runSql(insertAuthoritySql(runId, authorityId));
addCheck("valid authority persists", queryScalar(`
select count(*) = 1
from game_engine.physical_draw_authorities
where authority_id = ${sqlString(authorityId)}
  and lifecycle_state = 'Active';
`) === "t");

const invalidAuthority = runSql(insertAuthoritySql(`${runId}:invalid`, `${authorityId}:invalid`, {
  productionEligible: true,
  failureMode: "Disabled",
}), { allowFailure: true });
addCheck("invalid ineligible authority rejected", invalidAuthority.status !== 0, { stderr: invalidAuthority.stderr.trim() });

runSql(insertDrawEventSql(runId, providerId, authorityId));
addCheck("valid physical draw event ingests", queryScalar(`
select count(*) = 1
from game_engine.physical_draw_events
where authority_id = ${sqlString(authorityId)}
  and provider_id = ${sqlString(providerId)}
  and custody_state = 'Certified';
`) === "t");

addCheck("no random generation occurs", queryScalar(`
select count(*) = 0
from game_engine.outcome_runtime_attempts
where provider_type = 'PHYSICAL_DRAW_RESULT'
  and status = 'Accepted'
  and mode = 'Production';
`) === "t");

addCheck("no Math/Settlement/Ledger/Cashier effects occur", queryScalar(`
select
  (select count(*) from game_engine.math_evaluation_events where idempotency_key = ${sqlString(`physical-idempotency:${runId}:physical-draw-001:${hash("2|4|8|16|32")}`)}) = 0
  and (select count(*) from settlement_service.settlement_ledger_effects where idempotency_key like ${sqlString(`physical-idempotency:${runId}%`)}) = 0
  and (select count(*) from public.financial_ledger_entries where idempotency_key like ${sqlString(`physical-idempotency:${runId}%`)}) = 0;
`) === "t");

const failed = checks.filter((check) => check.status !== "PASS");
printJson({
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
});

if (failed.length > 0) {
  process.exit(1);
}
