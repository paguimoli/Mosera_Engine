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

function columnExists(schema, table, column) {
  return queryScalar(`
select exists (
  select 1
  from information_schema.columns
  where table_schema = ${sqlString(schema)}
    and table_name = ${sqlString(table)}
    and column_name = ${sqlString(column)}
);
`) === "t";
}

function rowCount(sql) {
  return Number(queryScalar(sql));
}

function outcomeProviderInsertSql({
  id = randomUUID(),
  providerId,
  providerVersion = "1.0.0",
  productionEligible = true,
  contentHash,
}) {
  return `
insert into game_engine.outcome_provider_definitions (
  id,
  provider_id,
  provider_version,
  provider_type,
  lifecycle_state,
  production_eligible,
  supported_outcome_primitive_types,
  evidence_requirements,
  health_readiness_capabilities,
  idempotency_model,
  custody_support,
  signing_requirements,
  replayability_support,
  failure_mode,
  capability_markers,
  content_hash,
  certification_binding,
  jurisdiction_profile_references
) values (
  '${id}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  'CERTIFIED_CSPRNG',
  'Active',
  ${productionEligible ? "true" : "false"},
  ${sqlJson(["UniqueNumberSet", "WeightedSelection", "ShufflePermutation"])},
  ${sqlJson({ drbgSessionEvidence: true, entropyProviderEvidence: true })},
  ${sqlJson(["startup-health", "known-answer-test", "continuous-health"])},
  'PerDraw',
  ${sqlJson(["Generated", "Sealed", "Certified", "Disputed"])},
  ${sqlJson({ certificateSignatureRequired: true })},
  true,
  'FailClosed',
  ${sqlJson({
    generatesOutcomes: true,
    ingestsExternalOutcomes: false,
    supportsPlayerVerificationReceipt: false,
    supportsDeterministicReplay: true,
    supportsProviderHealthEvidence: true,
    supportsDisputeHandling: true,
    supportsExternalSourceEvidence: false,
    supportsPhysicalDrawEvidence: false,
  })},
  ${sqlString(contentHash)},
  null,
  null
);`;
}

function rngProviderInsertSql({
  id = randomUUID(),
  providerId,
  providerVersion = "1.0.0",
  productionEligible = true,
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
  '${id}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  'HMAC_DRBG',
  ${productionEligible ? "true" : "false"},
  'InternalVerified',
  ${sqlJson(["NIST-SP800-90A-HMAC-DRBG", "SHA-256"])},
  ${sqlJson({ entropySource: "external-entropy-provider-reference-only" })},
  ${sqlJson(["startup-health-test", "known-answer-test", "continuous-randomness-test"])},
  'FailClosed',
  ${sqlString(contentHash)},
  ${sqlJson({ signingKeyId: "qa-signing-key", signature: "qa-signature" })}
);`;
}

function entropyProviderInsertSql({
  id = randomUUID(),
  providerId,
  providerVersion = "1.0.0",
  providerType = "OS_CSPRNG",
  platformRuntimeReference = "linux-kernel-getrandom",
  entropySourceMetadata = { sourceReference: "os-csprng", platform: "linux", rawMaterialPersisted: false },
  minimumEntropyBits = 256,
  healthTestCapabilities = ["startup-health-test", "continuous-health-test"],
  productionEligible = true,
  failureMode = "FailClosed",
  contentHash,
}) {
  return `
insert into game_engine.entropy_provider_definitions (
  id,
  provider_id,
  provider_version,
  provider_type,
  platform_runtime_reference,
  entropy_source_metadata,
  minimum_entropy_bits,
  health_test_capabilities,
  production_eligible,
  failure_mode,
  content_hash
) values (
  '${id}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  ${sqlString(providerType)},
  ${sqlString(platformRuntimeReference)},
  ${sqlJson(entropySourceMetadata)},
  ${minimumEntropyBits},
  ${sqlJson(healthTestCapabilities)},
  ${productionEligible ? "true" : "false"},
  ${sqlString(failureMode)},
  ${sqlString(contentHash)}
);`;
}

function csprngProviderInsertSql({
  id = randomUUID(),
  providerId,
  providerVersion = "1.0.0",
  outcomeProviderId,
  outcomeProviderVersion = "1.0.0",
  linkedRngProviderId,
  linkedRngProviderVersion = "1.0.0",
  entropyProviderType = "OS_CSPRNG",
  hashAlgorithm = "SHA_256",
  securityStrengthBits = 256,
  reseedPolicy = { intervalRequests: 1000000, intervalSeconds: 3600 },
  sessionIsolationPolicy = { perDrawSession: true },
  zeroizationPolicy = { zeroizeOnCompletion: true, evidenceRequired: true },
  startupSelfTestSupported = true,
  knownAnswerTestSupported = true,
  continuousHealthTestSupported = true,
  productionEligible = true,
  lifecycleState = "Active",
  failureMode = "FailClosed",
  samplingCapabilities = [
    "RejectionSampling",
    "FisherYatesShuffle",
    "UniqueNumberSelection",
    "IntegerRationalWeightedSelection",
  ],
  contentHash,
  certificationBinding = null,
}) {
  return `
insert into game_engine.csprng_provider_definitions (
  id,
  provider_id,
  provider_version,
  outcome_provider_id,
  outcome_provider_version,
  linked_rng_provider_id,
  linked_rng_provider_version,
  entropy_provider_type,
  drbg_type,
  hash_algorithm,
  security_strength_bits,
  reseed_policy,
  session_isolation_policy,
  zeroization_policy,
  startup_self_test_supported,
  known_answer_test_supported,
  continuous_health_test_supported,
  production_eligible,
  lifecycle_state,
  failure_mode,
  sampling_capabilities,
  content_hash,
  certification_binding
) values (
  '${id}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  ${sqlString(outcomeProviderId)},
  ${sqlString(outcomeProviderVersion)},
  ${sqlString(linkedRngProviderId)},
  ${sqlString(linkedRngProviderVersion)},
  ${sqlString(entropyProviderType)},
  'HMAC_DRBG',
  ${sqlString(hashAlgorithm)},
  ${securityStrengthBits},
  ${sqlJson(reseedPolicy)},
  ${sqlJson(sessionIsolationPolicy)},
  ${sqlJson(zeroizationPolicy)},
  ${startupSelfTestSupported ? "true" : "false"},
  ${knownAnswerTestSupported ? "true" : "false"},
  ${continuousHealthTestSupported ? "true" : "false"},
  ${productionEligible ? "true" : "false"},
  ${sqlString(lifecycleState)},
  ${sqlString(failureMode)},
  ${sqlJson(samplingCapabilities)},
  ${sqlString(contentHash)},
  ${certificationBinding === null ? "null" : sqlString(certificationBinding)}
);`;
}

function drbgSessionEvidenceInsertSql({
  sessionId = randomUUID(),
  drawRequestScope,
  providerId,
  providerVersion = "1.0.0",
  entropyProviderId,
  entropyProviderVersion = "1.0.0",
  reseedCounter = 1,
  personalizationStringHash,
  nonceHash,
  seedCommitmentHash,
  startupSelfTestResult = "Passed",
  knownAnswerTestResult = "Passed",
  continuousTestResult = "Passed",
  canonicalEvidenceHash,
}) {
  return `
insert into game_engine.drbg_session_evidence (
  session_id,
  draw_request_scope,
  provider_id,
  provider_version,
  entropy_provider_id,
  entropy_provider_version,
  reseed_counter,
  personalization_string_hash,
  nonce_hash,
  seed_commitment_hash,
  startup_self_test_result,
  known_answer_test_result,
  continuous_test_result,
  generated_at,
  destroyed_zeroized_at,
  canonical_evidence_hash,
  signing_metadata
) values (
  '${sessionId}',
  ${sqlString(drawRequestScope)},
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  ${sqlString(entropyProviderId)},
  ${sqlString(entropyProviderVersion)},
  ${reseedCounter},
  ${sqlString(personalizationStringHash)},
  ${sqlString(nonceHash)},
  ${sqlString(seedCommitmentHash)},
  ${sqlString(startupSelfTestResult)},
  ${sqlString(knownAnswerTestResult)},
  ${sqlString(continuousTestResult)},
  now(),
  now() + interval '1 second',
  ${sqlString(canonicalEvidenceHash)},
  ${sqlJson({ signingKeyId: "qa-signing-key", signature: "placeholder" })}
);`;
}

const runId = randomUUID();
const outcomeProviderId = `outcome-provider:p0-007-2:${runId}`;
const rngProviderId = `rng-provider:p0-007-2:${runId}`;
const entropyProviderId = `entropy-provider:p0-007-2:${runId}`;
const csprngProviderId = `csprng-provider:p0-007-2:${runId}`;
const outcomeEventsBefore = rowCount("select count(*) from game_engine.outcome_events;");

addCheck("entropy provider table exists", existsRegclass("game_engine.entropy_provider_definitions"));
addCheck("certified CSPRNG provider table exists", existsRegclass("game_engine.csprng_provider_definitions"));
addCheck("DRBG session evidence table exists", existsRegclass("game_engine.drbg_session_evidence"));

runSql(outcomeProviderInsertSql({
  providerId: outcomeProviderId,
  contentHash: `sha256:p0-007-2-outcome-provider:${runId}`,
}));

runSql(rngProviderInsertSql({
  providerId: rngProviderId,
  contentHash: `sha256:p0-007-2-rng-provider:${runId}`,
}));

runSql(entropyProviderInsertSql({
  providerId: entropyProviderId,
  contentHash: `sha256:p0-007-2-entropy-provider:${runId}`,
}));
addCheck("valid OS entropy provider persists", rowCount(`
select count(*)
from game_engine.entropy_provider_definitions
where provider_id = ${sqlString(entropyProviderId)}
  and provider_type = 'OS_CSPRNG'
  and production_eligible = true
  and failure_mode = 'FailClosed';
`) === 1);

runSql(csprngProviderInsertSql({
  providerId: csprngProviderId,
  outcomeProviderId,
  linkedRngProviderId: rngProviderId,
  contentHash: `sha256:p0-007-2-csprng-provider:${runId}`,
}));
addCheck("valid certified CSPRNG contract persists", rowCount(`
select count(*)
from game_engine.csprng_provider_definitions
where provider_id = ${sqlString(csprngProviderId)}
  and outcome_provider_id = ${sqlString(outcomeProviderId)}
  and linked_rng_provider_id = ${sqlString(rngProviderId)}
  and production_eligible = true
  and certification_binding is null;
`) === 1);

const simulationEntropy = runSql(entropyProviderInsertSql({
  providerId: `${entropyProviderId}:simulation`,
  providerType: "TEST_SIMULATION",
  productionEligible: true,
  contentHash: `sha256:p0-007-2-simulation-entropy:${runId}`,
}), { allowFailure: true });
addCheck("simulation/test entropy provider cannot be production eligible", simulationEntropy.status !== 0, {
  stderr: simulationEntropy.stderr.trim(),
});

const missingHealthEntropy = runSql(entropyProviderInsertSql({
  providerId: `${entropyProviderId}:missing-health`,
  healthTestCapabilities: [],
  contentHash: `sha256:p0-007-2-missing-health-entropy:${runId}`,
}), { allowFailure: true });
addCheck("missing entropy health support blocks eligibility", missingHealthEntropy.status !== 0, {
  stderr: missingHealthEntropy.stderr.trim(),
});

const nonFailClosedEntropy = runSql(entropyProviderInsertSql({
  providerId: `${entropyProviderId}:non-fail-closed`,
  failureMode: "Disabled",
  contentHash: `sha256:p0-007-2-non-fail-closed-entropy:${runId}`,
}), { allowFailure: true });
addCheck("non-fail-closed entropy provider rejected", nonFailClosedEntropy.status !== 0, {
  stderr: nonFailClosedEntropy.stderr.trim(),
});

const missingKatCsprng = runSql(csprngProviderInsertSql({
  providerId: `${csprngProviderId}:missing-kat`,
  outcomeProviderId,
  linkedRngProviderId: rngProviderId,
  knownAnswerTestSupported: false,
  contentHash: `sha256:p0-007-2-missing-kat-csprng:${runId}`,
}), { allowFailure: true });
addCheck("missing KAT support blocks eligibility", missingKatCsprng.status !== 0, {
  stderr: missingKatCsprng.stderr.trim(),
});

const missingContinuousCsprng = runSql(csprngProviderInsertSql({
  providerId: `${csprngProviderId}:missing-continuous`,
  outcomeProviderId,
  linkedRngProviderId: rngProviderId,
  continuousHealthTestSupported: false,
  contentHash: `sha256:p0-007-2-missing-continuous-csprng:${runId}`,
}), { allowFailure: true });
addCheck("missing continuous health support blocks eligibility", missingContinuousCsprng.status !== 0, {
  stderr: missingContinuousCsprng.stderr.trim(),
});

const nonFailClosedCsprng = runSql(csprngProviderInsertSql({
  providerId: `${csprngProviderId}:non-fail-closed`,
  outcomeProviderId,
  linkedRngProviderId: rngProviderId,
  failureMode: "Disabled",
  contentHash: `sha256:p0-007-2-non-fail-closed-csprng:${runId}`,
}), { allowFailure: true });
addCheck("non-fail-closed CSPRNG provider rejected", nonFailClosedCsprng.status !== 0, {
  stderr: nonFailClosedCsprng.stderr.trim(),
});

const unsupportedSampling = runSql(csprngProviderInsertSql({
  providerId: `${csprngProviderId}:unsupported-sampling`,
  outcomeProviderId,
  linkedRngProviderId: rngProviderId,
  samplingCapabilities: ["FisherYatesShuffle"],
  contentHash: `sha256:p0-007-2-unsupported-sampling:${runId}`,
}), { allowFailure: true });
addCheck("unsupported sampling capability blocks activation", unsupportedSampling.status !== 0, {
  stderr: unsupportedSampling.stderr.trim(),
});

const rawEntropy = runSql(entropyProviderInsertSql({
  providerId: `${entropyProviderId}:raw-entropy`,
  entropySourceMetadata: { rawEntropy: "forbidden" },
  contentHash: `sha256:p0-007-2-raw-entropy:${runId}`,
}), { allowFailure: true });
addCheck("raw entropy persistence rejected", rawEntropy.status !== 0, {
  stderr: rawEntropy.stderr.trim(),
});

const rawSeedPolicy = runSql(csprngProviderInsertSql({
  providerId: `${csprngProviderId}:raw-seed-policy`,
  outcomeProviderId,
  linkedRngProviderId: rngProviderId,
  reseedPolicy: { seedMaterial: "forbidden" },
  contentHash: `sha256:p0-007-2-raw-seed-policy:${runId}`,
}), { allowFailure: true });
addCheck("raw seed/state persistence rejected", rawSeedPolicy.status !== 0, {
  stderr: rawSeedPolicy.stderr.trim(),
});

const evidenceHash = `sha256:p0-007-2-drbg-evidence:${runId}`;
runSql(drbgSessionEvidenceInsertSql({
  drawRequestScope: `draw:p0-007-2:${runId}`,
  providerId: csprngProviderId,
  entropyProviderId,
  personalizationStringHash: `sha256:p0-007-2-personalization:${runId}`,
  nonceHash: `sha256:p0-007-2-nonce:${runId}`,
  seedCommitmentHash: `sha256:p0-007-2-seed-commitment:${runId}`,
  canonicalEvidenceHash: evidenceHash,
}));
addCheck("DRBG session evidence persists without secrets", rowCount(`
select count(*)
from game_engine.drbg_session_evidence
where provider_id = ${sqlString(csprngProviderId)}
  and entropy_provider_id = ${sqlString(entropyProviderId)}
  and canonical_evidence_hash = ${sqlString(evidenceHash)}
  and destroyed_zeroized_at >= generated_at;
`) === 1);

const failedEvidence = runSql(drbgSessionEvidenceInsertSql({
  drawRequestScope: `draw:p0-007-2-failed:${runId}`,
  providerId: csprngProviderId,
  entropyProviderId,
  personalizationStringHash: `sha256:p0-007-2-failed-personalization:${runId}`,
  nonceHash: `sha256:p0-007-2-failed-nonce:${runId}`,
  seedCommitmentHash: `sha256:p0-007-2-failed-seed-commitment:${runId}`,
  startupSelfTestResult: "Failed",
  canonicalEvidenceHash: `sha256:p0-007-2-failed-evidence:${runId}`,
}), { allowFailure: true });
addCheck("failed DRBG evidence rejected", failedEvidence.status !== 0, {
  stderr: failedEvidence.stderr.trim(),
});

const duplicateProviderVersion = runSql(csprngProviderInsertSql({
  providerId: csprngProviderId,
  outcomeProviderId,
  linkedRngProviderId: rngProviderId,
  contentHash: `sha256:p0-007-2-duplicate-provider-version:${runId}`,
}), { allowFailure: true });
addCheck("duplicate provider version blocked", duplicateProviderVersion.status !== 0, {
  stderr: duplicateProviderVersion.stderr.trim(),
});

const duplicateProviderHash = runSql(csprngProviderInsertSql({
  providerId: `${csprngProviderId}:duplicate-hash`,
  outcomeProviderId,
  linkedRngProviderId: rngProviderId,
  contentHash: `sha256:p0-007-2-csprng-provider:${runId}`,
}), { allowFailure: true });
addCheck("duplicate provider hash blocked", duplicateProviderHash.status !== 0, {
  stderr: duplicateProviderHash.stderr.trim(),
});

const updateBlocked = runSql(`
update game_engine.csprng_provider_definitions
set lifecycle_state = 'Suspended'
where provider_id = ${sqlString(csprngProviderId)};`, { allowFailure: true });
addCheck("update blocked", updateBlocked.status !== 0, {
  stderr: updateBlocked.stderr.trim(),
});

const deleteBlocked = runSql(`
delete from game_engine.drbg_session_evidence
where provider_id = ${sqlString(csprngProviderId)};`, { allowFailure: true });
addCheck("delete blocked", deleteBlocked.status !== 0, {
  stderr: deleteBlocked.stderr.trim(),
});

addCheck("optional jurisdiction allowed", rowCount(`
select count(*)
from game_engine.outcome_provider_definitions
where provider_id = ${sqlString(outcomeProviderId)}
  and jurisdiction_profile_references is null;
`) === 1);

addCheck("optional certification allowed when manifest does not require it", rowCount(`
select count(*)
from game_engine.csprng_provider_definitions
where provider_id = ${sqlString(csprngProviderId)}
  and certification_binding is null;
`) === 1);

addCheck("no raw seed column exists", !columnExists("game_engine", "drbg_session_evidence", "raw_seed"));
addCheck("no raw entropy column exists", !columnExists("game_engine", "drbg_session_evidence", "raw_entropy"));
addCheck("no internal DRBG state column exists", !columnExists("game_engine", "drbg_session_evidence", "drbg_state"));

const outcomeEventsAfter = rowCount("select count(*) from game_engine.outcome_events;");
addCheck("no production outcome generation occurs", outcomeEventsAfter === outcomeEventsBefore, {
  before: outcomeEventsBefore,
  after: outcomeEventsAfter,
  OUTCOME_AUTHORITY: process.env.OUTCOME_AUTHORITY ?? null,
  PRODUCTION_OUTCOME_AUTHORITY_ENABLED: process.env.PRODUCTION_OUTCOME_AUTHORITY_ENABLED ?? null,
});

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checkCount: checks.length,
  failedCount: failed.length,
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
