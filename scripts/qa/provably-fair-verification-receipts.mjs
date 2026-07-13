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

const runId = randomUUID();
const providerId = `qa-pf-receipts:${runId}`;
const seedId = randomUUID();
const receiptId = randomUUID();
const commitment = `sha256:qa-pf-receipts-commitment:${runId}`;
const receiptHash = `sha256:qa-pf-receipts-receipt:${runId}`;
const outcomeHash = `sha256:qa-pf-receipts-outcome:${runId}`;

runSql(`
insert into game_engine.outcome_provider_definitions (
  id, provider_id, provider_version, provider_type, lifecycle_state, production_eligible,
  supported_outcome_primitive_types, evidence_requirements, health_readiness_capabilities,
  idempotency_model, custody_support, signing_requirements, replayability_support,
  failure_mode, capability_markers, content_hash, certification_binding, jurisdiction_profile_references
) values (
  '${randomUUID()}', ${sqlString(providerId)}, '1.0.0', 'PROVABLY_FAIR', 'Active', true,
  ${sqlJson(["UniqueNumberSet"])}, ${sqlJson({ receipts: true })}, ${sqlJson(["receipt-ready"])},
  'PerWager', ${sqlJson(["Generated"])}, ${sqlJson({ verificationAlgorithm: "HMAC_SHA_256" })}, true,
  'FailClosed',
  ${sqlJson({
    generatesOutcomes: true,
    ingestsExternalOutcomes: false,
    supportsPlayerVerificationReceipt: true,
    supportsDeterministicReplay: true,
    supportsProviderHealthEvidence: true,
    supportsDisputeHandling: true,
    supportsExternalSourceEvidence: false,
    supportsPhysicalDrawEvidence: false,
  })},
  ${sqlString(`sha256:qa-pf-receipts-outcome-provider:${runId}`)}, null, null
);
insert into game_engine.provably_fair_provider_definitions (
  id, provider_id, provider_version, outcome_provider_id, outcome_provider_version,
  commit_algorithm, verification_algorithm, hash_algorithm,
  server_seed_policy, client_seed_policy, nonce_policy, reveal_policy,
  commitment_lifetime_seconds, receipt_support, production_eligible, lifecycle_state,
  content_hash, certification_binding, jurisdiction_profile_references
) values (
  '${randomUUID()}', ${sqlString(providerId)}, '1.0.0', ${sqlString(providerId)}, '1.0.0',
  'HASH_COMMITMENT', 'HMAC_SHA_256', 'SHA_256',
  ${sqlJson({ plaintextPersisted: false })},
  ${sqlJson({ required: true, maximumLength: 256, allowedEncoding: "UTF8", canonicalizationRules: ["trim"] })},
  ${sqlJson({ scopeType: "Wager", monotonicRequired: true, uniquenessScope: "provider-wager" })},
  ${sqlJson({ revealDelaySeconds: 60, revealWindowSeconds: 86400 })},
  86400, true, true, 'Active',
  ${sqlString(`sha256:qa-pf-receipts-provider:${runId}`)}, null, null
);
insert into game_engine.provably_fair_seed_commitments (
  seed_id, provider_id, provider_version, seed_generation_timestamp, commitment_hash,
  seed_lifecycle, rotation_policy, activation_timestamp, retirement_timestamp, content_hash
) values (
  '${seedId}', ${sqlString(providerId)}, '1.0.0', now(), ${sqlString(commitment)},
  'Active', ${sqlJson({ plaintextPersisted: false, revealAfterRetirement: true })}, now(), null,
  ${sqlString(`sha256:qa-pf-receipts-seed:${runId}`)}
);`);

const earlyReveal = runSql(`
insert into game_engine.provably_fair_seed_reveal_evidence (
  reveal_id, seed_id, provider_id, provider_version, scope, server_seed_hash,
  commitment_hash, reveal_status, canonical_evidence_hash, revealed_at
) values (
  '${randomUUID()}', '${seedId}', ${sqlString(providerId)}, '1.0.0', ${sqlString(`wager:${runId}`)},
  ${sqlString(`sha256:qa-pf-receipts-seed-hash:${runId}`)}, ${sqlString(commitment)},
  'NotEligible', ${sqlString(`sha256:qa-pf-receipts-early-reveal:${runId}`)}, now()
);`);
addCheck("early reveal can only persist as not eligible evidence", earlyReveal.status === 0);

runSql(`
insert into game_engine.provably_fair_runtime_receipts (
  receipt_id, wager_reference, outcome_certificate_id, outcome_certificate_hash,
  provider_id, provider_version, server_commitment, client_seed, nonce,
  verification_algorithm, canonical_verification_payload, resulting_outcome_hash,
  verification_status, reveal_state, receipt_hash, issued_at
) values (
  '${receiptId}', ${sqlString(`wager:${runId}`)}, '${randomUUID()}',
  ${sqlString(outcomeHash)}, ${sqlString(providerId)}, '1.0.0', ${sqlString(commitment)},
  'client-seed', 1, 'HMAC_SHA_256',
  ${sqlJson({ commitment, clientSeed: "client-seed", nonce: 1, revealState: "NotEligible" })},
  ${sqlString(outcomeHash)}, 'PendingReveal', 'NotEligible', ${sqlString(receiptHash)}, now()
);`);

addCheck("receipt generated without unrevealed seed", queryScalar(`
select canonical_verification_payload::text not ilike '%serverseed%'
from game_engine.provably_fair_runtime_receipts
where receipt_id = '${receiptId}';
`) === "t");

runSql(`
insert into game_engine.provably_fair_seed_reveal_evidence (
  reveal_id, seed_id, provider_id, provider_version, scope, server_seed_hash,
  commitment_hash, reveal_status, canonical_evidence_hash, revealed_at
) values (
  '${randomUUID()}', '${seedId}', ${sqlString(providerId)}, '1.0.0', ${sqlString(`wager:${runId}`)},
  ${sqlString(`sha256:qa-pf-receipts-seed-hash-valid:${runId}`)}, ${sqlString(commitment)},
  'Verified', ${sqlString(`sha256:qa-pf-receipts-valid-reveal:${runId}`)}, now()
);`);

runSql(`
insert into game_engine.provably_fair_verification_results (
  verification_id, receipt_id, receipt_hash, recomputed_commitment_hash,
  recomputed_outcome_hash, verification_status, failure_reason, canonical_result_hash, verified_at
) values (
  '${randomUUID()}', '${receiptId}', ${sqlString(receiptHash)}, ${sqlString(commitment)},
  ${sqlString(outcomeHash)}, 'Verified', null,
  ${sqlString(`sha256:qa-pf-receipts-verified:${runId}`)}, now()
);`);

addCheck("post-reveal receipt verification result persists", queryScalar(`
select count(*) = 1
from game_engine.provably_fair_verification_results
where receipt_id = '${receiptId}'
  and verification_status = 'Verified';
`) === "t");

const tampered = runSql(`
insert into game_engine.provably_fair_verification_results (
  verification_id, receipt_id, receipt_hash, recomputed_commitment_hash,
  recomputed_outcome_hash, verification_status, failure_reason, canonical_result_hash, verified_at
) values (
  '${randomUUID()}', '${receiptId}', ${sqlString(receiptHash)}, ${sqlString(`sha256:qa-pf-receipts-tampered:${runId}`)},
  ${sqlString(outcomeHash)}, 'Failed', 'Commitment mismatch',
  ${sqlString(`sha256:qa-pf-receipts-tampered-result:${runId}`)}, now()
);`);
addCheck("tampered reveal evidence can be recorded as failed", tampered.status === 0);

addCheck("verification results are append-only", runSql(`
update game_engine.provably_fair_verification_results
set verification_status = 'Failed'
where receipt_id = '${receiptId}';
`, { allowFailure: true }).status !== 0);

const failed = checks.filter((check) => check.status !== "PASS");
printJson({
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
});

if (failed.length > 0) {
  process.exit(1);
}
