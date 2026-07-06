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

function providerInsertSql({
  id = randomUUID(),
  providerId,
  providerVersion = "1.0.0",
  providerType = "OS_CSPRNG",
  productionEligible = true,
  certificationState = "InternalVerified",
  algorithmReferences = ["NIST-SP800-90B-health-tests", "OS-CSPRNG-v1"],
  entropySourceMetadata = { source: "kernel-csprng", platform: "linux" },
  healthTestCapabilities = ["startup-health-test", "continuous-randomness-test"],
  failureMode = "FailClosed",
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
  ${sqlString(providerType)},
  ${productionEligible ? "true" : "false"},
  ${sqlString(certificationState)},
  ${sqlJson(algorithmReferences)},
  ${sqlJson(entropySourceMetadata)},
  ${sqlJson(healthTestCapabilities)},
  ${sqlString(failureMode)},
  ${sqlString(contentHash)},
  ${sqlJson({
    signingKeyId: "qa-signing-key",
    hashAlgorithmVersion: "sha256-v1",
    signingAlgorithmVersion: "ed25519-v1",
    signature: "qa-signature",
  })}
);`;
}

function evidenceInsertSql({
  evidenceId = randomUUID(),
  providerId,
  providerVersion = "1.0.0",
  entropySourceReference = "entropy-source:kernel-csprng",
  healthTestResult = "Passed",
  knownAnswerTestResult = "NotApplicable",
  continuousTestResult = "Passed",
  canonicalEvidenceHash,
}) {
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
  '${evidenceId}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  ${sqlString(entropySourceReference)},
  ${sqlString(healthTestResult)},
  ${sqlString(knownAnswerTestResult)},
  ${sqlString(continuousTestResult)},
  now(),
  ${sqlString(canonicalEvidenceHash)},
  ${sqlJson({
    signingKeyId: "qa-signing-key",
    hashAlgorithmVersion: "sha256-v1",
    signingAlgorithmVersion: "ed25519-v1",
    signature: "qa-signature",
  })}
);`;
}

const runId = randomUUID();
const providerId = `rng-provider:p0-005-5:${runId}`;
const providerHash = `sha256:p0-005-5-provider:${runId}`;
const evidenceHash = `sha256:p0-005-5-evidence:${runId}`;

addCheck("rng provider definition table exists", existsRegclass("game_engine.rng_provider_definitions"));
addCheck("rng provider evidence table exists", existsRegclass("game_engine.rng_provider_evidence"));

runSql(providerInsertSql({ providerId, contentHash: providerHash }));
addCheck(
  "valid production-eligible provider persists",
  rowCount(`
select count(*)
from game_engine.rng_provider_definitions
where provider_id = ${sqlString(providerId)}
  and provider_version = '1.0.0'
  and provider_type = 'OS_CSPRNG'
  and production_eligible = true
  and failure_mode = 'FailClosed'
  and content_hash = ${sqlString(providerHash)};
`) === 1,
  { providerId, providerHash },
);

runSql(evidenceInsertSql({ providerId, canonicalEvidenceHash: evidenceHash }));
addCheck(
  "evidence persists",
  rowCount(`
select count(*)
from game_engine.rng_provider_evidence
where provider_id = ${sqlString(providerId)}
  and provider_version = '1.0.0'
  and health_test_result = 'Passed'
  and continuous_test_result = 'Passed'
  and canonical_evidence_hash = ${sqlString(evidenceHash)};
`) === 1,
  { providerId, evidenceHash },
);

const deterministicProvider = runSql(providerInsertSql({
  providerId: `${providerId}:deterministic`,
  providerType: "TEST_DETERMINISTIC",
  productionEligible: true,
  contentHash: `sha256:p0-005-5-deterministic:${runId}`,
}), { allowFailure: true });
addCheck("deterministic provider cannot be production eligible", deterministicProvider.status !== 0, {
  stderr: deterministicProvider.stderr.trim(),
});

const simulationProvider = runSql(providerInsertSql({
  providerId: `${providerId}:simulation`,
  providerType: "SIMULATION",
  productionEligible: true,
  contentHash: `sha256:p0-005-5-simulation:${runId}`,
}), { allowFailure: true });
addCheck("simulation provider cannot be production eligible", simulationProvider.status !== 0, {
  stderr: simulationProvider.stderr.trim(),
});

const missingHealthProvider = runSql(providerInsertSql({
  providerId: `${providerId}:missing-health`,
  healthTestCapabilities: [],
  contentHash: `sha256:p0-005-5-missing-health:${runId}`,
}), { allowFailure: true });
addCheck("missing health capability rejected for production provider", missingHealthProvider.status !== 0, {
  stderr: missingHealthProvider.stderr.trim(),
});

const nonFailClosedProvider = runSql(providerInsertSql({
  providerId: `${providerId}:non-fail-closed`,
  failureMode: "Disabled",
  contentHash: `sha256:p0-005-5-non-fail-closed:${runId}`,
}), { allowFailure: true });
addCheck("production provider without fail-closed mode rejected", nonFailClosedProvider.status !== 0, {
  stderr: nonFailClosedProvider.stderr.trim(),
});

const missingHealthEvidence = runSql(evidenceInsertSql({
  providerId,
  healthTestResult: "Missing",
  canonicalEvidenceHash: `sha256:p0-005-5-missing-evidence:${runId}`,
}), { allowFailure: true });
addCheck("missing health evidence rejected", missingHealthEvidence.status !== 0, {
  stderr: missingHealthEvidence.stderr.trim(),
});

const failedContinuousEvidence = runSql(evidenceInsertSql({
  providerId,
  continuousTestResult: "Failed",
  canonicalEvidenceHash: `sha256:p0-005-5-failed-continuous:${runId}`,
}), { allowFailure: true });
addCheck("failed continuous evidence rejected", failedContinuousEvidence.status !== 0, {
  stderr: failedContinuousEvidence.stderr.trim(),
});

const duplicateProviderVersion = runSql(providerInsertSql({
  providerId,
  contentHash: `sha256:p0-005-5-provider-duplicate-version:${runId}`,
}), { allowFailure: true });
addCheck("duplicate provider version blocked", duplicateProviderVersion.status !== 0, {
  stderr: duplicateProviderVersion.stderr.trim(),
});

const duplicateProviderHash = runSql(providerInsertSql({
  providerId: `${providerId}:duplicate-hash`,
  contentHash: providerHash,
}), { allowFailure: true });
addCheck("duplicate provider hash blocked", duplicateProviderHash.status !== 0, {
  stderr: duplicateProviderHash.stderr.trim(),
});

const duplicateEvidenceHash = runSql(evidenceInsertSql({
  providerId,
  canonicalEvidenceHash: evidenceHash,
}), { allowFailure: true });
addCheck("duplicate evidence hash blocked", duplicateEvidenceHash.status !== 0, {
  stderr: duplicateEvidenceHash.stderr.trim(),
});

addCheck(
  "provider lookup by id version hash works",
  rowCount(`
select count(*)
from game_engine.rng_provider_definitions
where provider_id = ${sqlString(providerId)}
  and provider_version = '1.0.0'
  and content_hash = ${sqlString(providerHash)};
`) === 1,
  { providerId, providerHash },
);

addCheck(
  "evidence lookup by provider version hash works",
  rowCount(`
select count(*)
from game_engine.rng_provider_evidence
where provider_id = ${sqlString(providerId)}
  and provider_version = '1.0.0'
  and canonical_evidence_hash = ${sqlString(evidenceHash)};
`) === 1,
  { providerId, evidenceHash },
);

const updateProvider = runSql(
  `update game_engine.rng_provider_definitions set production_eligible = false where provider_id = ${sqlString(providerId)};`,
  { allowFailure: true },
);
addCheck("provider update blocked", updateProvider.status !== 0, { stderr: updateProvider.stderr.trim() });

const deleteEvidence = runSql(
  `delete from game_engine.rng_provider_evidence where provider_id = ${sqlString(providerId)};`,
  { allowFailure: true },
);
addCheck("evidence delete blocked", deleteEvidence.status !== 0, { stderr: deleteEvidence.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
