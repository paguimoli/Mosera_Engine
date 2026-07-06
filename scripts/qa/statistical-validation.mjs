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

function sqlJsonNullable(value) {
  return value === null || value === undefined ? "null::jsonb" : sqlJson(value);
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

function strategyInsertSql({ id = randomUUID(), strategyId, strategyVersion = "1.0.0", contentHash }) {
  return `
insert into game_engine.outcome_strategy_definitions (
  id, strategy_id, strategy_version, primitive_graph, input_schema, output_schema,
  constraints, jurisdiction_profile_references, lifecycle_state, content_hash,
  certification_binding_placeholder, signature_metadata
) values (
  '${id}',
  ${sqlString(strategyId)},
  ${sqlString(strategyVersion)},
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
  'statistical-validation-placeholder',
  ${sqlJson({ signingKeyId: "qa-signing-key", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa-signature" })}
);`;
}

function mathModelInsertSql({ id = randomUUID(), mathModelId, version = "1.0.0", contentHash }) {
  return `
insert into game_engine.math_model_definitions (
  id, math_model_id, version, game_family_compatibility, supported_wager_schemas,
  expected_rtp, expected_value, volatility_profile, hit_frequency, prize_liability_profile,
  jackpot_contribution_model, rounding_policy, currency_minor_unit_policy,
  jurisdiction_profile_references, rtp_policy_constraints, lifecycle_state, content_hash,
  certification_binding_state, signature_metadata
) values (
  '${id}',
  ${sqlString(mathModelId)},
  ${sqlString(version)},
  ${sqlJson(["Lottery"])},
  ${sqlJson(["number-set-v1"])},
  0.92000000,
  -0.08000000,
  'Medium',
  0.18000000,
  ${sqlJson({ maxExposureMultiple: 100 })},
  ${sqlJson({ contributionBasisPoints: 0 })},
  ${sqlJson({ mode: "bankers", precisionMinorUnits: 2 })},
  ${sqlJson({ currency: "USD", minorUnit: 2 })},
  ${sqlJsonNullable(null)},
  ${sqlJsonNullable(null)},
  'GovernanceApproved',
  ${sqlString(contentHash)},
  'None',
  ${sqlJson({ signingKeyId: "qa-signing-key", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa-signature" })}
);`;
}

function paytableInsertSql({ id = randomUUID(), paytableId, version = "1.0.0", mathModelId, mathModelVersion = "1.0.0", contentHash }) {
  return `
insert into game_engine.paytable_definitions (
  id, paytable_id, version, math_model_id, math_model_version, prize_matrix_rows,
  bonus_side_bet_rows, caps, jurisdiction_profile_references, lifecycle_state,
  content_hash, certification_binding_state, signature_metadata
) values (
  '${id}',
  ${sqlString(paytableId)},
  ${sqlString(version)},
  ${sqlString(mathModelId)},
  ${sqlString(mathModelVersion)},
  ${sqlJson([{
    rowId: "match-three",
    wagerSchema: "number-set-v1",
    prizeCode: "MATCH_THREE",
    multiplier: 10,
    payoutValue: 0,
    maxPayout: 1000,
    conditions: { matchCount: 3 },
  }])},
  ${sqlJson([])},
  ${sqlJson({ maxPayout: 1000 })},
  ${sqlJsonNullable(null)},
  'GovernanceApproved',
  ${sqlString(contentHash)},
  'None',
  ${sqlJson({ signingKeyId: "qa-signing-key", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa-signature" })}
);`;
}

function rngProviderInsertSql({ id = randomUUID(), providerId, providerVersion = "1.0.0", contentHash }) {
  return `
insert into game_engine.rng_provider_definitions (
  id, provider_id, provider_version, provider_type, production_eligible,
  certification_state, algorithm_references, entropy_source_metadata,
  health_test_capabilities, failure_mode, content_hash, signature_metadata
) values (
  '${id}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
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

function validationInsertSql({
  id = randomUUID(),
  validationType = "FREQUENCY",
  targetArtifactType = "OutcomeStrategy",
  targetArtifactId,
  targetArtifactVersion = "1.0.0",
  targetArtifactHash,
  sampleSize = 10000,
  expectedDistribution = { "1": 0.0125, "2": 0.0125 },
  observedDistribution = { "1": 0.0126, "2": 0.0124 },
  pValue = 0.82,
  score = 0.98,
  resultStatus = "Pass",
  certificationReady = false,
  canonicalResultHash,
}) {
  return `
insert into game_engine.statistical_validation_results (
  id, validation_type, target_artifact_type, target_artifact_id, target_artifact_version,
  target_artifact_hash, sample_size, expected_distribution, observed_distribution,
  p_value, score, result_status, certification_ready, generated_at,
  canonical_result_hash, signing_metadata
) values (
  '${id}',
  ${sqlString(validationType)},
  ${sqlString(targetArtifactType)},
  ${sqlString(targetArtifactId)},
  ${sqlString(targetArtifactVersion)},
  ${sqlString(targetArtifactHash)},
  ${sampleSize},
  ${sqlJson(expectedDistribution)},
  ${sqlJson(observedDistribution)},
  ${pValue === null ? "null" : pValue},
  ${score === null ? "null" : score},
  ${sqlString(resultStatus)},
  ${certificationReady ? "true" : "false"},
  now(),
  ${sqlString(canonicalResultHash)},
  ${sqlJson({ signingKeyId: "placeholder", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "placeholder-v1", signature: "placeholder" })}
);`;
}

function simulationInsertSql({
  id = randomUUID(),
  simulationMode = "Simulation",
  strategyId,
  strategyHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  rngProviderId,
  rngProviderHash,
  productionOutcomeEvidence = false,
  canonicalEvidenceHash,
}) {
  return `
insert into game_engine.simulation_evidence (
  id, simulation_mode, outcome_strategy_id, outcome_strategy_version, outcome_strategy_hash,
  math_model_id, math_model_version, math_model_hash, paytable_id, paytable_version,
  paytable_hash, rng_provider_id, rng_provider_version, rng_provider_hash,
  iteration_count, theoretical_rtp, observed_rtp, variance, hit_frequency,
  prize_distribution, confidence_interval, production_outcome_evidence,
  canonical_evidence_hash, signing_metadata
) values (
  '${id}',
  ${sqlString(simulationMode)},
  ${sqlString(strategyId)},
  '1.0.0',
  ${sqlString(strategyHash)},
  ${sqlString(mathModelId)},
  '1.0.0',
  ${sqlString(mathModelHash)},
  ${sqlString(paytableId)},
  '1.0.0',
  ${sqlString(paytableHash)},
  ${sqlString(rngProviderId)},
  '1.0.0',
  ${sqlString(rngProviderHash)},
  100000,
  0.92000000,
  0.91980000,
  0.01800000,
  0.18000000,
  ${sqlJson({ MATCH_THREE: 0.18, NO_PRIZE: 0.82 })},
  ${sqlJson({ lower: 0.917, upper: 0.923, confidence: 0.95 })},
  ${productionOutcomeEvidence ? "true" : "false"},
  ${sqlString(canonicalEvidenceHash)},
  ${sqlJson({ signingKeyId: "placeholder", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "placeholder-v1", signature: "placeholder" })}
);`;
}

const runId = randomUUID();
const strategyId = `outcome-strategy:p0-005-10:${runId}`;
const strategyHash = `sha256:p0-005-10-strategy:${runId}`;
const mathModelId = `math-model:p0-005-10:${runId}`;
const mathModelHash = `sha256:p0-005-10-math:${runId}`;
const paytableId = `paytable:p0-005-10:${runId}`;
const paytableHash = `sha256:p0-005-10-paytable:${runId}`;
const rngProviderId = `rng-provider:p0-005-10:${runId}`;
const rngProviderHash = `sha256:p0-005-10-rng:${runId}`;

addCheck("statistical validation table exists", existsRegclass("game_engine.statistical_validation_results"));
addCheck("simulation evidence table exists", existsRegclass("game_engine.simulation_evidence"));

runSql(strategyInsertSql({ strategyId, contentHash: strategyHash }));
runSql(mathModelInsertSql({ mathModelId, contentHash: mathModelHash }));
runSql(paytableInsertSql({ paytableId, mathModelId, contentHash: paytableHash }));
runSql(rngProviderInsertSql({ providerId: rngProviderId, contentHash: rngProviderHash }));

const validationHash = `sha256:p0-005-10-validation:${runId}`;
runSql(validationInsertSql({
  targetArtifactId: strategyId,
  targetArtifactHash: strategyHash,
  canonicalResultHash: validationHash,
}));
addCheck(
  "frequency validation persists",
  rowCount(`
select count(*)
from game_engine.statistical_validation_results
where validation_type = 'FREQUENCY'
  and target_artifact_type = 'OutcomeStrategy'
  and target_artifact_id = ${sqlString(strategyId)}
  and target_artifact_hash = ${sqlString(strategyHash)}
  and canonical_result_hash = ${sqlString(validationHash)};
`) === 1,
  { validationHash },
);

const simulationHash = `sha256:p0-005-10-simulation:${runId}`;
runSql(simulationInsertSql({
  strategyId,
  strategyHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  rngProviderId,
  rngProviderHash,
  canonicalEvidenceHash: simulationHash,
}));
addCheck(
  "RTP simulation evidence persists",
  rowCount(`
select count(*)
from game_engine.simulation_evidence
where outcome_strategy_id = ${sqlString(strategyId)}
  and math_model_id = ${sqlString(mathModelId)}
  and paytable_id = ${sqlString(paytableId)}
  and rng_provider_id = ${sqlString(rngProviderId)}
  and canonical_evidence_hash = ${sqlString(simulationHash)}
  and production_outcome_evidence = false;
`) === 1,
  { simulationHash },
);

const inconclusive = runSql(validationInsertSql({
  id: randomUUID(),
  targetArtifactId: strategyId,
  targetArtifactHash: strategyHash,
  resultStatus: "Inconclusive",
  certificationReady: true,
  canonicalResultHash: `sha256:p0-005-10-inconclusive:${runId}`,
}), { allowFailure: true });
addCheck("inconclusive result does not certify", inconclusive.status !== 0, { stderr: inconclusive.stderr.trim() });

const failed = runSql(validationInsertSql({
  id: randomUUID(),
  targetArtifactId: strategyId,
  targetArtifactHash: strategyHash,
  resultStatus: "Fail",
  certificationReady: true,
  canonicalResultHash: `sha256:p0-005-10-failed:${runId}`,
}), { allowFailure: true });
addCheck("failed result rejected from certification-ready state", failed.status !== 0, { stderr: failed.stderr.trim() });

const productionEvidence = runSql(simulationInsertSql({
  id: randomUUID(),
  strategyId,
  strategyHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  rngProviderId,
  rngProviderHash,
  productionOutcomeEvidence: true,
  canonicalEvidenceHash: `sha256:p0-005-10-production-evidence:${runId}`,
}), { allowFailure: true });
addCheck("simulation evidence cannot reference production outcome certificate as production evidence", productionEvidence.status !== 0, {
  stderr: productionEvidence.stderr.trim(),
});

addCheck(
  "lookup by artifact/type/hash works",
  rowCount(`
select count(*)
from game_engine.statistical_validation_results
where validation_type = 'FREQUENCY'
  and target_artifact_type = 'OutcomeStrategy'
  and target_artifact_hash = ${sqlString(strategyHash)}
  and canonical_result_hash = ${sqlString(validationHash)};
`) === 1,
);

const updateValidation = runSql(
  `update game_engine.statistical_validation_results set result_status = 'Fail' where canonical_result_hash = ${sqlString(validationHash)};`,
  { allowFailure: true },
);
addCheck("statistical validation update blocked", updateValidation.status !== 0, { stderr: updateValidation.stderr.trim() });

const deleteSimulation = runSql(
  `delete from game_engine.simulation_evidence where canonical_evidence_hash = ${sqlString(simulationHash)};`,
  { allowFailure: true },
);
addCheck("simulation evidence delete blocked", deleteSimulation.status !== 0, { stderr: deleteSimulation.stderr.trim() });

const failedChecks = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failedChecks.length === 0 ? "PASS" : "FAIL",
  checks,
};

printJson(report);

if (failedChecks.length > 0) {
  process.exitCode = 1;
}
