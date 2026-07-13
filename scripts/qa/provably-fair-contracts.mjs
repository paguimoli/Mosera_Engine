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
  receiptSupport = true,
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
  'PROVABLY_FAIR',
  'Active',
  ${productionEligible ? "true" : "false"},
  ${sqlJson(["UniqueNumberSet", "WeightedSelection"])},
  ${sqlJson({ commitRevealEvidence: true, playerReceipt: receiptSupport })},
  ${sqlJson(["commitment-ready", "receipt-ready"])},
  'PerWager',
  ${sqlJson(["Generated", "Sealed", "Certified", "Disputed"])},
  ${sqlJson({ certificateSignatureRequired: true })},
  true,
  'FailClosed',
  ${sqlJson({
    generatesOutcomes: true,
    ingestsExternalOutcomes: false,
    supportsPlayerVerificationReceipt: receiptSupport,
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

function provablyFairProviderInsertSql({
  id = randomUUID(),
  providerId,
  providerVersion = "1.0.0",
  outcomeProviderId,
  outcomeProviderVersion = "1.0.0",
  commitAlgorithm = "HASH_COMMITMENT",
  verificationAlgorithm = "HMAC_SHA_256",
  hashAlgorithm = "SHA_256",
  serverSeedPolicy = { generation: "external-governed", plaintextPersisted: false },
  clientSeedPolicy = {
    required: true,
    maximumLength: 128,
    allowedEncoding: "UTF8",
    validationRules: ["non-empty", "max-length"],
    canonicalizationRules: ["trim", "unicode-nfc"],
  },
  noncePolicy = { scopeType: "Wager", monotonicRequired: true, uniquenessScope: "provider-wager" },
  revealPolicy = { revealDelaySeconds: 60, revealWindowSeconds: 86400, expiredRevealState: "Expired" },
  commitmentLifetimeSeconds = 86400,
  receiptSupport = true,
  productionEligible = true,
  lifecycleState = "Active",
  contentHash,
  certificationBinding = null,
  jurisdictionProfiles = null,
}) {
  return `
insert into game_engine.provably_fair_provider_definitions (
  id,
  provider_id,
  provider_version,
  outcome_provider_id,
  outcome_provider_version,
  commit_algorithm,
  verification_algorithm,
  hash_algorithm,
  server_seed_policy,
  client_seed_policy,
  nonce_policy,
  reveal_policy,
  commitment_lifetime_seconds,
  receipt_support,
  production_eligible,
  lifecycle_state,
  content_hash,
  certification_binding,
  jurisdiction_profile_references
) values (
  '${id}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  ${sqlString(outcomeProviderId)},
  ${sqlString(outcomeProviderVersion)},
  ${sqlString(commitAlgorithm)},
  ${sqlString(verificationAlgorithm)},
  ${sqlString(hashAlgorithm)},
  ${sqlJson(serverSeedPolicy)},
  ${sqlJson(clientSeedPolicy)},
  ${sqlJson(noncePolicy)},
  ${sqlJson(revealPolicy)},
  ${commitmentLifetimeSeconds},
  ${receiptSupport ? "true" : "false"},
  ${productionEligible ? "true" : "false"},
  ${sqlString(lifecycleState)},
  ${sqlString(contentHash)},
  ${certificationBinding === null ? "null" : sqlString(certificationBinding)},
  ${jurisdictionProfiles === null ? "null" : sqlJson(jurisdictionProfiles)}
);`;
}

function seedCommitmentInsertSql({
  seedId = randomUUID(),
  providerId,
  providerVersion = "1.0.0",
  commitmentHash,
  seedLifecycle = "Committed",
  rotationPolicy = { rotateAfterWagers: 10000, revealAfterRetirement: true },
  contentHash,
}) {
  return `
insert into game_engine.provably_fair_seed_commitments (
  seed_id,
  provider_id,
  provider_version,
  seed_generation_timestamp,
  commitment_hash,
  seed_lifecycle,
  rotation_policy,
  activation_timestamp,
  retirement_timestamp,
  content_hash
) values (
  '${seedId}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  now(),
  ${sqlString(commitmentHash)},
  ${sqlString(seedLifecycle)},
  ${sqlJson(rotationPolicy)},
  now(),
  null,
  ${sqlString(contentHash)}
);`;
}

function nonceInsertSql({
  id = randomUUID(),
  providerId,
  providerVersion = "1.0.0",
  providerScope,
  scopeType = "Wager",
  nonce,
  noncePolicy = { scopeType: "Wager", monotonicRequired: true, uniquenessScope: "provider-wager" },
  monotonicRequired = true,
  uniquenessScope = "provider-wager",
  contentHash,
}) {
  return `
insert into game_engine.provably_fair_nonce_sequences (
  id,
  provider_id,
  provider_version,
  provider_scope,
  scope_type,
  nonce,
  nonce_policy,
  monotonic_required,
  uniqueness_scope,
  content_hash
) values (
  '${id}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  ${sqlString(providerScope)},
  ${sqlString(scopeType)},
  ${nonce},
  ${sqlJson(noncePolicy)},
  ${monotonicRequired ? "true" : "false"},
  ${sqlString(uniquenessScope)},
  ${sqlString(contentHash)}
);`;
}

function outcomeFixtureSql({ outcomeId, certificateId, outcomeHash, runId }) {
  const drawId = randomUUID();

  return `
insert into game_engine.rng_provider_definitions (
  id, provider_id, provider_version, provider_type, production_eligible,
  certification_state, algorithm_references, entropy_source_metadata,
  health_test_capabilities, failure_mode, content_hash, signature_metadata
) values (
  '${randomUUID()}',
  ${sqlString(`rng-provider:provably-fair-fixture:${runId}`)},
  '1.0.0',
  'TEST_DETERMINISTIC',
  false,
  'None',
  ${sqlJson(["deterministic-fixture"])},
  ${sqlJson({ fixture: true })},
  ${sqlJson(["not-production"])},
  'Disabled',
  ${sqlString(`sha256:provably-fair-rng-fixture:${runId}`)},
  null
);

insert into game_engine.rng_provider_evidence (
  evidence_id, provider_id, provider_version, entropy_source_reference,
  health_test_result, known_answer_test_result, continuous_test_result,
  generated_at, canonical_evidence_hash, signing_metadata
) values (
  '${randomUUID()}',
  ${sqlString(`rng-provider:provably-fair-fixture:${runId}`)},
  '1.0.0',
  'fixture',
  'Passed',
  'NotApplicable',
  'Passed',
  now(),
  ${sqlString(`sha256:provably-fair-rng-evidence:${runId}`)},
  null
);

insert into game_engine.outcome_strategy_definitions (
  id, strategy_id, strategy_version, primitive_graph, input_schema,
  output_schema, constraints, jurisdiction_profile_references,
  lifecycle_state, content_hash, certification_binding_placeholder, signature_metadata
) values (
  '${randomUUID()}',
  ${sqlString(`outcome-strategy:provably-fair-fixture:${runId}`)},
  '1.0.0',
  ${sqlJson([{ nodeId: "n1", primitiveType: "UniqueNumberSet", minNumber: 1, maxNumber: 10, count: 3 }])},
  ${sqlJson({})},
  ${sqlJson({ result: "numbers" })},
  ${sqlJson({})},
  ${sqlJson([])},
  'GovernanceApproved',
  ${sqlString(`sha256:provably-fair-strategy-fixture:${runId}`)},
  null,
  null
);

insert into game_engine.outcome_events (
  outcome_id, request_id, draw_id, game_manifest_reference, strategy_id,
  strategy_version, rng_provider_id, rng_provider_version, rng_evidence_hash,
  idempotency_key, outcome_mode, outcome_payload, canonical_outcome_hash,
  generated_at
) values (
  '${outcomeId}',
  '${randomUUID()}',
  '${drawId}',
  'game-manifest:provably-fair-fixture',
  ${sqlString(`outcome-strategy:provably-fair-fixture:${runId}`)},
  '1.0.0',
  ${sqlString(`rng-provider:provably-fair-fixture:${runId}`)},
  '1.0.0',
  ${sqlString(`sha256:provably-fair-rng-evidence:${runId}`)},
  ${sqlString(`provably-fair-outcome:${runId}`)},
  'DryRun',
  ${sqlJson({ numbers: [1, 2, 3] })},
  ${sqlString(outcomeHash)},
  now()
);

insert into game_engine.outcome_certificates (
  certificate_id, outcome_id, draw_id, strategy_id, strategy_version,
  rng_provider_id, rng_provider_version, canonical_outcome_hash,
  evidence_hash_reference, previous_certificates, signing_metadata,
  custody_state, issued_at
) values (
  '${certificateId}',
  '${outcomeId}',
  '${drawId}',
  ${sqlString(`outcome-strategy:provably-fair-fixture:${runId}`)},
  '1.0.0',
  ${sqlString(`rng-provider:provably-fair-fixture:${runId}`)},
  '1.0.0',
  ${sqlString(outcomeHash)},
  ${sqlString(`sha256:provably-fair-rng-evidence:${runId}`)},
  ${sqlJson([])},
  null,
  'Generated',
  now()
);`;
}

function receiptInsertSql({
  receiptId = randomUUID(),
  wagerReference,
  outcomeCertificateId,
  outcomeCertificateHash,
  providerId,
  providerVersion = "1.0.0",
  serverCommitment,
  clientSeed = "client-seed-qa",
  nonce = 1,
  revealedServerSeedPlaceholder = null,
  verificationAlgorithm = "HMAC_SHA_256",
  canonicalVerificationPayload = { commitment: "hash-only", revealState: "PendingReveal" },
  verificationStatus = "PendingReveal",
  receiptHash,
  qrExportPayload = { exportVersion: "v1", publicOnly: true },
}) {
  return `
insert into game_engine.provably_fair_verification_receipts (
  receipt_id,
  wager_reference,
  outcome_certificate_id,
  outcome_certificate_hash,
  provider_id,
  provider_version,
  server_commitment,
  client_seed,
  nonce,
  revealed_server_seed_placeholder,
  verification_algorithm,
  canonical_verification_payload,
  verification_status,
  receipt_hash,
  receipt_signature,
  qr_export_payload
) values (
  '${receiptId}',
  ${sqlString(wagerReference)},
  '${outcomeCertificateId}',
  ${sqlString(outcomeCertificateHash)},
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  ${sqlString(serverCommitment)},
  ${sqlString(clientSeed)},
  ${nonce},
  ${revealedServerSeedPlaceholder === null ? "null" : sqlString(revealedServerSeedPlaceholder)},
  ${sqlString(verificationAlgorithm)},
  ${sqlJson(canonicalVerificationPayload)},
  ${sqlString(verificationStatus)},
  ${sqlString(receiptHash)},
  ${sqlJson({ signingKeyId: "qa-signing-key", signature: "placeholder" })},
  ${sqlJson(qrExportPayload)}
);`;
}

const runId = randomUUID();
const outcomeProviderId = `outcome-provider:p0-007-3:${runId}`;
const providerId = `provably-fair-provider:p0-007-3:${runId}`;
const commitmentHash = `sha256:p0-007-3-commitment:${runId}`;
const outcomeId = randomUUID();
const outcomeCertificateId = randomUUID();
const outcomeHash = `sha256:p0-007-3-outcome:${runId}`;

addCheck("provably fair provider table exists", existsRegclass("game_engine.provably_fair_provider_definitions"));
addCheck("seed commitment table exists", existsRegclass("game_engine.provably_fair_seed_commitments"));
addCheck("nonce sequence table exists", existsRegclass("game_engine.provably_fair_nonce_sequences"));
addCheck("verification receipt table exists", existsRegclass("game_engine.provably_fair_verification_receipts"));

runSql(outcomeProviderInsertSql({
  providerId: outcomeProviderId,
  contentHash: `sha256:p0-007-3-outcome-provider:${runId}`,
}));

runSql(provablyFairProviderInsertSql({
  providerId,
  outcomeProviderId,
  contentHash: `sha256:p0-007-3-provider:${runId}`,
}));

addCheck("valid provider persists", rowCount(`
select count(*)
from game_engine.provably_fair_provider_definitions
where provider_id = ${sqlString(providerId)}
  and outcome_provider_id = ${sqlString(outcomeProviderId)}
  and receipt_support = true
  and production_eligible = true
  and certification_binding is null
  and jurisdiction_profile_references is null;
`) === 1);

const invalidProvider = runSql(provablyFairProviderInsertSql({
  providerId: `${providerId}:invalid`,
  outcomeProviderId,
  receiptSupport: false,
  contentHash: `sha256:p0-007-3-provider-invalid:${runId}`,
}), { allowFailure: true });
addCheck("invalid provider rejected", invalidProvider.status !== 0, { stderr: invalidProvider.stderr.trim() });

const unsupportedHash = runSql(provablyFairProviderInsertSql({
  providerId: `${providerId}:unsupported-hash`,
  outcomeProviderId,
  hashAlgorithm: "MD5",
  contentHash: `sha256:p0-007-3-provider-unsupported-hash:${runId}`,
}), { allowFailure: true });
addCheck("provider using unsupported hash rejected", unsupportedHash.status !== 0, { stderr: unsupportedHash.stderr.trim() });

const negativeReveal = runSql(provablyFairProviderInsertSql({
  providerId: `${providerId}:negative-reveal`,
  outcomeProviderId,
  revealPolicy: { revealDelaySeconds: 60, revealWindowSeconds: -1 },
  contentHash: `sha256:p0-007-3-provider-negative-reveal:${runId}`,
}), { allowFailure: true });
addCheck("negative reveal windows rejected", negativeReveal.status !== 0, { stderr: negativeReveal.stderr.trim() });

const invalidSeedPolicy = runSql(provablyFairProviderInsertSql({
  providerId: `${providerId}:raw-seed-policy`,
  outcomeProviderId,
  serverSeedPolicy: { plaintextSeed: "forbidden" },
  contentHash: `sha256:p0-007-3-provider-raw-seed:${runId}`,
}), { allowFailure: true });
addCheck("invalid seed policy rejected", invalidSeedPolicy.status !== 0, { stderr: invalidSeedPolicy.stderr.trim() });

runSql(seedCommitmentInsertSql({
  providerId,
  commitmentHash,
  contentHash: `sha256:p0-007-3-seed-commitment:${runId}`,
}));
addCheck("commitment validation persists hash only", rowCount(`
select count(*)
from game_engine.provably_fair_seed_commitments
where provider_id = ${sqlString(providerId)}
  and commitment_hash = ${sqlString(commitmentHash)};
`) === 1);

runSql(nonceInsertSql({
  providerId,
  providerScope: `wager-scope:${runId}`,
  nonce: 1,
  contentHash: `sha256:p0-007-3-nonce-1:${runId}`,
}));

const duplicateNonce = runSql(nonceInsertSql({
  providerId,
  providerScope: `wager-scope:${runId}`,
  nonce: 1,
  contentHash: `sha256:p0-007-3-nonce-duplicate:${runId}`,
}), { allowFailure: true });
addCheck("duplicate nonce rejection", duplicateNonce.status !== 0, { stderr: duplicateNonce.stderr.trim() });

const decrementNonce = runSql(nonceInsertSql({
  providerId,
  providerScope: `wager-scope:${runId}`,
  nonce: 0,
  contentHash: `sha256:p0-007-3-nonce-decrement:${runId}`,
}), { allowFailure: true });
addCheck("nonce decrement rejected", decrementNonce.status !== 0, { stderr: decrementNonce.stderr.trim() });

runSql(nonceInsertSql({
  providerId,
  providerScope: `wager-scope:${runId}`,
  nonce: 2,
  contentHash: `sha256:p0-007-3-nonce-2:${runId}`,
}));
addCheck("nonce monotonic increment persists", rowCount(`
select count(*)
from game_engine.provably_fair_nonce_sequences
where provider_id = ${sqlString(providerId)}
  and provider_scope = ${sqlString(`wager-scope:${runId}`)};
`) === 2);

runSql(outcomeFixtureSql({ outcomeId, certificateId: outcomeCertificateId, outcomeHash, runId }));

runSql(receiptInsertSql({
  wagerReference: `wager:p0-007-3:${runId}`,
  outcomeCertificateId,
  outcomeCertificateHash: outcomeHash,
  providerId,
  serverCommitment: commitmentHash,
  receiptHash: `sha256:p0-007-3-receipt:${runId}`,
}));
addCheck("verification receipt persists", rowCount(`
select count(*)
from game_engine.provably_fair_verification_receipts
where provider_id = ${sqlString(providerId)}
  and outcome_certificate_id = '${outcomeCertificateId}'
  and receipt_hash = ${sqlString(`sha256:p0-007-3-receipt:${runId}`)};
`) === 1);

const missingCommitment = runSql(receiptInsertSql({
  wagerReference: `wager:p0-007-3-missing-commitment:${runId}`,
  outcomeCertificateId,
  outcomeCertificateHash: outcomeHash,
  providerId,
  serverCommitment: `sha256:p0-007-3-missing-commitment:${runId}`,
  receiptHash: `sha256:p0-007-3-receipt-missing-commitment:${runId}`,
}), { allowFailure: true });
addCheck("missing commitment rejected", missingCommitment.status !== 0, { stderr: missingCommitment.stderr.trim() });

const missingOutcomeCertificate = runSql(receiptInsertSql({
  wagerReference: `wager:p0-007-3-missing-certificate:${runId}`,
  outcomeCertificateId: randomUUID(),
  outcomeCertificateHash: outcomeHash,
  providerId,
  serverCommitment: commitmentHash,
  receiptHash: `sha256:p0-007-3-receipt-missing-certificate:${runId}`,
}), { allowFailure: true });
addCheck("receipt without Outcome Certificate reference rejected", missingOutcomeCertificate.status !== 0, {
  stderr: missingOutcomeCertificate.stderr.trim(),
});

const seedLeakReceipt = runSql(receiptInsertSql({
  wagerReference: `wager:p0-007-3-seed-leak:${runId}`,
  outcomeCertificateId,
  outcomeCertificateHash: outcomeHash,
  providerId,
  serverCommitment: commitmentHash,
  revealedServerSeedPlaceholder: "plaintext-serverSeed-forbidden",
  receiptHash: `sha256:p0-007-3-receipt-seed-leak:${runId}`,
}), { allowFailure: true });
addCheck("receipt exposing unrevealed seed rejected", seedLeakReceipt.status !== 0, {
  stderr: seedLeakReceipt.stderr.trim(),
});

const updateReceipt = runSql(`
update game_engine.provably_fair_verification_receipts
set verification_status = 'Verified'
where provider_id = ${sqlString(providerId)};`, { allowFailure: true });
addCheck("receipt immutability", updateReceipt.status !== 0, { stderr: updateReceipt.stderr.trim() });

const deleteProvider = runSql(`
delete from game_engine.provably_fair_provider_definitions
where provider_id = ${sqlString(providerId)};`, { allowFailure: true });
addCheck("append-only persistence", deleteProvider.status !== 0, { stderr: deleteProvider.stderr.trim() });

addCheck("optional certification", rowCount(`
select count(*)
from game_engine.provably_fair_provider_definitions
where provider_id = ${sqlString(providerId)}
  and certification_binding is null;
`) === 1);

addCheck("optional jurisdiction", rowCount(`
select count(*)
from game_engine.provably_fair_provider_definitions
where provider_id = ${sqlString(providerId)}
  and jurisdiction_profile_references is null;
`) === 1);

addCheck("no production activation", !existsRegclass("game_engine.outcome_authority_activations"), {
  OUTCOME_AUTHORITY: process.env.OUTCOME_AUTHORITY ?? null,
  PRODUCTION_OUTCOME_AUTHORITY_ENABLED: process.env.PRODUCTION_OUTCOME_AUTHORITY_ENABLED ?? null,
});

addCheck("no seed leakage columns", !columnExists("game_engine", "provably_fair_seed_commitments", "server_seed") &&
  !columnExists("game_engine", "provably_fair_seed_commitments", "plaintext_seed") &&
  !columnExists("game_engine", "provably_fair_verification_receipts", "raw_seed"));

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
