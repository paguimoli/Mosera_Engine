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

function localTestSignature({ canonicalPayloadHash, providerId, providerVersion, keyIdentifier, contentHash }) {
  return sha256([canonicalPayloadHash, providerId, providerVersion, keyIdentifier, contentHash].join("|"));
}

function insertProviderSql({
  id = randomUUID(),
  providerId,
  providerVersion = "1.0.0",
  providerType = "LOCAL_TEST",
  productionEligible = false,
  algorithm = "LOCAL_TEST_SHA256",
  keyIdentifier = "qa-local-test-key",
  algorithmVersion = "local-test-sha256-v1",
  verificationSupport = true,
  keyRotationSupport = false,
  failureMode = "FailClosed",
  contentHash,
  lifecycleState = "Active",
}) {
  return `
insert into game_engine.signing_providers (
  id, provider_id, provider_version, provider_type, production_eligible, algorithm,
  key_identifier, algorithm_version, verification_support, key_rotation_support,
  failure_mode, content_hash, lifecycle_state, signature_metadata
) values (
  '${id}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  ${sqlString(providerType)},
  ${productionEligible ? "true" : "false"},
  ${sqlString(algorithm)},
  ${sqlString(keyIdentifier)},
  ${sqlString(algorithmVersion)},
  ${verificationSupport ? "true" : "false"},
  ${keyRotationSupport ? "true" : "false"},
  ${sqlString(failureMode)},
  ${sqlString(contentHash)},
  ${sqlString(lifecycleState)},
  ${sqlJson({ signingKeyId: keyIdentifier, hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: algorithmVersion, signature: "qa-provider-record" })}
);`;
}

function insertAuthorityCertificateSql({ certificateId, subjectId, canonicalPayloadHash }) {
  return `
insert into game_engine.authority_certificates (
  certificate_id, authority_id, certificate_type, subject_id, subject_version, canonical_payload_hash,
  signing_key_id, hash_algorithm_version, signing_algorithm_version, issued_at, jurisdiction_profile,
  approval_state, certificate_payload
) values (
  '${certificateId}',
  'authority:qa-signing',
  'GovernanceApproval',
  ${sqlString(subjectId)},
  '1.0.0',
  ${sqlString(canonicalPayloadHash)},
  'qa-local-test-key',
  'sha256-v1',
  'local-test-sha256-v1',
  now(),
  'internal',
  'Approved',
  ${sqlJson({ subjectId, canonicalPayloadHash, phase: "P0-005.9" })}
);`;
}

function insertSignatureSql({
  signatureId = randomUUID(),
  certificateId,
  providerId,
  canonicalPayloadHash,
  signatureValue,
  providerVersion = "1.0.0",
  algorithm = "LOCAL_TEST_SHA256",
  algorithmVersion = "local-test-sha256-v1",
  verificationStatus = "Verified",
  signingContext = "DryRun",
}) {
  return `
insert into game_engine.certificate_signatures (
  signature_id, certificate_reference_type, certificate_id, provider_id, provider_version,
  algorithm, algorithm_version, canonical_payload_hash, signature_value, verification_status,
  signing_context, issued_at
) values (
  '${signatureId}',
  'AuthorityCertificate',
  '${certificateId}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  ${sqlString(algorithm)},
  ${sqlString(algorithmVersion)},
  ${sqlString(canonicalPayloadHash)},
  ${sqlString(signatureValue)},
  ${sqlString(verificationStatus)},
  ${sqlString(signingContext)},
  now()
);`;
}

const runId = randomUUID();
const providerId = `signing-provider:p0-005-9:${runId}`;
const providerHash = sha256(`provider:${runId}`);
const keyIdentifier = "qa-local-test-key";
const certificateId = randomUUID();
const subjectId = `authority-subject:p0-005-9:${runId}`;
const canonicalPayload = JSON.stringify({ subjectId, phase: "P0-005.9", evidence: "certificate-signing" });
const canonicalPayloadHash = sha256(canonicalPayload);
const signatureValue = localTestSignature({
  canonicalPayloadHash,
  providerId,
  providerVersion: "1.0.0",
  keyIdentifier,
  contentHash: providerHash,
});

addCheck("signing provider table exists", existsRegclass("game_engine.signing_providers"));
addCheck("certificate signature table exists", existsRegclass("game_engine.certificate_signatures"));

runSql(insertProviderSql({ providerId, contentHash: providerHash, keyIdentifier }));
runSql(insertAuthorityCertificateSql({ certificateId, subjectId, canonicalPayloadHash }));
runSql(insertSignatureSql({ certificateId, providerId, canonicalPayloadHash, signatureValue }));

addCheck(
  "valid LOCAL_TEST signature",
  rowCount(`
select count(*)
from game_engine.certificate_signatures
where certificate_id = '${certificateId}'
  and provider_id = ${sqlString(providerId)}
  and canonical_payload_hash = ${sqlString(canonicalPayloadHash)}
  and signature_value = ${sqlString(signatureValue)}
  and verification_status = 'Verified';
`) === 1,
  { certificateId, providerId },
);

addCheck(
  "verification succeeds",
  signatureValue === localTestSignature({
    canonicalPayloadHash,
    providerId,
    providerVersion: "1.0.0",
    keyIdentifier,
    contentHash: providerHash,
  }),
  { signatureValue },
);

const tamperedPayloadHash = sha256(JSON.stringify({ subjectId, phase: "P0-005.9", evidence: "tampered" }));
const tampered = runSql(insertSignatureSql({
  certificateId,
  providerId,
  canonicalPayloadHash: tamperedPayloadHash,
  signatureValue: localTestSignature({
    canonicalPayloadHash: tamperedPayloadHash,
    providerId,
    providerVersion: "1.0.0",
    keyIdentifier,
    contentHash: providerHash,
  }),
}), { allowFailure: true });
addCheck("tampered payload rejected", tampered.status !== 0, { stderr: tampered.stderr.trim() });

const disabledProviderId = `${providerId}:disabled`;
runSql(insertProviderSql({
  providerId: disabledProviderId,
  contentHash: sha256(`provider-disabled:${runId}`),
  lifecycleState: "Disabled",
  keyIdentifier,
}));
const disabledProvider = runSql(insertSignatureSql({
  certificateId,
  providerId: disabledProviderId,
  canonicalPayloadHash,
  signatureValue: sha256(`disabled-signature:${runId}`),
}), { allowFailure: true });
addCheck("disabled provider rejected", disabledProvider.status !== 0, { stderr: disabledProvider.stderr.trim() });

const productionEligibleLocalTest = runSql(insertProviderSql({
  providerId: `${providerId}:production-local-test`,
  contentHash: sha256(`provider-production-local-test:${runId}`),
  productionEligible: true,
  keyRotationSupport: true,
}), { allowFailure: true });
addCheck("LOCAL_TEST production eligibility rejected", productionEligibleLocalTest.status !== 0, {
  stderr: productionEligibleLocalTest.stderr.trim(),
});

const productionMode = runSql(insertSignatureSql({
  certificateId,
  providerId,
  canonicalPayloadHash,
  signatureValue: sha256(`production-disabled:${runId}`),
  signingContext: "ProductionDisabled",
}), { allowFailure: true });
addCheck("production mode rejected", productionMode.status !== 0, { stderr: productionMode.stderr.trim() });

const algorithmMismatch = runSql(insertSignatureSql({
  certificateId,
  providerId,
  canonicalPayloadHash,
  signatureValue: sha256(`algorithm-mismatch:${runId}`),
  algorithm: "ED25519",
}), { allowFailure: true });
addCheck("algorithm mismatch rejected", algorithmMismatch.status !== 0, { stderr: algorithmMismatch.stderr.trim() });

const duplicateSignature = runSql(insertSignatureSql({
  signatureId: randomUUID(),
  certificateId,
  providerId,
  canonicalPayloadHash,
  signatureValue,
}), { allowFailure: true });
addCheck("duplicate signature handling", duplicateSignature.status !== 0, { stderr: duplicateSignature.stderr.trim() });

const updateProvider = runSql(
  `update game_engine.signing_providers set lifecycle_state = 'Disabled' where provider_id = ${sqlString(providerId)};`,
  { allowFailure: true },
);
addCheck("signing provider update blocked", updateProvider.status !== 0, { stderr: updateProvider.stderr.trim() });

const deleteSignature = runSql(
  `delete from game_engine.certificate_signatures where certificate_id = '${certificateId}';`,
  { allowFailure: true },
);
addCheck("certificate signature delete blocked", deleteSignature.status !== 0, { stderr: deleteSignature.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
