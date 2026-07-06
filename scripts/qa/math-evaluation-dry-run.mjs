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

function runSql(sql, options = {}) {
  return runPsql(["-q", "-c", sql], options);
}

function existsRegclass(name) {
  return queryScalar(`select to_regclass('${name}') is not null;`) === "t";
}

function rowCount(sql) {
  return Number(queryScalar(sql));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function strategyInsertSql(strategyId, contentHash) {
  return `
insert into game_engine.outcome_strategy_definitions (
  id, strategy_id, strategy_version, primitive_graph, input_schema, output_schema, constraints,
  jurisdiction_profile_references, lifecycle_state, content_hash, certification_binding_placeholder, signature_metadata
) values (
  '${randomUUID()}',
  ${sqlString(strategyId)},
  '1.0.0',
  ${sqlJson([{ nodeId: "numbers", primitiveType: "UniqueNumberSet", dependsOn: [], minNumber: 1, maxNumber: 20, count: 5, numbers: [1, 2, 3, 4, 5] }])},
  ${sqlJson({ drawId: "uuid" })},
  ${sqlJson({ resultType: "dry-run" })},
  ${sqlJson({})},
  ${sqlJson([])},
  'GovernanceApproved',
  ${sqlString(contentHash)},
  'outcome-strategy-cert-placeholder',
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa" })}
);`;
}

function rngProviderInsertSql(providerId, contentHash) {
  return `
insert into game_engine.rng_provider_definitions (
  id, provider_id, provider_version, provider_type, production_eligible, certification_state,
  algorithm_references, entropy_source_metadata, health_test_capabilities, failure_mode, content_hash, signature_metadata
) values (
  '${randomUUID()}',
  ${sqlString(providerId)},
  '1.0.0',
  'TEST_DETERMINISTIC',
  false,
  'InternalVerified',
  ${sqlJson(["deterministic-test-v1"])},
  ${sqlJson({ seedPolicy: "idempotency-derived" })},
  ${sqlJson(["deterministic-health-check"])},
  'FailClosed',
  ${sqlString(contentHash)},
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa" })}
);`;
}

function rngEvidenceInsertSql(providerId, evidenceHash) {
  return `
insert into game_engine.rng_provider_evidence (
  evidence_id, provider_id, provider_version, entropy_source_reference, health_test_result,
  known_answer_test_result, continuous_test_result, generated_at, canonical_evidence_hash, signing_metadata
) values (
  '${randomUUID()}',
  ${sqlString(providerId)},
  '1.0.0',
  'entropy-source:deterministic-test',
  'Passed',
  'NotApplicable',
  'Passed',
  now(),
  ${sqlString(evidenceHash)},
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa" })}
);`;
}

function outcomeEventInsertSql({ outcomeId, drawId, manifestReference, strategyId, providerId, evidenceHash, idempotencyKey, outcomePayload, outcomeHash }) {
  return `
insert into game_engine.outcome_events (
  outcome_id, request_id, draw_id, game_manifest_reference, strategy_id, strategy_version,
  rng_provider_id, rng_provider_version, rng_evidence_hash, idempotency_key, outcome_mode,
  outcome_payload, canonical_outcome_hash, generated_at
) values (
  '${outcomeId}',
  '${randomUUID()}',
  '${drawId}',
  ${sqlString(manifestReference)},
  ${sqlString(strategyId)},
  '1.0.0',
  ${sqlString(providerId)},
  '1.0.0',
  ${sqlString(evidenceHash)},
  ${sqlString(idempotencyKey)},
  'DryRun',
  ${sqlJson(outcomePayload)},
  ${sqlString(outcomeHash)},
  now()
);`;
}

function outcomeCertificateInsertSql({ certificateId, outcomeId, drawId, strategyId, providerId, evidenceHash, outcomeHash }) {
  return `
insert into game_engine.outcome_certificates (
  certificate_id, outcome_id, draw_id, strategy_id, strategy_version, rng_provider_id, rng_provider_version,
  canonical_outcome_hash, evidence_hash_reference, previous_certificates, signing_metadata, custody_state, issued_at
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
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "placeholder-v1", signature: "qa" })},
  'Generated',
  now()
);`;
}

function mathModelInsertSql({ mathModelId, contentHash }) {
  return `
insert into game_engine.math_model_definitions (
  id, math_model_id, version, game_family_compatibility, supported_wager_schemas, expected_rtp,
  expected_value, volatility_profile, hit_frequency, prize_liability_profile, jackpot_contribution_model,
  rounding_policy, currency_minor_unit_policy, jurisdiction_profile_references, rtp_policy_constraints,
  lifecycle_state, content_hash, certification_binding_state, signature_metadata
) values (
  '${randomUUID()}',
  ${sqlString(mathModelId)},
  '1.0.0',
  ${sqlJson(["Lottery"])},
  ${sqlJson(["straight-v1"])},
  0.92,
  -0.08,
  'Medium',
  0.18,
  ${sqlJson({ maxExposureMultiple: 100 })},
  ${sqlJson({ contributionBasisPoints: 50 })},
  ${sqlJson({ mode: "bankers" })},
  ${sqlJson({ currency: "USD", minorUnit: 2 })},
  null::jsonb,
  null::jsonb,
  'GovernanceApproved',
  ${sqlString(contentHash)},
  'InternalVerified',
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa" })}
);`;
}

function paytableInsertSql({ paytableId, mathModelId, contentHash }) {
  return `
insert into game_engine.paytable_definitions (
  id, paytable_id, version, math_model_id, math_model_version, prize_matrix_rows,
  bonus_side_bet_rows, caps, jurisdiction_profile_references, lifecycle_state, content_hash,
  certification_binding_state, signature_metadata
) values (
  '${randomUUID()}',
  ${sqlString(paytableId)},
  '1.0.0',
  ${sqlString(mathModelId)},
  '1.0.0',
  ${sqlJson([{ rowId: "match-5", wagerSchema: "straight-v1", prizeCode: "MATCH_5", multiplier: 100, payoutValue: 0, maxPayout: 10000, conditions: { matchCount: 5 } }])},
  ${sqlJson([])},
  ${sqlJson({ maxPayout: 10000 })},
  null::jsonb,
  'GovernanceApproved',
  ${sqlString(contentHash)},
  'InternalVerified',
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa" })}
);`;
}

function mathEvaluationEventInsertSql({
  mathEvaluationId,
  requestId = randomUUID(),
  outcomeCertificateId,
  outcomeCertificateHash,
  manifestReference,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  ticketReference,
  wagerPayload,
  prizeFacts,
  prizeFactsHash,
  idempotencyKey,
  evaluationMode = "DryRun",
  onConflict = "",
}) {
  return `
insert into game_engine.math_evaluation_events (
  math_evaluation_id, request_id, outcome_certificate_id, outcome_certificate_hash, game_manifest_reference,
  math_model_id, math_model_version, math_model_hash, paytable_id, paytable_version, paytable_hash,
  ticket_reference, wager_payload, prize_facts, canonical_prize_facts_hash, idempotency_key,
  evaluation_mode, evaluated_at
) values (
  '${mathEvaluationId}',
  '${requestId}',
  '${outcomeCertificateId}',
  ${sqlString(outcomeCertificateHash)},
  ${sqlString(manifestReference)},
  ${sqlString(mathModelId)},
  '1.0.0',
  ${sqlString(mathModelHash)},
  ${sqlString(paytableId)},
  '1.0.0',
  ${sqlString(paytableHash)},
  ${sqlString(ticketReference)},
  ${sqlJson(wagerPayload)},
  ${sqlJson(prizeFacts)},
  ${sqlString(prizeFactsHash)},
  ${sqlString(idempotencyKey)},
  ${sqlString(evaluationMode)},
  now()
) ${onConflict};`;
}

function mathEvaluationCertificateInsertSql({
  certificateId,
  mathEvaluationId,
  outcomeCertificateId,
  outcomeCertificateHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  ticketReference,
  prizeFactsHash,
}) {
  return `
insert into game_engine.math_evaluation_certificates (
  certificate_id, math_evaluation_id, outcome_certificate_id, outcome_certificate_hash,
  math_model_id, math_model_version, math_model_hash, paytable_id, paytable_version,
  paytable_hash, ticket_reference, canonical_prize_facts_hash, rtp_math_metadata_reference,
  signing_metadata, issued_at
) values (
  '${certificateId}',
  '${mathEvaluationId}',
  '${outcomeCertificateId}',
  ${sqlString(outcomeCertificateHash)},
  ${sqlString(mathModelId)},
  '1.0.0',
  ${sqlString(mathModelHash)},
  ${sqlString(paytableId)},
  '1.0.0',
  ${sqlString(paytableHash)},
  ${sqlString(ticketReference)},
  ${sqlString(prizeFactsHash)},
  ${sqlString(`math-model:${mathModelId}:1.0.0:${mathModelHash}`)},
  ${sqlJson({ signingKeyId: "placeholder-signing-key", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "placeholder-v1", signature: "placeholder-signature" })},
  now()
);`;
}

const runId = randomUUID();
const manifestReference = `game-manifest:p0-005-7:${runId}:1.0.0`;
const strategyId = `outcome-strategy:p0-005-7:${runId}`;
const providerId = `rng-provider:p0-005-7:${runId}`;
const mathModelId = `math-model:p0-005-7:${runId}`;
const paytableId = `paytable:p0-005-7:${runId}`;
const evidenceHash = `sha256:p0-005-7-evidence:${runId}`;
const mathModelHash = `sha256:p0-005-7-math:${runId}`;
const paytableHash = `sha256:p0-005-7-paytable:${runId}`;
const outcomeId = randomUUID();
const outcomeCertificateId = randomUUID();
const drawId = randomUUID();
const outcomePayload = { numbers: [1, 2, 3, 4, 5] };
const outcomeHash = sha256(JSON.stringify(outcomePayload));
const mathEvaluationId = randomUUID();
const mathCertificateId = randomUUID();
const ticketReference = `ticket:p0-005-7:${runId}`;
const idempotencyKey = `math-evaluation:${runId}`;
const wagerPayload = { numbers: [1, 2, 3, 4, 5], stakeUnits: 1 };
const prizeFacts = {
  outcome: "Win",
  prizeTier: "MATCH_5",
  multiplier: 100,
  payoutUnits: 0,
  outcomeDerivedFacts: { matchCount: 5, selectedNumbers: [1, 2, 3, 4, 5], drawnNumbers: [1, 2, 3, 4, 5] },
};
const prizeFactsHash = sha256(JSON.stringify(prizeFacts));

addCheck("math evaluation event table exists", existsRegclass("game_engine.math_evaluation_events"));
addCheck("math evaluation certificate table exists", existsRegclass("game_engine.math_evaluation_certificates"));

const ledgerCountBefore = rowCount("select count(*) from public.financial_ledger_entries;");

runSql(strategyInsertSql(strategyId, `sha256:p0-005-7-strategy:${runId}`));
runSql(rngProviderInsertSql(providerId, `sha256:p0-005-7-provider:${runId}`));
runSql(rngEvidenceInsertSql(providerId, evidenceHash));
runSql(outcomeEventInsertSql({
  outcomeId,
  drawId,
  manifestReference,
  strategyId,
  providerId,
  evidenceHash,
  idempotencyKey: `outcome:${runId}`,
  outcomePayload,
  outcomeHash,
}));
runSql(outcomeCertificateInsertSql({
  certificateId: outcomeCertificateId,
  outcomeId,
  drawId,
  strategyId,
  providerId,
  evidenceHash,
  outcomeHash,
}));
runSql(mathModelInsertSql({ mathModelId, contentHash: mathModelHash }));
runSql(paytableInsertSql({ paytableId, mathModelId, contentHash: paytableHash }));

runSql(mathEvaluationEventInsertSql({
  mathEvaluationId,
  outcomeCertificateId,
  outcomeCertificateHash: outcomeHash,
  manifestReference,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  ticketReference,
  wagerPayload,
  prizeFacts,
  prizeFactsHash,
  idempotencyKey,
}));
runSql(mathEvaluationCertificateInsertSql({
  certificateId: mathCertificateId,
  mathEvaluationId,
  outcomeCertificateId,
  outcomeCertificateHash: outcomeHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  ticketReference,
  prizeFactsHash,
}));

addCheck(
  "dry-run math evaluation succeeds",
  rowCount(`
select count(*)
from game_engine.math_evaluation_events
where math_evaluation_id = '${mathEvaluationId}'
  and evaluation_mode = 'DryRun'
  and canonical_prize_facts_hash = ${sqlString(prizeFactsHash)};
`) === 1,
  { mathEvaluationId, prizeFactsHash },
);

addCheck(
  "certificate persisted",
  rowCount(`
select count(*)
from game_engine.math_evaluation_certificates
where certificate_id = '${mathCertificateId}'
  and math_evaluation_id = '${mathEvaluationId}'
  and outcome_certificate_id = '${outcomeCertificateId}';
`) === 1,
  { mathCertificateId },
);

runSql(mathEvaluationEventInsertSql({
  mathEvaluationId: randomUUID(),
  outcomeCertificateId,
  outcomeCertificateHash: outcomeHash,
  manifestReference,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  ticketReference,
  wagerPayload,
  prizeFacts: { outcome: "Loss", prizeTier: "NO_PRIZE", multiplier: 0, payoutUnits: 0 },
  prizeFactsHash: sha256(JSON.stringify({ outcome: "Loss" })),
  idempotencyKey,
  onConflict: "on conflict (idempotency_key) do nothing",
}));
addCheck(
  "duplicate idempotency returns same evaluation certificate",
  rowCount(`
select count(*)
from game_engine.math_evaluation_events mee
join game_engine.math_evaluation_certificates mec on mec.math_evaluation_id = mee.math_evaluation_id
where mee.idempotency_key = ${sqlString(idempotencyKey)}
  and mee.math_evaluation_id = '${mathEvaluationId}'
  and mec.certificate_id = '${mathCertificateId}';
`) === 1,
  { idempotencyKey, mathEvaluationId, mathCertificateId },
);

addCheck(
  "prize facts hash lookup works",
  rowCount(`
select count(*)
from game_engine.math_evaluation_events mee
join game_engine.math_evaluation_certificates mec on mec.math_evaluation_id = mee.math_evaluation_id
where mee.outcome_certificate_id = '${outcomeCertificateId}'
  and mee.math_model_id = ${sqlString(mathModelId)}
  and mee.paytable_id = ${sqlString(paytableId)}
  and mee.ticket_reference = ${sqlString(ticketReference)}
  and mee.canonical_prize_facts_hash = ${sqlString(prizeFactsHash)}
  and mec.certificate_id = '${mathCertificateId}';
`) === 1,
  { prizeFactsHash },
);

const productionMode = runSql(mathEvaluationEventInsertSql({
  mathEvaluationId: randomUUID(),
  outcomeCertificateId,
  outcomeCertificateHash: outcomeHash,
  manifestReference,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  ticketReference: `${ticketReference}:prod`,
  wagerPayload,
  prizeFacts,
  prizeFactsHash: sha256(JSON.stringify({ production: "disabled" })),
  idempotencyKey: `${idempotencyKey}:production`,
  evaluationMode: "ProductionDisabled",
}), { allowFailure: true });
addCheck("production mode rejected", productionMode.status !== 0, { stderr: productionMode.stderr.trim() });

const invalidOutcome = runSql(mathEvaluationEventInsertSql({
  mathEvaluationId: randomUUID(),
  outcomeCertificateId: randomUUID(),
  outcomeCertificateHash: outcomeHash,
  manifestReference,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  ticketReference: `${ticketReference}:bad-outcome`,
  wagerPayload,
  prizeFacts,
  prizeFactsHash: sha256(JSON.stringify({ invalid: "outcome" })),
  idempotencyKey: `${idempotencyKey}:bad-outcome`,
}), { allowFailure: true });
addCheck("invalid outcome certificate rejected", invalidOutcome.status !== 0, { stderr: invalidOutcome.stderr.trim() });

const invalidMath = runSql(mathEvaluationEventInsertSql({
  mathEvaluationId: randomUUID(),
  outcomeCertificateId,
  outcomeCertificateHash: outcomeHash,
  manifestReference,
  mathModelId: `${mathModelId}:missing`,
  mathModelHash,
  paytableId,
  paytableHash,
  ticketReference: `${ticketReference}:bad-math`,
  wagerPayload,
  prizeFacts,
  prizeFactsHash: sha256(JSON.stringify({ invalid: "math" })),
  idempotencyKey: `${idempotencyKey}:bad-math`,
}), { allowFailure: true });
addCheck("invalid math model rejected", invalidMath.status !== 0, { stderr: invalidMath.stderr.trim() });

const invalidPaytable = runSql(mathEvaluationEventInsertSql({
  mathEvaluationId: randomUUID(),
  outcomeCertificateId,
  outcomeCertificateHash: outcomeHash,
  manifestReference,
  mathModelId,
  mathModelHash,
  paytableId: `${paytableId}:missing`,
  paytableHash,
  ticketReference: `${ticketReference}:bad-paytable`,
  wagerPayload,
  prizeFacts,
  prizeFactsHash: sha256(JSON.stringify({ invalid: "paytable" })),
  idempotencyKey: `${idempotencyKey}:bad-paytable`,
}), { allowFailure: true });
addCheck("invalid paytable rejected", invalidPaytable.status !== 0, { stderr: invalidPaytable.stderr.trim() });

const manifestMismatch = runSql(mathEvaluationEventInsertSql({
  mathEvaluationId: randomUUID(),
  outcomeCertificateId,
  outcomeCertificateHash: outcomeHash,
  manifestReference: `${manifestReference}:mismatch`,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  ticketReference: `${ticketReference}:manifest-mismatch`,
  wagerPayload,
  prizeFacts,
  prizeFactsHash: sha256(JSON.stringify({ invalid: "manifest" })),
  idempotencyKey: `${idempotencyKey}:manifest-mismatch`,
}), { allowFailure: true });
addCheck("manifest mismatch rejected", manifestMismatch.status !== 0, { stderr: manifestMismatch.stderr.trim() });

const financialPrizeFacts = runSql(mathEvaluationEventInsertSql({
  mathEvaluationId: randomUUID(),
  outcomeCertificateId,
  outcomeCertificateHash: outcomeHash,
  manifestReference,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  ticketReference: `${ticketReference}:financial`,
  wagerPayload,
  prizeFacts: { ...prizeFacts, ledgerEntryId: randomUUID() },
  prizeFactsHash: sha256(JSON.stringify({ invalid: "financial" })),
  idempotencyKey: `${idempotencyKey}:financial`,
}), { allowFailure: true });
addCheck("financial movement references rejected", financialPrizeFacts.status !== 0, {
  stderr: financialPrizeFacts.stderr.trim(),
});

const updateEvaluation = runSql(
  `update game_engine.math_evaluation_events set evaluation_mode = 'Simulation' where math_evaluation_id = '${mathEvaluationId}';`,
  { allowFailure: true },
);
addCheck("math evaluation event update blocked", updateEvaluation.status !== 0, { stderr: updateEvaluation.stderr.trim() });

const deleteCertificate = runSql(
  `delete from game_engine.math_evaluation_certificates where certificate_id = '${mathCertificateId}';`,
  { allowFailure: true },
);
addCheck("math evaluation certificate delete blocked", deleteCertificate.status !== 0, {
  stderr: deleteCertificate.stderr.trim(),
});

const ledgerCountAfter = rowCount("select count(*) from public.financial_ledger_entries;");
addCheck("no financial ledger effects are created", ledgerCountAfter === ledgerCountBefore, {
  before: ledgerCountBefore,
  after: ledgerCountAfter,
});

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
