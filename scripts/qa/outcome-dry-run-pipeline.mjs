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

function strategyInsertSql({ strategyId, contentHash }) {
  return `
insert into game_engine.outcome_strategy_definitions (
  id,
  strategy_id,
  strategy_version,
  primitive_graph,
  input_schema,
  output_schema,
  constraints,
  jurisdiction_profile_references,
  lifecycle_state,
  content_hash,
  certification_binding_placeholder,
  signature_metadata
) values (
  '${randomUUID()}',
  ${sqlString(strategyId)},
  '1.0.0',
  ${sqlJson([
    {
      nodeId: "numbers",
      primitiveType: "UniqueNumberSet",
      dependsOn: [],
      minNumber: 1,
      maxNumber: 20,
      count: 5,
      numbers: [1, 2, 3, 4, 5],
    },
    {
      nodeId: "bonus",
      primitiveType: "WeightedSelection",
      dependsOn: ["numbers"],
      weightedOptions: [
        { symbol: "RED", weight: 1 },
        { symbol: "BLUE", weight: 2 },
      ],
    },
    {
      nodeId: "composite",
      primitiveType: "CompositeOutcomeGraph",
      dependsOn: ["numbers", "bonus"],
    },
  ])},
  ${sqlJson({ drawId: "uuid" })},
  ${sqlJson({ resultType: "dry-run" })},
  ${sqlJson({ maxAttempts: 1 })},
  ${sqlJson([])},
  'GovernanceApproved',
  ${sqlString(contentHash)},
  'outcome-strategy-cert-placeholder',
  ${sqlJson({
    signingKeyId: "qa-signing-key",
    hashAlgorithmVersion: "sha256-v1",
    signingAlgorithmVersion: "ed25519-v1",
    signature: "qa-signature",
  })}
);`;
}

function providerInsertSql({
  providerId,
  providerType = "TEST_DETERMINISTIC",
  productionEligible = false,
  contentHash,
}) {
  return `
insert into game_engine.rng_provider_definitions (
  id,
  provider_id,
  provider_version,
  provider_type,
  production_eligible,
  certification_state,
  algorithm_references,
  entropy_source_metadata,
  health_test_capabilities,
  failure_mode,
  content_hash,
  signature_metadata
) values (
  '${randomUUID()}',
  ${sqlString(providerId)},
  '1.0.0',
  ${sqlString(providerType)},
  ${productionEligible ? "true" : "false"},
  'InternalVerified',
  ${sqlJson(["deterministic-test-v1"])},
  ${sqlJson({ seedPolicy: "idempotency-derived" })},
  ${sqlJson(["deterministic-health-check"])},
  'FailClosed',
  ${sqlString(contentHash)},
  ${sqlJson({
    signingKeyId: "qa-signing-key",
    hashAlgorithmVersion: "sha256-v1",
    signingAlgorithmVersion: "ed25519-v1",
    signature: "qa-signature",
  })}
);`;
}

function evidenceInsertSql({ providerId, evidenceHash }) {
  return `
insert into game_engine.rng_provider_evidence (
  evidence_id,
  provider_id,
  provider_version,
  entropy_source_reference,
  health_test_result,
  known_answer_test_result,
  continuous_test_result,
  generated_at,
  canonical_evidence_hash,
  signing_metadata
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
  ${sqlJson({
    signingKeyId: "qa-signing-key",
    hashAlgorithmVersion: "sha256-v1",
    signingAlgorithmVersion: "ed25519-v1",
    signature: "qa-signature",
  })}
);`;
}

function outcomeInsertSql({
  outcomeId,
  requestId = randomUUID(),
  drawId,
  strategyId,
  providerId,
  evidenceHash,
  idempotencyKey,
  outcomeMode = "DryRun",
  outcomePayload,
  outcomeHash,
  onConflict = "",
}) {
  return `
insert into game_engine.outcome_events (
  outcome_id,
  request_id,
  draw_id,
  game_manifest_reference,
  strategy_id,
  strategy_version,
  rng_provider_id,
  rng_provider_version,
  rng_evidence_hash,
  idempotency_key,
  outcome_mode,
  outcome_payload,
  canonical_outcome_hash,
  generated_at
) values (
  '${outcomeId}',
  '${requestId}',
  '${drawId}',
  'game-manifest:dry-run:1.0.0',
  ${sqlString(strategyId)},
  '1.0.0',
  ${sqlString(providerId)},
  '1.0.0',
  ${sqlString(evidenceHash)},
  ${sqlString(idempotencyKey)},
  ${sqlString(outcomeMode)},
  ${sqlJson(outcomePayload)},
  ${sqlString(outcomeHash)},
  now()
) ${onConflict};`;
}

function certificateInsertSql({
  certificateId,
  outcomeId,
  drawId,
  strategyId,
  providerId,
  evidenceHash,
  outcomeHash,
}) {
  return `
insert into game_engine.outcome_certificates (
  certificate_id,
  outcome_id,
  draw_id,
  strategy_id,
  strategy_version,
  rng_provider_id,
  rng_provider_version,
  canonical_outcome_hash,
  evidence_hash_reference,
  previous_certificates,
  signing_metadata,
  custody_state,
  issued_at
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
  ${sqlJson({
    signingKeyId: "placeholder-signing-key",
    hashAlgorithmVersion: "sha256-v1",
    signingAlgorithmVersion: "placeholder-signature-v1",
    signature: "placeholder-signature",
  })},
  'Generated',
  now()
);`;
}

const runId = randomUUID();
const strategyId = `outcome-strategy:p0-005-6:${runId}`;
const providerId = `rng-provider:p0-005-6:${runId}`;
const simulationProviderId = `rng-provider:p0-005-6:simulation:${runId}`;
const evidenceHash = `sha256:p0-005-6-evidence:${runId}`;
const outcomeId = randomUUID();
const certificateId = randomUUID();
const drawId = randomUUID();
const idempotencyKey = `outcome-dry-run:${runId}`;
const outcomePayload = {
  bonus: "BLUE",
  numbers: [4, 17, 2, 8, 11],
};
const outcomeHash = sha256(JSON.stringify(outcomePayload));

addCheck("outcome event table exists", existsRegclass("game_engine.outcome_events"));
addCheck("outcome certificate table exists", existsRegclass("game_engine.outcome_certificates"));

runSql(strategyInsertSql({ strategyId, contentHash: `sha256:p0-005-6-strategy:${runId}` }));
runSql(providerInsertSql({ providerId, contentHash: `sha256:p0-005-6-provider:${runId}` }));
runSql(evidenceInsertSql({ providerId, evidenceHash }));

runSql(outcomeInsertSql({
  outcomeId,
  drawId,
  strategyId,
  providerId,
  evidenceHash,
  idempotencyKey,
  outcomePayload,
  outcomeHash,
}));
runSql(certificateInsertSql({
  certificateId,
  outcomeId,
  drawId,
  strategyId,
  providerId,
  evidenceHash,
  outcomeHash,
}));

addCheck(
  "dry-run outcome request succeeds",
  rowCount(`
select count(*)
from game_engine.outcome_events
where outcome_id = '${outcomeId}'
  and draw_id = '${drawId}'
  and outcome_mode = 'DryRun'
  and canonical_outcome_hash = ${sqlString(outcomeHash)};
`) === 1,
  { outcomeId, outcomeHash },
);

addCheck(
  "outcome certificate persisted",
  rowCount(`
select count(*)
from game_engine.outcome_certificates
where certificate_id = '${certificateId}'
  and outcome_id = '${outcomeId}'
  and evidence_hash_reference = ${sqlString(evidenceHash)}
  and custody_state = 'Generated';
`) === 1,
  { certificateId },
);

runSql(outcomeInsertSql({
  outcomeId: randomUUID(),
  drawId,
  strategyId,
  providerId,
  evidenceHash,
  idempotencyKey,
  outcomePayload: { numbers: [99] },
  outcomeHash: sha256(JSON.stringify({ numbers: [99] })),
  onConflict: "on conflict (idempotency_key) do nothing",
}));
addCheck(
  "duplicate idempotency key returns same outcome certificate",
  rowCount(`
select count(*)
from game_engine.outcome_events oe
join game_engine.outcome_certificates oc on oc.outcome_id = oe.outcome_id
where oe.idempotency_key = ${sqlString(idempotencyKey)}
  and oe.outcome_id = '${outcomeId}'
  and oc.certificate_id = '${certificateId}';
`) === 1,
  { idempotencyKey, outcomeId, certificateId },
);

addCheck(
  "outcome hash lookup works",
  rowCount(`
select count(*)
from game_engine.outcome_events oe
join game_engine.outcome_certificates oc on oc.outcome_id = oe.outcome_id
where oe.draw_id = '${drawId}'
  and oe.canonical_outcome_hash = ${sqlString(outcomeHash)}
  and oc.certificate_id = '${certificateId}';
`) === 1,
  { drawId, outcomeHash },
);

const productionMode = runSql(outcomeInsertSql({
  outcomeId: randomUUID(),
  drawId: randomUUID(),
  strategyId,
  providerId,
  evidenceHash,
  idempotencyKey: `${idempotencyKey}:production`,
  outcomeMode: "ProductionDisabled",
  outcomePayload,
  outcomeHash: sha256(JSON.stringify({ production: "disabled" })),
}), { allowFailure: true });
addCheck("production mode rejected", productionMode.status !== 0, { stderr: productionMode.stderr.trim() });

runSql(providerInsertSql({
  providerId: simulationProviderId,
  providerType: "SIMULATION",
  productionEligible: false,
  contentHash: `sha256:p0-005-6-simulation-provider:${runId}`,
}));
runSql(evidenceInsertSql({
  providerId: simulationProviderId,
  evidenceHash: `sha256:p0-005-6-simulation-evidence:${runId}`,
}));
const simulationProviderDryRun = runSql(outcomeInsertSql({
  outcomeId: randomUUID(),
  drawId: randomUUID(),
  strategyId,
  providerId: simulationProviderId,
  evidenceHash: `sha256:p0-005-6-simulation-evidence:${runId}`,
  idempotencyKey: `${idempotencyKey}:simulation-dry-run`,
  outcomeMode: "DryRun",
  outcomePayload,
  outcomeHash: sha256(JSON.stringify({ simulation: "dry-run-rejected" })),
}), { allowFailure: true });
addCheck("deterministic/test provider allowed only in dry-run", simulationProviderDryRun.status !== 0, {
  stderr: simulationProviderDryRun.stderr.trim(),
});

runSql(outcomeInsertSql({
  outcomeId: randomUUID(),
  drawId: randomUUID(),
  strategyId,
  providerId: simulationProviderId,
  evidenceHash: `sha256:p0-005-6-simulation-evidence:${runId}`,
  idempotencyKey: `${idempotencyKey}:simulation-mode`,
  outcomeMode: "Simulation",
  outcomePayload,
  outcomeHash: sha256(JSON.stringify({ simulation: "accepted" })),
}));
addCheck(
  "simulation provider allowed in simulation mode",
  rowCount(`
select count(*)
from game_engine.outcome_events
where idempotency_key = ${sqlString(`${idempotencyKey}:simulation-mode`)}
  and outcome_mode = 'Simulation';
`) === 1,
);

const invalidStrategy = runSql(outcomeInsertSql({
  outcomeId: randomUUID(),
  drawId: randomUUID(),
  strategyId: `${strategyId}:missing`,
  providerId,
  evidenceHash,
  idempotencyKey: `${idempotencyKey}:invalid-strategy`,
  outcomePayload,
  outcomeHash: sha256(JSON.stringify({ invalid: "strategy" })),
}), { allowFailure: true });
addCheck("invalid strategy rejected", invalidStrategy.status !== 0, { stderr: invalidStrategy.stderr.trim() });

const invalidProvider = runSql(outcomeInsertSql({
  outcomeId: randomUUID(),
  drawId: randomUUID(),
  strategyId,
  providerId: `${providerId}:missing`,
  evidenceHash,
  idempotencyKey: `${idempotencyKey}:invalid-provider`,
  outcomePayload,
  outcomeHash: sha256(JSON.stringify({ invalid: "provider" })),
}), { allowFailure: true });
addCheck("invalid provider rejected", invalidProvider.status !== 0, { stderr: invalidProvider.stderr.trim() });

const invalidEvidence = runSql(outcomeInsertSql({
  outcomeId: randomUUID(),
  drawId: randomUUID(),
  strategyId,
  providerId,
  evidenceHash: `${evidenceHash}:missing`,
  idempotencyKey: `${idempotencyKey}:invalid-evidence`,
  outcomePayload,
  outcomeHash: sha256(JSON.stringify({ invalid: "evidence" })),
}), { allowFailure: true });
addCheck("invalid evidence rejected", invalidEvidence.status !== 0, { stderr: invalidEvidence.stderr.trim() });

const updateOutcome = runSql(
  `update game_engine.outcome_events set outcome_mode = 'Simulation' where outcome_id = '${outcomeId}';`,
  { allowFailure: true },
);
addCheck("outcome event update blocked", updateOutcome.status !== 0, { stderr: updateOutcome.stderr.trim() });

const deleteCertificate = runSql(
  `delete from game_engine.outcome_certificates where certificate_id = '${certificateId}';`,
  { allowFailure: true },
);
addCheck("outcome certificate delete blocked", deleteCertificate.status !== 0, { stderr: deleteCertificate.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
