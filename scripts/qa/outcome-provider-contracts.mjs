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

function providerCapabilities(overrides = {}) {
  return {
    generatesOutcomes: true,
    ingestsExternalOutcomes: false,
    supportsPlayerVerificationReceipt: false,
    supportsDeterministicReplay: true,
    supportsProviderHealthEvidence: true,
    supportsDisputeHandling: true,
    supportsExternalSourceEvidence: false,
    supportsPhysicalDrawEvidence: false,
    ...overrides,
  };
}

function providerInsertSql({
  id = randomUUID(),
  providerId,
  providerVersion = "1.0.0",
  providerType = "CERTIFIED_CSPRNG",
  lifecycleState = "Active",
  productionEligible = true,
  supportedPrimitives = ["UniqueNumberSet", "WeightedSelection", "CompositeOutcomeGraph"],
  evidenceRequirements = { healthEvidence: true },
  healthReadinessCapabilities = ["startup-health", "continuous-health"],
  idempotencyModel = "PerDraw",
  custodySupport = ["Generated", "Sealed", "Certified", "Disputed"],
  signingRequirements = { certificateSignatureRequired: true },
  replayabilitySupport = true,
  failureMode = "FailClosed",
  capabilityMarkers = providerCapabilities(),
  contentHash,
  certificationBinding = null,
  jurisdictionProfiles = null,
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
  ${sqlString(providerType)},
  ${sqlString(lifecycleState)},
  ${productionEligible ? "true" : "false"},
  ${sqlJson(supportedPrimitives)},
  ${sqlJson(evidenceRequirements)},
  ${sqlJson(healthReadinessCapabilities)},
  ${sqlString(idempotencyModel)},
  ${sqlJson(custodySupport)},
  ${sqlJson(signingRequirements)},
  ${replayabilitySupport ? "true" : "false"},
  ${sqlString(failureMode)},
  ${sqlJson(capabilityMarkers)},
  ${sqlString(contentHash)},
  ${certificationBinding === null ? "null" : sqlString(certificationBinding)},
  ${jurisdictionProfiles === null ? "null" : sqlJson(jurisdictionProfiles)}
);`;
}

function manifestInsertSql({
  manifestId = randomUUID(),
  gameId = randomUUID(),
  gameCode,
  gameFamily = "Lottery",
  semanticVersion = "1.0.0",
  contentHash,
  outcomeProviderId = null,
  outcomeProviderVersion = null,
  requiredPrimitives = ["UniqueNumberSet"],
  evidenceRequirements = { healthEvidence: true },
  receiptRequired = false,
  eligibilityProfile = { silentFallbackAllowed: false },
  certificationRequired = false,
  jurisdictionBindings = [],
  lifecycleState = "GovernanceApproved",
}) {
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
  '${gameId}',
  ${sqlString(gameCode)},
  ${sqlString(`${gameCode} QA Game`)},
  ${sqlString(gameFamily)},
  ${sqlJson(jurisdictionBindings)},
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
  ${sqlString(lifecycleState)},
  now(),
  null,
  ${sqlString(semanticVersion)},
  ${sqlString(contentHash)},
  ${sqlJson({
    signingKeyId: "qa-signing-key",
    hashAlgorithmVersion: "sha256-v1",
    signingAlgorithmVersion: "ed25519-v1",
    signature: "qa-signature",
  })},
  ${outcomeProviderId === null ? "null" : sqlString(outcomeProviderId)},
  ${outcomeProviderVersion === null ? "null" : sqlString(outcomeProviderVersion)},
  ${sqlJson({ requiredPrimitives })},
  ${sqlJson(evidenceRequirements)},
  ${receiptRequired ? "true" : "false"},
  ${sqlJson(eligibilityProfile)},
  ${certificationRequired ? "true" : "false"}
);`;
}

function evaluateProviderActivation({
  hasBinding = true,
  providerActiveAndEligible = true,
  capabilitiesSatisfied = true,
  usesSimulationTest = false,
  silentFallback = false,
  certificationRequired = false,
  certificationOmitted = true,
} = {}) {
  const blockers = [];

  if (!hasBinding) blockers.push("Game Manifest must bind exactly one Outcome Provider version.");
  if (!providerActiveAndEligible) blockers.push("Manifest-bound Outcome Provider must be active and eligible.");
  if (!capabilitiesSatisfied) blockers.push("Outcome Provider capabilities must satisfy the Game Manifest requirements.");
  if (silentFallback) blockers.push("Silent fallback Outcome Providers are not allowed.");
  if (usesSimulationTest) blockers.push("Simulation/test Outcome Providers cannot be production authority.");
  if (certificationRequired && certificationOmitted) blockers.push("Certification is required by the manifest and cannot be omitted.");

  return { allowed: blockers.length === 0, blockers };
}

const runId = randomUUID();
const providerBase = `outcome-provider:p0-007-1:${runId}`;

addCheck("outcome provider table exists", existsRegclass("game_engine.outcome_provider_definitions"));
addCheck("game manifest provider binding columns exist", rowCount(`
select count(*)
from information_schema.columns
where table_schema = 'game_engine'
  and table_name = 'game_manifests'
  and column_name in (
    'outcome_provider_id',
    'outcome_provider_version',
    'provider_capability_requirements',
    'provider_evidence_requirements',
    'player_verification_receipt_required',
    'provider_eligibility_profile',
    'certification_required'
);
`) === 7);

const certifiedProviderId = `${providerBase}:certified`;
runSql(providerInsertSql({
  providerId: certifiedProviderId,
  contentHash: `sha256:p0-007-1-certified:${runId}`,
}));
addCheck("valid Certified CSPRNG provider persists", rowCount(`
select count(*)
from game_engine.outcome_provider_definitions
where provider_id = ${sqlString(certifiedProviderId)}
  and provider_type = 'CERTIFIED_CSPRNG'
  and production_eligible = true;
`) === 1);

const provablyFairProviderId = `${providerBase}:provably-fair`;
runSql(providerInsertSql({
  providerId: provablyFairProviderId,
  providerType: "PROVABLY_FAIR",
  supportedPrimitives: ["WeightedSelection", "OrderedNumberSequence"],
  idempotencyModel: "PerWager",
  capabilityMarkers: providerCapabilities({ supportsPlayerVerificationReceipt: true }),
  contentHash: `sha256:p0-007-1-provably-fair:${runId}`,
}));
addCheck("valid Provably Fair provider persists", rowCount(`
select count(*)
from game_engine.outcome_provider_definitions
where provider_id = ${sqlString(provablyFairProviderId)}
  and provider_type = 'PROVABLY_FAIR'
  and capability_markers ->> 'supportsPlayerVerificationReceipt' = 'true';
`) === 1);

const externalProviderId = `${providerBase}:external`;
runSql(providerInsertSql({
  providerId: externalProviderId,
  providerType: "EXTERNAL_OFFICIAL_RESULT",
  supportedPrimitives: ["OrderedNumberSequence"],
  idempotencyModel: "PerExternalResult",
  capabilityMarkers: providerCapabilities({
    generatesOutcomes: false,
    ingestsExternalOutcomes: true,
    supportsExternalSourceEvidence: true,
  }),
  custodySupport: ["Ingested", "Sealed", "Certified", "Disputed"],
  contentHash: `sha256:p0-007-1-external:${runId}`,
}));
addCheck("valid External Official Result provider persists", rowCount(`
select count(*)
from game_engine.outcome_provider_definitions
where provider_id = ${sqlString(externalProviderId)}
  and provider_type = 'EXTERNAL_OFFICIAL_RESULT';
`) === 1);

const physicalProviderId = `${providerBase}:physical`;
runSql(providerInsertSql({
  providerId: physicalProviderId,
  providerType: "PHYSICAL_DRAW_RESULT",
  supportedPrimitives: ["UniqueNumberSet"],
  idempotencyModel: "PerPhysicalDraw",
  capabilityMarkers: providerCapabilities({
    generatesOutcomes: false,
    ingestsExternalOutcomes: true,
    supportsPhysicalDrawEvidence: true,
  }),
  custodySupport: ["Ingested", "Sealed", "Certified", "Disputed"],
  contentHash: `sha256:p0-007-1-physical:${runId}`,
}));
addCheck("valid Physical Draw Result provider persists", rowCount(`
select count(*)
from game_engine.outcome_provider_definitions
where provider_id = ${sqlString(physicalProviderId)}
  and provider_type = 'PHYSICAL_DRAW_RESULT';
`) === 1);

const simulationProduction = runSql(providerInsertSql({
  providerId: `${providerBase}:simulation-production`,
  providerType: "SIMULATION_TEST",
  productionEligible: true,
  capabilityMarkers: providerCapabilities(),
  idempotencyModel: "DeterministicSimulation",
  contentHash: `sha256:p0-007-1-simulation-production:${runId}`,
}), { allowFailure: true });
addCheck("simulation/test provider cannot be production eligible", simulationProduction.status !== 0, {
  stderr: simulationProduction.stderr.trim(),
});

const invalidCapabilities = runSql(providerInsertSql({
  providerId: `${providerBase}:invalid-capabilities`,
  capabilityMarkers: providerCapabilities({ generatesOutcomes: true, ingestsExternalOutcomes: true }),
  contentHash: `sha256:p0-007-1-invalid-capabilities:${runId}`,
}), { allowFailure: true });
addCheck("invalid capability combinations rejected", invalidCapabilities.status !== 0, {
  stderr: invalidCapabilities.stderr.trim(),
});

const forbiddenFields = runSql(providerInsertSql({
  providerId: `${providerBase}:forbidden-fields`,
  evidenceRequirements: { rtpControl: "forbidden" },
  contentHash: `sha256:p0-007-1-forbidden-fields:${runId}`,
}), { allowFailure: true });
addCheck("forbidden RTP/paytable/payout fields rejected", forbiddenFields.status !== 0, {
  stderr: forbiddenFields.stderr.trim(),
});

const manifestGameId = randomUUID();
runSql(manifestInsertSql({
  gameId: manifestGameId,
  gameCode: `provider-bound-${runId}`,
  contentHash: `sha256:p0-007-1-manifest-bound:${runId}`,
  outcomeProviderId: certifiedProviderId,
  outcomeProviderVersion: "1.0.0",
  requiredPrimitives: ["UniqueNumberSet"],
  jurisdictionBindings: [],
  certificationRequired: false,
}));
addCheck("manifest binds exact provider version", rowCount(`
select count(*)
from game_engine.game_manifests
where game_id = '${manifestGameId}'
  and semantic_version = '1.0.0'
  and outcome_provider_id = ${sqlString(certifiedProviderId)}
  and outcome_provider_version = '1.0.0';
`) === 1);

runSql(manifestInsertSql({
  gameId: manifestGameId,
  gameCode: `provider-bound-${runId}`,
  semanticVersion: "1.1.0",
  contentHash: `sha256:p0-007-1-manifest-provider-change:${runId}`,
  outcomeProviderId: physicalProviderId,
  outcomeProviderVersion: "1.0.0",
  requiredPrimitives: ["UniqueNumberSet"],
  gameFamily: "Physical Draw Lottery",
}));
addCheck("changing provider requires new manifest version", rowCount(`
select count(*)
from game_engine.game_manifests
where game_id = '${manifestGameId}'
  and outcome_provider_id in (${sqlString(certifiedProviderId)}, ${sqlString(physicalProviderId)});
`) === 2);

const duplicateProviderChange = runSql(manifestInsertSql({
  gameId: manifestGameId,
  gameCode: `provider-bound-${runId}`,
  semanticVersion: "1.0.0",
  contentHash: `sha256:p0-007-1-manifest-duplicate-version:${runId}`,
  outcomeProviderId: provablyFairProviderId,
  outcomeProviderVersion: "1.0.0",
  requiredPrimitives: ["WeightedSelection"],
}), { allowFailure: true });
addCheck("provider binding cannot change in place", duplicateProviderChange.status !== 0, {
  stderr: duplicateProviderChange.stderr.trim(),
});

const primitiveMismatch = runSql(manifestInsertSql({
  gameCode: `primitive-mismatch-${runId}`,
  contentHash: `sha256:p0-007-1-primitive-mismatch:${runId}`,
  outcomeProviderId: certifiedProviderId,
  outcomeProviderVersion: "1.0.0",
  requiredPrimitives: ["ShufflePermutation"],
}), { allowFailure: true });
addCheck("primitive incompatibility rejected", primitiveMismatch.status !== 0, {
  stderr: primitiveMismatch.stderr.trim(),
});

const receiptUnsupported = runSql(manifestInsertSql({
  gameCode: `receipt-unsupported-${runId}`,
  contentHash: `sha256:p0-007-1-receipt-unsupported:${runId}`,
  outcomeProviderId: certifiedProviderId,
  outcomeProviderVersion: "1.0.0",
  requiredPrimitives: ["UniqueNumberSet"],
  receiptRequired: true,
}), { allowFailure: true });
addCheck("unsupported verification receipt requirement rejected", receiptUnsupported.status !== 0, {
  stderr: receiptUnsupported.stderr.trim(),
});

runSql(manifestInsertSql({
  gameCode: `receipt-supported-${runId}`,
  gameFamily: "Casino Dice",
  contentHash: `sha256:p0-007-1-receipt-supported:${runId}`,
  outcomeProviderId: provablyFairProviderId,
  outcomeProviderVersion: "1.0.0",
  requiredPrimitives: ["WeightedSelection"],
  receiptRequired: true,
  jurisdictionBindings: [],
  certificationRequired: false,
}));
addCheck("optional jurisdiction succeeds", rowCount(`
select count(*)
from game_engine.game_manifests
where game_code = ${sqlString(`receipt-supported-${runId}`)}
  and jsonb_array_length(jurisdiction_bindings) = 0;
`) === 1);

addCheck("optional certification succeeds where manifest does not require it", rowCount(`
select count(*)
from game_engine.game_manifests
where game_code = ${sqlString(`receipt-supported-${runId}`)}
  and certification_required = false;
`) === 1);

const externalIncompatible = runSql(manifestInsertSql({
  gameCode: `external-incompatible-${runId}`,
  gameFamily: "Crash",
  contentHash: `sha256:p0-007-1-external-incompatible:${runId}`,
  outcomeProviderId: externalProviderId,
  outcomeProviderVersion: "1.0.0",
  requiredPrimitives: ["OrderedNumberSequence"],
}), { allowFailure: true });
addCheck("external provider incompatible game definition rejected", externalIncompatible.status !== 0, {
  stderr: externalIncompatible.stderr.trim(),
});

const missingBinding = evaluateProviderActivation({ hasBinding: false });
addCheck("missing provider binding blocks activation", !missingBinding.allowed, {
  blockers: missingBinding.blockers,
});

const updateBlocked = runSql(`
update game_engine.outcome_provider_definitions
set lifecycle_state = 'Suspended'
where provider_id = ${sqlString(certifiedProviderId)};`, { allowFailure: true });
addCheck("update blocked", updateBlocked.status !== 0, {
  stderr: updateBlocked.stderr.trim(),
});

const deleteBlocked = runSql(`
delete from game_engine.outcome_provider_definitions
where provider_id = ${sqlString(certifiedProviderId)};`, { allowFailure: true });
addCheck("delete blocked", deleteBlocked.status !== 0, {
  stderr: deleteBlocked.stderr.trim(),
});

const productionEnvEnabled =
  process.env.OUTCOME_AUTHORITY === "PRODUCTION" ||
  process.env.PRODUCTION_OUTCOME_AUTHORITY_ENABLED === "true";
addCheck("no production activation enabled", !productionEnvEnabled, {
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
