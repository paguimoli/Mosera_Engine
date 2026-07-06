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

function existsRegclass(name) {
  return queryScalar(`select to_regclass('${name}') is not null;`) === "t";
}

function rowCount(sql) {
  return Number(queryScalar(sql));
}

function strategyInsertSql({ strategyId, contentHash }) {
  return `
insert into game_engine.outcome_strategy_definitions (
  id, strategy_id, strategy_version, primitive_graph, input_schema, output_schema,
  constraints, jurisdiction_profile_references, lifecycle_state, content_hash,
  certification_binding_placeholder, signature_metadata
) values (
  '${randomUUID()}',
  ${sqlString(strategyId)},
  '1.0.0',
  ${sqlJson([{
    nodeId: "draw-numbers",
    primitiveType: "UniqueNumberSet",
    dependsOn: [],
    minNumber: 1,
    maxNumber: 80,
    count: 20,
  }])},
  ${sqlJson({ drawId: "uuid" })},
  ${sqlJson({ resultType: "number-set" })},
  ${sqlJson({ maxAttempts: 1 })},
  ${sqlJson([])},
  'GovernanceApproved',
  ${sqlString(contentHash)},
  'outcome-operational-controls-placeholder',
  ${sqlJson({ signingKeyId: "qa-signing-key", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa-signature" })}
);`;
}

function rngProviderInsertSql({ providerId, contentHash }) {
  return `
insert into game_engine.rng_provider_definitions (
  id, provider_id, provider_version, provider_type, production_eligible,
  certification_state, algorithm_references, entropy_source_metadata,
  health_test_capabilities, failure_mode, content_hash, signature_metadata
) values (
  '${randomUUID()}',
  ${sqlString(providerId)},
  '1.0.0',
  'TEST_DETERMINISTIC',
  false,
  'InternalVerified',
  ${sqlJson(["deterministic-test-v1"])},
  ${sqlJson({ source: "qa-deterministic" })},
  ${sqlJson(["deterministic-sequence-check"])},
  'FailClosed',
  ${sqlString(contentHash)},
  ${sqlJson({ signingKeyId: "qa-signing-key", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa-signature" })}
);`;
}

function rngEvidenceInsertSql({ providerId, evidenceHash }) {
  return `
insert into game_engine.rng_provider_evidence (
  evidence_id, provider_id, provider_version, entropy_source_reference,
  health_test_result, known_answer_test_result, continuous_test_result,
  generated_at, canonical_evidence_hash, signing_metadata
) values (
  '${randomUUID()}',
  ${sqlString(providerId)},
  '1.0.0',
  'entropy-source:qa-deterministic',
  'Passed',
  'NotApplicable',
  'Passed',
  now(),
  ${sqlString(evidenceHash)},
  ${sqlJson({ signingKeyId: "qa-signing-key", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa-signature" })}
);`;
}

function outcomeEventInsertSql({ outcomeId, requestId, drawId, strategyId, providerId, evidenceHash, outcomeHash, idempotencyKey }) {
  return `
insert into game_engine.outcome_events (
  outcome_id, request_id, draw_id, game_manifest_reference, strategy_id,
  strategy_version, rng_provider_id, rng_provider_version, rng_evidence_hash,
  idempotency_key, outcome_mode, outcome_payload, canonical_outcome_hash,
  generated_at
) values (
  '${outcomeId}',
  '${requestId}',
  '${drawId}',
  'game-manifest:qa-operational-controls',
  ${sqlString(strategyId)},
  '1.0.0',
  ${sqlString(providerId)},
  '1.0.0',
  ${sqlString(evidenceHash)},
  ${sqlString(idempotencyKey)},
  'DryRun',
  ${sqlJson({ numbers: [1, 2, 3, 4, 5] })},
  ${sqlString(outcomeHash)},
  now()
);`;
}

function outcomeCertificateInsertSql({ certificateId, outcomeId, drawId, strategyId, providerId, evidenceHash, outcomeHash }) {
  return `
insert into game_engine.outcome_certificates (
  certificate_id, outcome_id, draw_id, strategy_id, strategy_version,
  rng_provider_id, rng_provider_version, canonical_outcome_hash,
  evidence_hash_reference, previous_certificates, signing_metadata,
  custody_state, issued_at
) values (
  '${certificateId}',
  '${outcomeId}',
  '${drawId}',
  ${sqlString(strategyId)},
  '1.0.0',
  ${sqlString(providerId)},
  '1.0.0',
  ${sqlString(outcomeHash)},
  ${sqlString(evidenceHash)},
  ${sqlJson([])},
  ${sqlJson({ signingKeyId: "qa-signing-key", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "placeholder-v1", signature: "qa-signature" })},
  'Generated',
  now()
);`;
}

function controlInsertSql({
  controlId = randomUUID(),
  controlType,
  targetArtifactType = "OutcomeCertificate",
  targetArtifactId,
  reasonCode = "QA_OPERATIONAL_CONTROL",
  requestedBy = "qa-requester",
  approvedBy = "qa-approver",
  dualApprovalStatus = "Approved",
  productionAffecting = true,
  expiresAt = null,
  originalOutcomeCertificateId = null,
  evidenceHash,
  auditEvidence = { reason: "qa evidence" },
}) {
  return `
insert into game_engine.outcome_operational_controls (
  control_id, control_type, target_artifact_type, target_artifact_id,
  reason_code, requested_by, approved_by, dual_approval_status,
  production_affecting, effective_at, expires_at, original_outcome_certificate_id,
  evidence_hash, audit_evidence, signing_metadata
) values (
  '${controlId}',
  ${sqlString(controlType)},
  ${sqlString(targetArtifactType)},
  ${sqlString(targetArtifactId)},
  ${sqlString(reasonCode)},
  ${sqlString(requestedBy)},
  ${approvedBy === null ? "null" : sqlString(approvedBy)},
  ${sqlString(dualApprovalStatus)},
  ${productionAffecting ? "true" : "false"},
  now(),
  ${expiresAt === null ? "null" : sqlString(expiresAt)},
  ${originalOutcomeCertificateId === null ? "null" : `'${originalOutcomeCertificateId}'`},
  ${sqlString(evidenceHash)},
  ${sqlJson(auditEvidence)},
  ${sqlJson({ signingKeyId: "placeholder", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "placeholder-v1", signature: "placeholder" })}
);`;
}

function custodyEventInsertSql({
  custodyEventId = randomUUID(),
  certificateId,
  fromState = "Generated",
  toState,
  controlId = null,
  evidenceHash,
  reasonCode = "QA_CUSTODY_TRANSITION",
}) {
  return `
insert into game_engine.outcome_custody_events (
  custody_event_id, outcome_certificate_id, from_state, to_state,
  control_id, reason_code, evidence_hash, signing_metadata
) values (
  '${custodyEventId}',
  '${certificateId}',
  ${fromState === null ? "null" : sqlString(fromState)},
  ${sqlString(toState)},
  ${controlId === null ? "null" : `'${controlId}'`},
  ${sqlString(reasonCode)},
  ${sqlString(evidenceHash)},
  ${sqlJson({ signingKeyId: "placeholder", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "placeholder-v1", signature: "placeholder" })}
);`;
}

const runId = randomUUID();
const strategyId = `outcome-strategy:p0-005-11:${runId}`;
const providerId = `rng-provider:p0-005-11:${runId}`;
const strategyHash = `sha256:p0-005-11-strategy:${runId}`;
const providerHash = `sha256:p0-005-11-rng:${runId}`;
const evidenceHash = `sha256:p0-005-11-rng-evidence:${runId}`;
const outcomeHash = `sha256:p0-005-11-outcome:${runId}`;
const outcomeId = randomUUID();
const requestId = randomUUID();
const drawId = randomUUID();
const certificateId = randomUUID();
const ledgerBefore = rowCount("select count(*) from public.financial_ledger_entries;");

addCheck("outcome operational control table exists", existsRegclass("game_engine.outcome_operational_controls"));
addCheck("outcome custody event table exists", existsRegclass("game_engine.outcome_custody_events"));

runSql(strategyInsertSql({ strategyId, contentHash: strategyHash }));
runSql(rngProviderInsertSql({ providerId, contentHash: providerHash }));
runSql(rngEvidenceInsertSql({ providerId, evidenceHash }));
runSql(outcomeEventInsertSql({
  outcomeId,
  requestId,
  drawId,
  strategyId,
  providerId,
  evidenceHash,
  outcomeHash,
  idempotencyKey: `outcome-operational-controls:${runId}`,
}));
runSql(outcomeCertificateInsertSql({
  certificateId,
  outcomeId,
  drawId,
  strategyId,
  providerId,
  evidenceHash,
  outcomeHash,
}));

const emergencyControlId = randomUUID();
const emergencyHash = `sha256:p0-005-11-emergency:${runId}`;
runSql(controlInsertSql({
  controlId: emergencyControlId,
  controlType: "EMERGENCY_DISABLE",
  targetArtifactType: "Draw",
  targetArtifactId: String(drawId),
  reasonCode: "EMERGENCY_DISABLE_QA",
  expiresAt: "2099-01-01T00:00:00Z",
  evidenceHash: emergencyHash,
  auditEvidence: { operatorReason: "qa emergency disable", expiresAt: "2099-01-01T00:00:00Z" },
}));
addCheck(
  "valid emergency disable persists",
  rowCount(`
select count(*)
from game_engine.outcome_operational_controls
where control_id = '${emergencyControlId}'
  and control_type = 'EMERGENCY_DISABLE'
  and dual_approval_status = 'Approved'
  and evidence_hash = ${sqlString(emergencyHash)};
`) === 1,
  { emergencyControlId },
);

const missingApproval = runSql(controlInsertSql({
  controlType: "DRAW_CANCEL",
  targetArtifactType: "Draw",
  targetArtifactId: String(drawId),
  approvedBy: null,
  dualApprovalStatus: "Requested",
  evidenceHash: `sha256:p0-005-11-missing-approval:${runId}`,
}), { allowFailure: true });
addCheck("missing dual approval rejected for production-affecting control", missingApproval.status !== 0, {
  stderr: missingApproval.stderr.trim(),
});

const missingOriginal = runSql(controlInsertSql({
  controlType: "OUTCOME_SUPERSEDE",
  targetArtifactId: String(certificateId),
  evidenceHash: `sha256:p0-005-11-missing-original:${runId}`,
}), { allowFailure: true });
addCheck("supersession requires original certificate reference", missingOriginal.status !== 0, {
  stderr: missingOriginal.stderr.trim(),
});

const voidControlId = randomUUID();
runSql(controlInsertSql({
  controlId: voidControlId,
  controlType: "OUTCOME_VOID",
  targetArtifactId: String(certificateId),
  reasonCode: "OUTCOME_VOID_QA",
  evidenceHash: `sha256:p0-005-11-void:${runId}`,
  auditEvidence: { auditCaseId: `void:${runId}`, notes: "void evidence" },
}));

const replayControlId = randomUUID();
runSql(controlInsertSql({
  controlId: replayControlId,
  controlType: "OUTCOME_REPLAY",
  targetArtifactId: String(certificateId),
  reasonCode: "OUTCOME_REPLAY_QA",
  evidenceHash: `sha256:p0-005-11-replay:${runId}`,
  auditEvidence: { auditCaseId: `replay:${runId}`, replayFixture: "fixture-placeholder" },
}));
addCheck(
  "void/replay evidence persists",
  rowCount(`
select count(*)
from game_engine.outcome_operational_controls
where control_id in ('${voidControlId}', '${replayControlId}')
  and audit_evidence <> '{}'::jsonb;
`) === 2,
  { voidControlId, replayControlId },
);

runSql(custodyEventInsertSql({
  certificateId,
  toState: "Sealed",
  evidenceHash: `sha256:p0-005-11-custody-sealed:${runId}`,
}));
addCheck(
  "custody transition validates allowed states",
  rowCount(`
select count(*)
from game_engine.outcome_custody_events
where outcome_certificate_id = '${certificateId}'
  and from_state = 'Generated'
  and to_state = 'Sealed';
`) === 1,
  { certificateId },
);

const invalidTransition = runSql(custodyEventInsertSql({
  certificateId,
  toState: "Superseded",
  evidenceHash: `sha256:p0-005-11-invalid-transition:${runId}`,
}), { allowFailure: true });
addCheck("invalid transition rejected", invalidTransition.status !== 0, { stderr: invalidTransition.stderr.trim() });

runSql(custodyEventInsertSql({
  certificateId,
  toState: "Voided",
  controlId: voidControlId,
  evidenceHash: `sha256:p0-005-11-custody-voided:${runId}`,
}));
addCheck(
  "void custody evidence persists",
  rowCount(`
select count(*)
from game_engine.outcome_custody_events
where outcome_certificate_id = '${certificateId}'
  and control_id = '${voidControlId}'
  and to_state = 'Voided';
`) === 1,
);

const updateControl = runSql(
  `update game_engine.outcome_operational_controls set reason_code = 'MUTATION' where control_id = '${emergencyControlId}';`,
  { allowFailure: true },
);
addCheck("operational control update blocked", updateControl.status !== 0, { stderr: updateControl.stderr.trim() });

const deleteCustody = runSql(
  `delete from game_engine.outcome_custody_events where outcome_certificate_id = '${certificateId}';`,
  { allowFailure: true },
);
addCheck("custody event delete blocked", deleteCustody.status !== 0, { stderr: deleteCustody.stderr.trim() });

const financialControl = runSql(controlInsertSql({
  controlType: "OUTCOME_REPLAY",
  targetArtifactId: String(certificateId),
  evidenceHash: `sha256:p0-005-11-financial-control:${runId}`,
  auditEvidence: { ledgerEntry: "not-allowed" },
}), { allowFailure: true });
addCheck("financial effects rejected from controls", financialControl.status !== 0, {
  stderr: financialControl.stderr.trim(),
});

const ledgerAfter = rowCount("select count(*) from public.financial_ledger_entries;");
addCheck("no ledger/financial effects created", ledgerAfter === ledgerBefore, { before: ledgerBefore, after: ledgerAfter });

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
