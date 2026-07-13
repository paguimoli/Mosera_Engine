import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

function insertProviderSql({ runId, providerId }) {
  return `
insert into game_engine.outcome_provider_definitions (
  id, provider_id, provider_version, provider_type, lifecycle_state, production_eligible,
  supported_outcome_primitive_types, evidence_requirements, health_readiness_capabilities,
  idempotency_model, custody_support, signing_requirements, replayability_support,
  failure_mode, capability_markers, content_hash, certification_binding, jurisdiction_profile_references
) values (
  '${randomUUID()}', ${sqlString(providerId)}, '1.0.0', 'PROVABLY_FAIR', 'Active', true,
  ${sqlJson(["UniqueNumberSet"])}, ${sqlJson({ commitRevealEvidence: true })}, ${sqlJson(["runtime-ready"])},
  'PerWager', ${sqlJson(["Generated", "Disputed"])}, ${sqlJson({ verificationAlgorithm: "HMAC_SHA_256" })}, true,
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
  ${sqlString(`sha256:qa-provably-fair-runtime-outcome-provider:${runId}`)}, null, null
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
  ${sqlJson({ plaintextPersisted: false, custodyBoundary: "protected-runtime" })},
  ${sqlJson({ required: true, maximumLength: 256, allowedEncoding: "UTF8", canonicalizationRules: ["trim"] })},
  ${sqlJson({ scopeType: "Wager", monotonicRequired: true, uniquenessScope: "provider-wager" })},
  ${sqlJson({ revealDelaySeconds: 60, revealWindowSeconds: 86400 })},
  86400, true, true, 'Active',
  ${sqlString(`sha256:qa-provably-fair-runtime-provider:${runId}`)}, null, null
);`;
}

const runId = randomUUID();
const providerId = `qa-provably-fair-runtime:${runId}`;
const seedId = randomUUID();
const receiptId = randomUUID();

addCheck("runtime service source exists", readFileSync("services/game-engine/src/GameEngine.Application/Services/ProvablyFairRuntimeServices.cs", "utf8").includes("ProvablyFairRuntimeService"));
addCheck("runtime receipt table exists", existsRegclass("game_engine.provably_fair_runtime_receipts"));
addCheck("reveal evidence table exists", existsRegclass("game_engine.provably_fair_seed_reveal_evidence"));
addCheck("verification results table exists", existsRegclass("game_engine.provably_fair_verification_results"));
addCheck("runtime receipt table has no plaintext seed columns",
  !columnExists("game_engine", "provably_fair_runtime_receipts", "server_seed") &&
  !columnExists("game_engine", "provably_fair_runtime_receipts", "raw_seed") &&
  !columnExists("game_engine", "provably_fair_runtime_receipts", "plaintext_seed"));

runSql(insertProviderSql({ runId, providerId }));
runSql(`
insert into game_engine.provably_fair_seed_commitments (
  seed_id, provider_id, provider_version, seed_generation_timestamp, commitment_hash,
  seed_lifecycle, rotation_policy, activation_timestamp, retirement_timestamp, content_hash
) values (
  '${seedId}', ${sqlString(providerId)}, '1.0.0', now(),
  ${sqlString(`sha256:qa-provably-fair-runtime-commitment:${runId}`)},
  'Active', ${sqlJson({ plaintextPersisted: false })}, now(), null,
  ${sqlString(`sha256:qa-provably-fair-runtime-seed:${runId}`)}
);`);

runSql(`
insert into game_engine.provably_fair_runtime_receipts (
  receipt_id, wager_reference, outcome_certificate_id, outcome_certificate_hash,
  provider_id, provider_version, server_commitment, client_seed, nonce,
  verification_algorithm, canonical_verification_payload, resulting_outcome_hash,
  verification_status, reveal_state, receipt_hash, issued_at
) values (
  '${receiptId}', ${sqlString(`wager:${runId}`)}, '${randomUUID()}',
  ${sqlString(`sha256:qa-provably-fair-runtime-outcome:${runId}`)},
  ${sqlString(providerId)}, '1.0.0',
  ${sqlString(`sha256:qa-provably-fair-runtime-commitment:${runId}`)},
  'client-seed', 1, 'HMAC_SHA_256',
  ${sqlJson({ commitment: `sha256:qa-provably-fair-runtime-commitment:${runId}`, nonce: 1 })},
  ${sqlString(`sha256:qa-provably-fair-runtime-result:${runId}`)},
  'PendingReveal', 'NotEligible',
  ${sqlString(`sha256:qa-provably-fair-runtime-receipt:${runId}`)}, now()
);`);

addCheck("runtime receipt persists without unrevealed seed", queryScalar(`
select count(*) = 1
from game_engine.provably_fair_runtime_receipts
where receipt_id = '${receiptId}'
  and canonical_verification_payload::text not ilike '%serverseed%';
`) === "t");

const productionAttempt = runSql(`
insert into game_engine.outcome_runtime_attempts (
  attempt_id, runtime_request_id, idempotency_key, draw_request_scope,
  provider_id, provider_version, provider_type, mode, status, failure_code,
  failure_reason, lock_scope, lock_acquired, canonical_attempt_hash, started_at, completed_at
) values (
  '${randomUUID()}', '${randomUUID()}', ${sqlString(`qa-pf-production:${runId}`)}, ${sqlString(`wager:${runId}`)},
  ${sqlString(providerId)}, '1.0.0', 'PROVABLY_FAIR', 'Production', 'Accepted', 'None',
  null, ${sqlString(`outcome-runtime:${providerId}:1.0.0:wager:${runId}`)}, true,
  ${sqlString(`sha256:qa-provably-fair-runtime-production-attempt:${runId}`)}, now(), now()
);`, { allowFailure: true });
addCheck("production mode rejected", productionAttempt.status !== 0, { stderr: productionAttempt.stderr.trim() });

const failed = checks.filter((check) => check.status !== "PASS");
printJson({
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
});

if (failed.length > 0) {
  process.exit(1);
}
