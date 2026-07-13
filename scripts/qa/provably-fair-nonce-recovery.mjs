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

function setupProvider(providerId, runId) {
  runSql(`
insert into game_engine.outcome_provider_definitions (
  id, provider_id, provider_version, provider_type, lifecycle_state, production_eligible,
  supported_outcome_primitive_types, evidence_requirements, health_readiness_capabilities,
  idempotency_model, custody_support, signing_requirements, replayability_support,
  failure_mode, capability_markers, content_hash, certification_binding, jurisdiction_profile_references
) values (
  '${randomUUID()}', ${sqlString(providerId)}, '1.0.0', 'PROVABLY_FAIR', 'Active', true,
  ${sqlJson(["UniqueNumberSet"])}, ${sqlJson({ commitRevealEvidence: true })}, ${sqlJson(["nonce-ready"])},
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
  ${sqlString(`sha256:qa-pf-nonce-outcome-provider:${runId}`)}, null, null
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
  ${sqlString(`sha256:qa-pf-nonce-provider:${runId}`)}, null, null
);`);
}

function insertNonce({ providerId, runId, scope, nonce }) {
  return runSql(`
insert into game_engine.provably_fair_nonce_sequences (
  id, provider_id, provider_version, provider_scope, scope_type, nonce,
  nonce_policy, monotonic_required, uniqueness_scope, content_hash
) values (
  '${randomUUID()}', ${sqlString(providerId)}, '1.0.0', ${sqlString(scope)}, 'Wager', ${nonce},
  ${sqlJson({ scopeType: "Wager", monotonicRequired: true, uniquenessScope: "provider-wager" })},
  true, 'provider-wager',
  ${sqlString(`sha256:qa-pf-nonce:${runId}:${scope}:${nonce}`)}
);`, { allowFailure: true });
}

const runId = randomUUID();
const providerId = `qa-pf-nonce:${runId}`;
const scope = `wager:${runId}`;
setupProvider(providerId, runId);

addCheck("first nonce persists", insertNonce({ providerId, runId, scope, nonce: 1 }).status === 0);
addCheck("second nonce persists", insertNonce({ providerId, runId, scope, nonce: 2 }).status === 0);

const duplicate = insertNonce({ providerId, runId, scope, nonce: 2 });
addCheck("duplicate nonce rejected", duplicate.status !== 0, { stderr: duplicate.stderr.trim() });

const decrement = insertNonce({ providerId, runId, scope, nonce: 1 });
addCheck("nonce decrement rejected", decrement.status !== 0, { stderr: decrement.stderr.trim() });

addCheck("nonce recovery would continue after max persisted nonce", queryScalar(`
select coalesce(max(nonce), 0) + 1 = 3
from game_engine.provably_fair_nonce_sequences
where provider_id = ${sqlString(providerId)}
  and provider_version = '1.0.0'
  and provider_scope = ${sqlString(scope)}
  and scope_type = 'Wager'
  and uniqueness_scope = 'provider-wager';
`) === "t");

addCheck("append-only nonce update blocked", runSql(`
update game_engine.provably_fair_nonce_sequences
set nonce = 99
where provider_id = ${sqlString(providerId)};
`, { allowFailure: true }).status !== 0);

const failed = checks.filter((check) => check.status !== "PASS");
printJson({
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
});

if (failed.length > 0) {
  process.exit(1);
}
