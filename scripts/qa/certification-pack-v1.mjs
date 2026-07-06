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

function sqlUuidArray(values) {
  return `array[${values.map((value) => `'${value}'`).join(", ")}]::uuid[]`;
}

function sqlTextArray(values) {
  return `array[${values.map(sqlString).join(", ")}]::text[]`;
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

function buildHashRoot(hashes) {
  return sha256([...hashes].sort().join("|"));
}

function buildCanonicalExport({
  certificationPackId,
  certificationVersion,
  hashChainRoot,
  artifactReferences,
  certificateReferences,
  replayFixtureReferences,
  evidenceIndex,
  sourceBuildMetadata,
  sbomImageDigestReferences,
}) {
  return {
    exportVersion: "certification-pack-v1",
    certificationPackId,
    certificationVersion,
    hashChainRoot,
    artifactReferences: [...artifactReferences].sort((left, right) => left.artifactType.localeCompare(right.artifactType)),
    certificateReferences: [...certificateReferences].sort((left, right) => left.certificateId.localeCompare(right.certificateId)),
    replayFixtureReferences: [...replayFixtureReferences].sort(),
    evidenceIndex,
    sourceBuildMetadata,
    sbomImageDigestReferences,
  };
}

function insertGameManifestSql({
  manifestId,
  gameId,
  gameCode,
  manifestHash,
  strategyId,
  strategyHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  certificationPackReference,
}) {
  return `
insert into game_engine.game_manifests (
  id, game_id, game_code, game_name, game_family, jurisdiction_bindings, wager_schemas,
  outcome_strategy_references, math_model_references, paytable_references, settlement_policy_references,
  sales_rules, cancellation_correction_rules, replay_resettlement_policy, certification_pack_reference,
  regulator_profile, operator_approval_state, lifecycle_state, effective_from, semantic_version,
  content_hash, signature_metadata
) values (
  '${manifestId}',
  '${gameId}',
  ${sqlString(gameCode)},
  'Certification Pack QA Game',
  'Lottery',
  ${sqlJson([])},
  ${sqlJson(["straight-v1"])},
  ${sqlJson([{ strategyId, version: "1.0.0", contentHash: strategyHash }])},
  ${sqlJson([{ mathModelId, version: "1.0.0", contentHash: mathModelHash }])},
  ${sqlJson([{ paytableId, version: "1.0.0", contentHash: paytableHash }])},
  ${sqlJson(["settlement-policy:dry-run"])},
  ${sqlJson({ salesOpen: "00:00", salesClose: "23:59" })},
  ${sqlJson({ cancellationWindowSeconds: 0 })},
  ${sqlJson({ resettlementAllowed: true })},
  ${sqlString(certificationPackReference)},
  'internal-regulator-profile',
  'Approved',
  'GovernanceApproved',
  now(),
  '1.0.0',
  ${sqlString(manifestHash)},
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa" })}
);`;
}

function insertOutcomeStrategySql(strategyId, strategyHash) {
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
  ${sqlJson({ numbers: "int[]" })},
  ${sqlJson({})},
  ${sqlJson([])},
  'GovernanceApproved',
  ${sqlString(strategyHash)},
  'certification-pack-v1-placeholder',
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa" })}
);`;
}

function insertRngProviderSql(providerId, providerHash) {
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
  ${sqlString(providerHash)},
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa" })}
);`;
}

function insertRngEvidenceSql(providerId, evidenceHash) {
  return `
insert into game_engine.rng_provider_evidence (
  evidence_id, provider_id, provider_version, entropy_source_reference, health_test_result,
  known_answer_test_result, continuous_test_result, generated_at, canonical_evidence_hash, signing_metadata
) values (
  '${randomUUID()}',
  ${sqlString(providerId)},
  '1.0.0',
  'entropy-source:certification-pack-v1',
  'Passed',
  'NotApplicable',
  'Passed',
  now(),
  ${sqlString(evidenceHash)},
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa" })}
);`;
}

function insertOutcomeSql({
  outcomeId,
  outcomeCertificateId,
  drawId,
  manifestReference,
  strategyId,
  providerId,
  evidenceHash,
  outcomeHash,
}) {
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
  ${sqlString(`outcome:${outcomeId}`)},
  'DryRun',
  ${sqlJson({ numbers: [1, 2, 3, 4, 5] })},
  ${sqlString(outcomeHash)},
  now()
);

insert into game_engine.outcome_certificates (
  certificate_id, outcome_id, draw_id, strategy_id, strategy_version, rng_provider_id, rng_provider_version,
  canonical_outcome_hash, evidence_hash_reference, previous_certificates, signing_metadata, custody_state, issued_at
) values (
  '${outcomeCertificateId}',
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

function insertMathModelSql(mathModelId, mathModelHash) {
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
  ${sqlString(mathModelHash)},
  'InternalVerified',
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa" })}
);`;
}

function insertPaytableSql({ paytableId, mathModelId, paytableHash }) {
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
  ${sqlString(paytableHash)},
  'InternalVerified',
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa" })}
);`;
}

function insertMathEvaluationSql({
  mathEvaluationId,
  mathCertificateId,
  outcomeCertificateId,
  outcomeHash,
  manifestReference,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  prizeFactsHash,
}) {
  return `
insert into game_engine.math_evaluation_events (
  math_evaluation_id, request_id, outcome_certificate_id, outcome_certificate_hash, game_manifest_reference,
  math_model_id, math_model_version, math_model_hash, paytable_id, paytable_version, paytable_hash,
  ticket_reference, wager_payload, prize_facts, canonical_prize_facts_hash, idempotency_key,
  evaluation_mode, evaluated_at
) values (
  '${mathEvaluationId}',
  '${randomUUID()}',
  '${outcomeCertificateId}',
  ${sqlString(outcomeHash)},
  ${sqlString(manifestReference)},
  ${sqlString(mathModelId)},
  '1.0.0',
  ${sqlString(mathModelHash)},
  ${sqlString(paytableId)},
  '1.0.0',
  ${sqlString(paytableHash)},
  ${sqlString(`ticket:${mathEvaluationId}`)},
  ${sqlJson({ numbers: [1, 2, 3, 4, 5], stakeUnits: 1 })},
  ${sqlJson({ outcome: "Win", prizeTier: "MATCH_5", multiplier: 100, payoutUnits: 0, outcomeDerivedFacts: { matchCount: 5 } })},
  ${sqlString(prizeFactsHash)},
  ${sqlString(`math-evaluation:${mathEvaluationId}`)},
  'DryRun',
  now()
);

insert into game_engine.math_evaluation_certificates (
  certificate_id, math_evaluation_id, outcome_certificate_id, outcome_certificate_hash,
  math_model_id, math_model_version, math_model_hash, paytable_id, paytable_version,
  paytable_hash, ticket_reference, canonical_prize_facts_hash, rtp_math_metadata_reference,
  signing_metadata, issued_at
) values (
  '${mathCertificateId}',
  '${mathEvaluationId}',
  '${outcomeCertificateId}',
  ${sqlString(outcomeHash)},
  ${sqlString(mathModelId)},
  '1.0.0',
  ${sqlString(mathModelHash)},
  ${sqlString(paytableId)},
  '1.0.0',
  ${sqlString(paytableHash)},
  ${sqlString(`ticket:${mathEvaluationId}`)},
  ${sqlString(prizeFactsHash)},
  ${sqlString(`math-model:${mathModelId}:1.0.0:${mathModelHash}`)},
  ${sqlJson({ signingKeyId: "qa", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "placeholder-v1", signature: "qa" })},
  now()
);`;
}

function insertCertificationPackSql({
  id = randomUUID(),
  certificationPackId,
  certificationVersion = "1.0.0",
  manifestId,
  manifestReference,
  manifestHash,
  strategyId,
  strategyHash,
  providerId,
  providerHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  outcomeCertificateId,
  outcomeHash,
  mathCertificateId,
  prizeFactsHash,
  hashRoot,
  canonicalJson,
  evidenceIndex,
  jurisdictionProfileReferences = "null::jsonb",
}) {
  return `
insert into game_engine.certification_packs (
  id, certification_pack_id, certification_version, game_manifest_id, game_manifest_reference,
  game_manifest_hash, outcome_strategy_id, outcome_strategy_version, outcome_strategy_hash,
  rng_provider_id, rng_provider_version, rng_provider_hash, math_model_id, math_model_version,
  math_model_hash, paytable_id, paytable_version, paytable_hash, outcome_certificate_ids,
  outcome_certificate_hashes, math_evaluation_certificate_ids, math_evaluation_hashes,
  source_build_metadata, sbom_image_digest_references, jurisdiction_profile_references,
  certification_state, canonical_json, hash_chain_root, evidence_index, replay_fixture_references,
  content_hash, signing_metadata
) values (
  '${id}',
  ${sqlString(certificationPackId)},
  ${sqlString(certificationVersion)},
  '${manifestId}',
  ${sqlString(manifestReference)},
  ${sqlString(manifestHash)},
  ${sqlString(strategyId)},
  '1.0.0',
  ${sqlString(strategyHash)},
  ${sqlString(providerId)},
  '1.0.0',
  ${sqlString(providerHash)},
  ${sqlString(mathModelId)},
  '1.0.0',
  ${sqlString(mathModelHash)},
  ${sqlString(paytableId)},
  '1.0.0',
  ${sqlString(paytableHash)},
  ${sqlUuidArray([outcomeCertificateId])},
  ${sqlTextArray([outcomeHash])},
  ${sqlUuidArray([mathCertificateId])},
  ${sqlTextArray([prizeFactsHash])},
  ${sqlJson({ repository: "lottery-app", commit: "qa-placeholder", buildId: "qa-certification-pack-v1" })},
  ${sqlJson({ app: "ghcr.io/mosera/app@sha256:placeholder", gameEngine: "ghcr.io/mosera/game-engine@sha256:placeholder" })},
  ${jurisdictionProfileReferences},
  'InternalVerified',
  ${sqlJson(canonicalJson)},
  ${sqlString(hashRoot)},
  ${sqlJson(evidenceIndex)},
  ${sqlJson(["replay-fixture:placeholder"])},
  ${sqlString(hashRoot)},
  ${sqlJson({ signingKeyId: "placeholder-signing-key", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "placeholder-v1", signature: "placeholder-signature" })}
);`;
}

const runId = randomUUID();
const manifestId = randomUUID();
const gameId = randomUUID();
const outcomeId = randomUUID();
const outcomeCertificateId = randomUUID();
const drawId = randomUUID();
const mathEvaluationId = randomUUID();
const mathCertificateId = randomUUID();
const certificationPackId = `certification-pack:p0-005-8:${runId}`;
const gameCode = `P0058-${runId.slice(0, 8)}`;
const manifestReference = `game-manifest:${gameId}:1.0.0`;
const strategyId = `outcome-strategy:p0-005-8:${runId}`;
const providerId = `rng-provider:p0-005-8:${runId}`;
const mathModelId = `math-model:p0-005-8:${runId}`;
const paytableId = `paytable:p0-005-8:${runId}`;
const manifestHash = sha256(`manifest:${runId}`);
const strategyHash = sha256(`strategy:${runId}`);
const providerHash = sha256(`provider:${runId}`);
const evidenceHash = sha256(`evidence:${runId}`);
const mathModelHash = sha256(`math:${runId}`);
const paytableHash = sha256(`paytable:${runId}`);
const outcomeHash = sha256(JSON.stringify({ numbers: [1, 2, 3, 4, 5] }));
const prizeFactsHash = sha256(JSON.stringify({ outcome: "Win", prizeTier: "MATCH_5", multiplier: 100 }));
const hashRoot = buildHashRoot([
  manifestHash,
  strategyHash,
  providerHash,
  mathModelHash,
  paytableHash,
  outcomeHash,
  prizeFactsHash,
]);
const artifactReferences = [
  { artifactType: "GameManifest", artifactId: manifestId, artifactVersion: "1.0.0", contentHash: manifestHash },
  { artifactType: "OutcomeStrategy", artifactId: strategyId, artifactVersion: "1.0.0", contentHash: strategyHash },
  { artifactType: "RngProvider", artifactId: providerId, artifactVersion: "1.0.0", contentHash: providerHash },
  { artifactType: "MathModel", artifactId: mathModelId, artifactVersion: "1.0.0", contentHash: mathModelHash },
  { artifactType: "Paytable", artifactId: paytableId, artifactVersion: "1.0.0", contentHash: paytableHash },
];
const certificateReferences = [
  { certificateId: outcomeCertificateId, certificateHash: outcomeHash },
  { certificateId: mathCertificateId, certificateHash: prizeFactsHash },
];
const evidenceIndex = {
  gameManifest: manifestHash,
  outcomeStrategy: strategyHash,
  rngProvider: providerHash,
  outcomeCertificates: [outcomeHash],
  mathModel: mathModelHash,
  paytable: paytableHash,
  mathEvaluationCertificates: [prizeFactsHash],
};
const canonicalJson = buildCanonicalExport({
  certificationPackId,
  certificationVersion: "1.0.0",
  hashChainRoot: hashRoot,
  artifactReferences,
  certificateReferences,
  replayFixtureReferences: ["replay-fixture:placeholder"],
  evidenceIndex,
  sourceBuildMetadata: { repository: "lottery-app", commit: "qa-placeholder", buildId: "qa-certification-pack-v1" },
  sbomImageDigestReferences: { app: "ghcr.io/mosera/app@sha256:placeholder", gameEngine: "ghcr.io/mosera/game-engine@sha256:placeholder" },
});

addCheck("certification pack table exists", existsRegclass("game_engine.certification_packs"));

runSql(insertOutcomeStrategySql(strategyId, strategyHash));
runSql(insertRngProviderSql(providerId, providerHash));
runSql(insertRngEvidenceSql(providerId, evidenceHash));
runSql(insertGameManifestSql({
  manifestId,
  gameId,
  gameCode,
  manifestHash,
  strategyId,
  strategyHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  certificationPackReference: certificationPackId,
}));
runSql(insertOutcomeSql({
  outcomeId,
  outcomeCertificateId,
  drawId,
  manifestReference,
  strategyId,
  providerId,
  evidenceHash,
  outcomeHash,
}));
runSql(insertMathModelSql(mathModelId, mathModelHash));
runSql(insertPaytableSql({ paytableId, mathModelId, paytableHash }));
runSql(insertMathEvaluationSql({
  mathEvaluationId,
  mathCertificateId,
  outcomeCertificateId,
  outcomeHash,
  manifestReference,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  prizeFactsHash,
}));

runSql(insertCertificationPackSql({
  certificationPackId,
  manifestId,
  manifestReference,
  manifestHash,
  strategyId,
  strategyHash,
  providerId,
  providerHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  outcomeCertificateId,
  outcomeHash,
  mathCertificateId,
  prizeFactsHash,
  hashRoot,
  canonicalJson,
  evidenceIndex,
}));

addCheck(
  "create certification pack succeeds",
  rowCount(`
select count(*)
from game_engine.certification_packs
where certification_pack_id = ${sqlString(certificationPackId)}
  and certification_version = '1.0.0'
  and content_hash = ${sqlString(hashRoot)};
`) === 1,
  { certificationPackId, hashRoot },
);

addCheck(
  "jurisdiction omitted succeeds",
  rowCount(`
select count(*)
from game_engine.certification_packs
where certification_pack_id = ${sqlString(certificationPackId)}
  and jurisdiction_profile_references is null;
`) === 1,
);

const badArtifact = runSql(insertCertificationPackSql({
  certificationPackId: `${certificationPackId}:bad-artifact`,
  manifestId,
  manifestReference,
  manifestHash,
  strategyId: `${strategyId}:missing`,
  strategyHash,
  providerId,
  providerHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  outcomeCertificateId,
  outcomeHash,
  mathCertificateId,
  prizeFactsHash,
  hashRoot: sha256(`bad-artifact:${runId}`),
  canonicalJson: { ...canonicalJson, certificationPackId: `${certificationPackId}:bad-artifact`, hashChainRoot: sha256(`bad-artifact:${runId}`) },
  evidenceIndex,
}), { allowFailure: true });
addCheck("invalid/missing referenced artifact rejected", badArtifact.status !== 0, { stderr: badArtifact.stderr.trim() });

const secondHashRoot = buildHashRoot([
  paytableHash,
  prizeFactsHash,
  outcomeHash,
  providerHash,
  manifestHash,
  mathModelHash,
  strategyHash,
]);
addCheck("authority chain hash root is deterministic", secondHashRoot === hashRoot, { hashRoot });

const duplicateVersion = runSql(insertCertificationPackSql({
  id: randomUUID(),
  certificationPackId,
  manifestId,
  manifestReference,
  manifestHash,
  strategyId,
  strategyHash,
  providerId,
  providerHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  outcomeCertificateId,
  outcomeHash,
  mathCertificateId,
  prizeFactsHash,
  hashRoot: sha256(`duplicate-version:${runId}`),
  canonicalJson: { ...canonicalJson, hashChainRoot: sha256(`duplicate-version:${runId}`) },
  evidenceIndex,
}), { allowFailure: true });
addCheck("duplicate pack version blocked", duplicateVersion.status !== 0, { stderr: duplicateVersion.stderr.trim() });

const duplicateHash = runSql(insertCertificationPackSql({
  id: randomUUID(),
  certificationPackId: `${certificationPackId}:duplicate-hash`,
  manifestId,
  manifestReference,
  manifestHash,
  strategyId,
  strategyHash,
  providerId,
  providerHash,
  mathModelId,
  mathModelHash,
  paytableId,
  paytableHash,
  outcomeCertificateId,
  outcomeHash,
  mathCertificateId,
  prizeFactsHash,
  hashRoot,
  canonicalJson: { ...canonicalJson, certificationPackId: `${certificationPackId}:duplicate-hash` },
  evidenceIndex,
}), { allowFailure: true });
addCheck("duplicate pack hash blocked", duplicateHash.status !== 0, { stderr: duplicateHash.stderr.trim() });

const updatePack = runSql(
  `update game_engine.certification_packs set certification_state = 'Certified' where certification_pack_id = ${sqlString(certificationPackId)};`,
  { allowFailure: true },
);
addCheck("certification pack update blocked", updatePack.status !== 0, { stderr: updatePack.stderr.trim() });

const deletePack = runSql(
  `delete from game_engine.certification_packs where certification_pack_id = ${sqlString(certificationPackId)};`,
  { allowFailure: true },
);
addCheck("certification pack delete blocked", deletePack.status !== 0, { stderr: deletePack.stderr.trim() });

addCheck(
  "canonical JSON export validates",
  rowCount(`
select count(*)
from game_engine.certification_packs
where certification_pack_id = ${sqlString(certificationPackId)}
  and canonical_json->>'exportVersion' = 'certification-pack-v1'
  and canonical_json->>'hashChainRoot' = ${sqlString(hashRoot)}
  and jsonb_array_length(canonical_json->'artifactReferences') = 5
  and jsonb_array_length(canonical_json->'certificateReferences') = 2
  and evidence_index ? 'mathEvaluationCertificates';
`) === 1,
);

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
