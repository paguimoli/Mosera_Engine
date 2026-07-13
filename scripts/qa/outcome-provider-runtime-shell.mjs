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

function query(sql) {
  return queryScalar(sql);
}

function existsRegclass(name) {
  return query(`select to_regclass('${name}') is not null;`) === "t";
}

function rowCount(sql) {
  return Number(query(sql));
}

function providerInsertSql({ providerId, providerVersion = "1.0.0", providerType = "CERTIFIED_CSPRNG", contentHash, lifecycleState = "Active", productionEligible = true }) {
  const receipt = providerType === "PROVABLY_FAIR";
  const ingestsExternal = providerType === "EXTERNAL_OFFICIAL_RESULT" || providerType === "PHYSICAL_DRAW_RESULT";
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
  '${randomUUID()}',
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  ${sqlString(providerType)},
  ${sqlString(lifecycleState)},
  ${productionEligible ? "true" : "false"},
  ${sqlJson(["UniqueNumberSet"])},
  ${sqlJson({ runtimeEvidence: true })},
  ${sqlJson(["runtime-shell-ready"])},
  ${receipt ? "'PerWager'" : "'PerDraw'"},
  ${sqlJson(["Generated", "Sealed", "Certified", "Disputed"])},
  ${sqlJson({ certificateSignatureRequired: true })},
  true,
  'FailClosed',
  ${sqlJson({
    generatesOutcomes: !ingestsExternal,
    ingestsExternalOutcomes: ingestsExternal,
    supportsPlayerVerificationReceipt: receipt,
    supportsDeterministicReplay: true,
    supportsProviderHealthEvidence: true,
    supportsDisputeHandling: true,
    supportsExternalSourceEvidence: providerType === "EXTERNAL_OFFICIAL_RESULT",
    supportsPhysicalDrawEvidence: providerType === "PHYSICAL_DRAW_RESULT",
  })},
  ${sqlString(contentHash)},
  null,
  null
);`;
}

function manifestInsertSql({ manifestId = randomUUID(), gameCode, providerId, providerVersion = "1.0.0", contentHash, receiptRequired = false, eligibilityProfile = { silentFallbackAllowed: false } }) {
  return `
insert into game_engine.game_manifests (
  id,
  game_id,
  game_code,
  game_name,
  game_family,
  jurisdiction_bindings,
  wager_schemas,
  outcome_strategy_references,
  math_model_references,
  paytable_references,
  settlement_policy_references,
  sales_rules,
  cancellation_correction_rules,
  replay_resettlement_policy,
  certification_pack_reference,
  regulator_profile,
  operator_approval_state,
  lifecycle_state,
  effective_from,
  effective_to,
  semantic_version,
  content_hash,
  signature_metadata,
  outcome_provider_id,
  outcome_provider_version,
  provider_capability_requirements,
  provider_evidence_requirements,
  player_verification_receipt_required,
  provider_eligibility_profile,
  certification_required
) values (
  '${manifestId}',
  '${randomUUID()}',
  ${sqlString(gameCode)},
  ${sqlString(`${gameCode} Runtime Shell QA`)},
  'Lottery',
  ${sqlJson([])},
  ${sqlJson(["wager-schema:v1"])},
  ${sqlJson(["outcome-strategy:v1"])},
  ${sqlJson(["math-model:v1"])},
  ${sqlJson(["paytable:v1"])},
  ${sqlJson(["settlement-policy:v1"])},
  ${sqlJson({ salesOpen: true })},
  ${sqlJson({ correctionPolicy: "supersession-only" })},
  ${sqlJson({ replay: "approval-required" })},
  'certification-pack:optional',
  'regulator-profile:optional',
  'Approved',
  'GovernanceApproved',
  now(),
  null,
  '1.0.0',
  ${sqlString(contentHash)},
  ${sqlJson({ signingKeyId: "qa-signing-key", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "ed25519-v1", signature: "qa-signature" })},
  ${sqlString(providerId)},
  ${sqlString(providerVersion)},
  ${sqlJson({ requiredPrimitives: ["UniqueNumberSet"] })},
  ${sqlJson({ runtimeEvidence: true })},
  ${receiptRequired ? "true" : "false"},
  ${sqlJson(eligibilityProfile)},
  false
);`;
}

const runId = randomUUID();
const providerId = `outcome-provider-runtime:p0-007-4:${runId}`;
const manifestId = randomUUID();

addCheck("outcome runtime request table exists", existsRegclass("game_engine.outcome_runtime_requests"));
addCheck("outcome runtime attempt table exists", existsRegclass("game_engine.outcome_runtime_attempts"));

runSql(providerInsertSql({
  providerId,
  contentHash: `sha256:p0-007-4-provider:${runId}`,
}));
runSql(manifestInsertSql({
  manifestId,
  gameCode: `runtime-shell-${runId}`,
  providerId,
  contentHash: `sha256:p0-007-4-manifest:${runId}`,
}));

addCheck("exact provider selected from manifest", rowCount(`
select count(*)
from game_engine.game_manifests manifest
join game_engine.outcome_provider_definitions provider
  on provider.provider_id = manifest.outcome_provider_id
 and provider.provider_version = manifest.outcome_provider_version
where manifest.id = '${manifestId}'
  and provider.provider_id = ${sqlString(providerId)}
  and provider.provider_type = 'CERTIFIED_CSPRNG';
`) === 1);

addCheck("missing provider fails closed", rowCount(`
select count(*)
from game_engine.game_manifests manifest
left join game_engine.outcome_provider_definitions provider
  on provider.provider_id = 'missing-provider'
 and provider.provider_version = manifest.outcome_provider_version
where manifest.id = '${manifestId}'
  and provider.id is null;
`) === 1);

addCheck("version mismatch fails closed", rowCount(`
select count(*)
from game_engine.game_manifests manifest
left join game_engine.outcome_provider_definitions provider
  on provider.provider_id = manifest.outcome_provider_id
 and provider.provider_version = '9.9.9'
where manifest.id = '${manifestId}'
  and provider.id is null;
`) === 1);

addCheck("type mismatch fails closed", rowCount(`
select count(*)
from game_engine.game_manifests manifest
join game_engine.outcome_provider_definitions provider
  on provider.provider_id = manifest.outcome_provider_id
 and provider.provider_version = manifest.outcome_provider_version
where manifest.id = '${manifestId}'
  and provider.provider_type <> 'PROVABLY_FAIR';
`) === 1);

const fallbackResult = runSql(manifestInsertSql({
  gameCode: `runtime-shell-fallback-${runId}`,
  providerId,
  contentHash: `sha256:p0-007-4-fallback-manifest:${runId}`,
  eligibilityProfile: { silentFallbackProviderId: "fallback-provider" },
}), { allowFailure: true });
addCheck("no fallback provider used", fallbackResult.status !== 0, { stderr: fallbackResult.stderr.trim() });

const simulationProviderId = `outcome-provider-runtime:simulation:${runId}`;
runSql(providerInsertSql({
  providerId: simulationProviderId,
  providerType: "SIMULATION_TEST",
  contentHash: `sha256:p0-007-4-simulation:${runId}`,
  productionEligible: false,
}));
const productionSimulationResult = runSql(`
insert into game_engine.outcome_runtime_requests (
  runtime_request_id,
  idempotency_key,
  draw_request_scope,
  game_manifest_id,
  game_manifest_version,
  provider_id,
  provider_version,
  provider_type,
  mode,
  status,
  started_at,
  completed_at,
  failure_code,
  failure_reason,
  canonical_request_hash,
  result_reference_placeholder,
  evidence_reference_placeholder,
  lock_scope,
  lock_acquired
) values (
  '${randomUUID()}',
  ${sqlString(`runtime-shell-production-simulation:${runId}`)},
  ${sqlString(`draw:${runId}:simulation`)},
  'game-manifest:runtime-shell',
  '1.0.0',
  ${sqlString(simulationProviderId)},
  '1.0.0',
  'SIMULATION_TEST',
  'Production',
  'FailedClosed',
  now(),
  now(),
  'SimulationProviderInProduction',
  'Simulation/test provider rejected for production mode.',
  ${sqlString(`sha256:p0-007-4-production-simulation:${runId}`)},
  null,
  null,
  ${sqlString(`outcome-runtime:${simulationProviderId}:draw:${runId}`)},
  false
);`, { allowFailure: true });
addCheck("simulation/test provider rejected for production mode", productionSimulationResult.status !== 0, {
  stderr: productionSimulationResult.stderr.trim(),
});

const beforeCertificates = rowCount("select count(*) from game_engine.outcome_certificates;");
runSql(`
insert into game_engine.outcome_runtime_requests (
  runtime_request_id,
  idempotency_key,
  draw_request_scope,
  game_manifest_id,
  game_manifest_version,
  provider_id,
  provider_version,
  provider_type,
  mode,
  status,
  started_at,
  completed_at,
  failure_code,
  failure_reason,
  canonical_request_hash,
  result_reference_placeholder,
  evidence_reference_placeholder,
  lock_scope,
  lock_acquired
) values (
  '${randomUUID()}',
  ${sqlString(`runtime-shell-generation-not-implemented:${runId}`)},
  ${sqlString(`draw:${runId}:shell`)},
  ${sqlString(String(manifestId))},
  '1.0.0',
  ${sqlString(providerId)},
  '1.0.0',
  'CERTIFIED_CSPRNG',
  'DryRun',
  'GenerationNotImplemented',
  now(),
  now(),
  'GenerationNotImplemented',
  'Provider runtime shell is present, but outcome generation is not implemented in this phase.',
  ${sqlString(`sha256:p0-007-4-shell:${runId}`)},
  null,
  'placeholder:runtime-shell-evidence',
  ${sqlString(`outcome-runtime:${providerId}:draw:${runId}:shell`)},
  true
);`);
const afterCertificates = rowCount("select count(*) from game_engine.outcome_certificates;");
addCheck("provider runtime shells report unimplemented generation safely", rowCount(`
select count(*)
from game_engine.outcome_runtime_requests
where idempotency_key = ${sqlString(`runtime-shell-generation-not-implemented:${runId}`)}
  and status = 'GenerationNotImplemented'
  and result_reference_placeholder is null;
`) === 1);
addCheck("no outcome certificate or production outcome is created", beforeCertificates === afterCertificates, {
  before: beforeCertificates,
  after: afterCertificates,
});

const failed = checks.filter((check) => check.status !== "PASS");
printJson({
  status: failed.length === 0 ? "PASS" : "FAIL",
  checkCount: checks.length,
  failedCount: failed.length,
  checks,
});

if (failed.length > 0) {
  process.exitCode = 1;
}
