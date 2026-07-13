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

function allMarkers(overrides = {}) {
  return {
    gameManifestSchemaReady: existsRegclass("game_engine.game_manifests"),
    authorityCertificateChainReady: existsRegclass("game_engine.authority_certificates"),
    outcomeDslReady: existsRegclass("game_engine.outcome_strategy_definitions"),
    mathRtpGovernanceReady: existsRegclass("game_engine.math_model_definitions") && existsRegclass("game_engine.paytable_definitions"),
    rngProviderGovernanceReady: existsRegclass("game_engine.rng_provider_definitions") && existsRegclass("game_engine.rng_provider_evidence"),
    outcomeDryRunPipelineReady: existsRegclass("game_engine.outcome_events") && existsRegclass("game_engine.outcome_certificates"),
    mathEvaluationDryRunReady: existsRegclass("game_engine.math_evaluation_events") && existsRegclass("game_engine.math_evaluation_certificates"),
    certificationPackReady: existsRegclass("game_engine.certification_packs"),
    certificateSigningFrameworkReady: existsRegclass("game_engine.signing_providers") && existsRegclass("game_engine.certificate_signatures"),
    statisticalValidationReady: existsRegclass("game_engine.statistical_validation_results") && existsRegclass("game_engine.simulation_evidence"),
    operationalControlsReady: existsRegclass("game_engine.outcome_operational_controls") && existsRegclass("game_engine.outcome_custody_events"),
    outcomeProviderRuntimeReady: existsRegclass("game_engine.outcome_runtime_requests") && existsRegclass("game_engine.outcome_runtime_attempts"),
    outcomeRuntimeIdempotencyReady: existsRegclass("game_engine.outcome_runtime_requests"),
    outcomeRuntimeAdvisoryLockingReady: queryScalar(`
select exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'game_engine'
    and p.proname = 'try_outcome_runtime_advisory_lock'
);
`) === "t",
    ...overrides,
  };
}

function evaluateActivation(request) {
  const blockers = [];
  const warnings = [];
  const markerLabels = {
    gameManifestSchemaReady: "Game manifest schema marker is missing.",
    authorityCertificateChainReady: "Authority certificate chain marker is missing.",
    outcomeDslReady: "Outcome DSL marker is missing.",
    mathRtpGovernanceReady: "Math/RTP governance marker is missing.",
    rngProviderGovernanceReady: "RNG provider governance marker is missing.",
    outcomeDryRunPipelineReady: "Outcome dry-run pipeline marker is missing.",
    mathEvaluationDryRunReady: "Math evaluation dry-run marker is missing.",
    certificationPackReady: "Certification pack marker is missing.",
    certificateSigningFrameworkReady: "Certificate signing framework marker is missing.",
    statisticalValidationReady: "Statistical validation marker is missing.",
    operationalControlsReady: "Operational controls marker is missing.",
    outcomeProviderRuntimeReady: "Outcome Provider runtime marker is missing.",
    outcomeRuntimeIdempotencyReady: "Outcome runtime idempotency marker is missing.",
    outcomeRuntimeAdvisoryLockingReady: "Outcome runtime advisory locking marker is missing.",
  };

  for (const [marker, message] of Object.entries(markerLabels)) {
    if (!request.markers[marker]) {
      blockers.push(message);
    }
  }

  if (!request.productionOutcomeAuthorityEnabled) {
    blockers.push("Production Outcome Authority is disabled by configuration.");
  }

  if (!request.productionRngProviderEligible) {
    blockers.push("Production RNG provider must be production eligible.");
  }

  if (!request.signingProviderProductionEligible) {
    blockers.push("Signing provider must be production eligible.");
  }

  if (!request.certificationPackReady) {
    blockers.push("Certification pack must be certification-ready.");
  }

  if (!request.hasExactOutcomeProviderBinding) {
    blockers.push("Game Manifest must bind exactly one Outcome Provider version.");
  }

  if (!request.outcomeProviderActiveAndEligible) {
    blockers.push("Manifest-bound Outcome Provider must be active and eligible.");
  }

  if (!request.outcomeProviderCapabilitiesSatisfied) {
    blockers.push("Outcome Provider capabilities must satisfy the Game Manifest requirements.");
  }

  if (request.silentFallbackConfigured) {
    blockers.push("Silent fallback Outcome Providers are not allowed.");
  }

  if (request.usesSimulationOrTestOutcomeProvider) {
    blockers.push("Simulation/test Outcome Providers cannot be production authority.");
  }

  if (!request.certifiedCsprngProviderRequirementsSatisfied) {
    blockers.push("Certified CSPRNG provider requirements must be satisfied.");
  }

  if (!request.entropyProviderProductionEligible) {
    blockers.push("Entropy provider must be production eligible.");
  }

  if (!request.drbgHealthEvidenceSatisfied) {
    blockers.push("Certified CSPRNG startup, KAT, and continuous health evidence must be present.");
  }

  if (!request.unbiasedSamplingCapabilitiesSatisfied) {
    blockers.push("Certified CSPRNG provider requires unbiased sampling capabilities.");
  }

  if (!request.noRawSecretMaterialPersisted) {
    blockers.push("Raw entropy, seed material, and DRBG state must never be persisted.");
  }

  if (!request.provablyFairProviderRequirementsSatisfied) {
    blockers.push("Provably Fair provider requirements must be satisfied.");
  }

  if (!request.provablyFairCommitAlgorithmDefined) {
    blockers.push("Provably Fair commit algorithm must be defined.");
  }

  if (!request.provablyFairVerificationAlgorithmDefined) {
    blockers.push("Provably Fair verification algorithm must be defined.");
  }

  if (!request.provablyFairReceiptSupportAvailable) {
    blockers.push("Provably Fair receipt support must be available.");
  }

  if (!request.provablyFairNoncePolicyValid) {
    blockers.push("Provably Fair nonce policy must be valid.");
  }

  if (!request.provablyFairCommitmentPolicyValid) {
    blockers.push("Provably Fair commitment policy must be valid.");
  }

  if (!request.provablyFairNoSeedLeakage) {
    blockers.push("Provably Fair governance must not leak server seed material.");
  }

  if (!request.outcomeProviderRuntimeReady) {
    blockers.push("Outcome Provider runtime must be ready.");
  }

  if (!request.outcomeRuntimeIdempotencyConfigured) {
    blockers.push("Outcome runtime durable idempotency must be configured.");
  }

  if (!request.outcomeRuntimeAdvisoryLockingConfigured) {
    blockers.push("Outcome runtime advisory locking must be configured.");
  }

  if (!request.productionOutcomeGenerationDisabled) {
    blockers.push("Production outcome generation must remain disabled until activation is explicitly approved.");
  }

  if (request.usesSimulationOrTestProvider) {
    blockers.push("Simulation and test providers cannot be production authority.");
  }

  if (request.manifestRequiresCertification && request.certificationOmitted) {
    blockers.push("Certification is required by the manifest and cannot be omitted.");
  }

  if (request.hasFailedOrInconclusiveStatisticalValidation) {
    blockers.push("Failed or inconclusive statistical validation blocks activation.");
  }

  if (request.hasActiveEmergencyDisable) {
    blockers.push("Active emergency disable control blocks activation.");
  }

  if (request.jurisdictionOmitted) {
    warnings.push("Jurisdiction is omitted and treated as an optional policy overlay.");
  }

  if (!request.manifestRequiresCertification && request.certificationOmitted) {
    warnings.push("Certification is omitted because the manifest does not require it.");
  }

  return { allowed: blockers.length === 0, blockers, warnings };
}

function baseRequest(overrides = {}) {
  return {
    markers: allMarkers(),
    productionOutcomeAuthorityEnabled: true,
    productionRngProviderEligible: true,
    signingProviderProductionEligible: true,
    certificationPackReady: true,
    usesSimulationOrTestProvider: false,
    jurisdictionOmitted: true,
    manifestRequiresCertification: false,
    certificationOmitted: true,
    hasFailedOrInconclusiveStatisticalValidation: false,
    hasActiveEmergencyDisable: false,
    hasExactOutcomeProviderBinding: true,
    outcomeProviderActiveAndEligible: true,
    outcomeProviderCapabilitiesSatisfied: true,
    silentFallbackConfigured: false,
    usesSimulationOrTestOutcomeProvider: false,
    certifiedCsprngProviderRequirementsSatisfied: true,
    entropyProviderProductionEligible: true,
    drbgHealthEvidenceSatisfied: true,
    unbiasedSamplingCapabilitiesSatisfied: true,
    noRawSecretMaterialPersisted: true,
    provablyFairProviderRequirementsSatisfied: true,
    provablyFairCommitAlgorithmDefined: true,
    provablyFairVerificationAlgorithmDefined: true,
    provablyFairReceiptSupportAvailable: true,
    provablyFairNoncePolicyValid: true,
    provablyFairCommitmentPolicyValid: true,
    provablyFairNoSeedLeakage: true,
    outcomeProviderRuntimeReady: true,
    outcomeRuntimeIdempotencyConfigured: true,
    outcomeRuntimeAdvisoryLockingConfigured: true,
    productionOutcomeGenerationDisabled: true,
    ...overrides,
  };
}

function insertEmergencyDisableSql({ controlId, targetArtifactId, evidenceHash }) {
  return `
insert into game_engine.outcome_operational_controls (
  control_id, control_type, target_artifact_type, target_artifact_id,
  reason_code, requested_by, approved_by, dual_approval_status,
  production_affecting, effective_at, expires_at, evidence_hash,
  audit_evidence, signing_metadata
) values (
  '${controlId}',
  'EMERGENCY_DISABLE',
  'Draw',
  ${sqlString(targetArtifactId)},
  'QA_ACTIVATION_EMERGENCY_DISABLE',
  'qa-requester',
  'qa-approver',
  'Approved',
  true,
  now(),
  '2099-01-01T00:00:00Z',
  ${sqlString(evidenceHash)},
  ${sqlJson({ reason: "activation guardrail qa", expiresAt: "2099-01-01T00:00:00Z" })},
  ${sqlJson({ signingKeyId: "placeholder", hashAlgorithmVersion: "sha256-v1", signingAlgorithmVersion: "placeholder-v1", signature: "placeholder" })}
);`;
}

const productionEnvEnabled =
  process.env.OUTCOME_AUTHORITY === "PRODUCTION" ||
  process.env.PRODUCTION_OUTCOME_AUTHORITY_ENABLED === "true";
const allReadyMarkers = allMarkers();
const markerValues = Object.values(allReadyMarkers);
const ledgerBefore = rowCount("select count(*) from public.financial_ledger_entries;");

addCheck("readiness markers are present", markerValues.every(Boolean), allReadyMarkers);

const defaultDisabled = evaluateActivation(baseRequest({ productionOutcomeAuthorityEnabled: false }));
addCheck("default production activation disabled", !defaultDisabled.allowed, { blockers: defaultDisabled.blockers });

const missingMarker = evaluateActivation(baseRequest({
  markers: allMarkers({ outcomeDslReady: false }),
}));
addCheck("missing marker fails closed", !missingMarker.allowed, { blockers: missingMarker.blockers });

const testProvider = evaluateActivation(baseRequest({
  productionRngProviderEligible: false,
  usesSimulationOrTestProvider: true,
}));
addCheck("test/simulation provider fails closed", !testProvider.allowed, { blockers: testProvider.blockers });

const failedStatistics = evaluateActivation(baseRequest({
  hasFailedOrInconclusiveStatisticalValidation: true,
}));
addCheck("failed statistical validation fails closed", !failedStatistics.allowed, { blockers: failedStatistics.blockers });

const missingProviderBinding = evaluateActivation(baseRequest({
  hasExactOutcomeProviderBinding: false,
}));
addCheck("missing provider binding fails closed", !missingProviderBinding.allowed, { blockers: missingProviderBinding.blockers });

const inactiveProvider = evaluateActivation(baseRequest({
  outcomeProviderActiveAndEligible: false,
}));
addCheck("inactive or ineligible provider fails closed", !inactiveProvider.allowed, { blockers: inactiveProvider.blockers });

const unsatisfiedProviderCapabilities = evaluateActivation(baseRequest({
  outcomeProviderCapabilitiesSatisfied: false,
}));
addCheck("provider capability mismatch fails closed", !unsatisfiedProviderCapabilities.allowed, { blockers: unsatisfiedProviderCapabilities.blockers });

const silentFallback = evaluateActivation(baseRequest({
  silentFallbackConfigured: true,
}));
addCheck("silent fallback provider fails closed", !silentFallback.allowed, { blockers: silentFallback.blockers });

const simulationOutcomeProvider = evaluateActivation(baseRequest({
  usesSimulationOrTestOutcomeProvider: true,
}));
addCheck("simulation/test outcome provider fails closed", !simulationOutcomeProvider.allowed, { blockers: simulationOutcomeProvider.blockers });

const missingCertifiedCsprngRequirements = evaluateActivation(baseRequest({
  certifiedCsprngProviderRequirementsSatisfied: false,
}));
addCheck("missing Certified CSPRNG requirements fail closed", !missingCertifiedCsprngRequirements.allowed, {
  blockers: missingCertifiedCsprngRequirements.blockers,
});

const missingEntropyEligibility = evaluateActivation(baseRequest({
  entropyProviderProductionEligible: false,
}));
addCheck("missing entropy provider eligibility fails closed", !missingEntropyEligibility.allowed, {
  blockers: missingEntropyEligibility.blockers,
});

const missingDrbgHealthEvidence = evaluateActivation(baseRequest({
  drbgHealthEvidenceSatisfied: false,
}));
addCheck("missing DRBG health evidence fails closed", !missingDrbgHealthEvidence.allowed, {
  blockers: missingDrbgHealthEvidence.blockers,
});

const missingSamplingCapabilities = evaluateActivation(baseRequest({
  unbiasedSamplingCapabilitiesSatisfied: false,
}));
addCheck("missing unbiased sampling capabilities fail closed", !missingSamplingCapabilities.allowed, {
  blockers: missingSamplingCapabilities.blockers,
});

const rawSecretPersisted = evaluateActivation(baseRequest({
  noRawSecretMaterialPersisted: false,
}));
addCheck("raw secret material persistence fails closed", !rawSecretPersisted.allowed, {
  blockers: rawSecretPersisted.blockers,
});

const missingProvablyFairRequirements = evaluateActivation(baseRequest({
  provablyFairProviderRequirementsSatisfied: false,
}));
addCheck("missing Provably Fair requirements fail closed", !missingProvablyFairRequirements.allowed, {
  blockers: missingProvablyFairRequirements.blockers,
});

const missingCommitAlgorithm = evaluateActivation(baseRequest({
  provablyFairCommitAlgorithmDefined: false,
}));
addCheck("missing Provably Fair commit algorithm fails closed", !missingCommitAlgorithm.allowed, {
  blockers: missingCommitAlgorithm.blockers,
});

const missingVerificationAlgorithm = evaluateActivation(baseRequest({
  provablyFairVerificationAlgorithmDefined: false,
}));
addCheck("missing Provably Fair verification algorithm fails closed", !missingVerificationAlgorithm.allowed, {
  blockers: missingVerificationAlgorithm.blockers,
});

const missingReceiptSupport = evaluateActivation(baseRequest({
  provablyFairReceiptSupportAvailable: false,
}));
addCheck("missing Provably Fair receipt support fails closed", !missingReceiptSupport.allowed, {
  blockers: missingReceiptSupport.blockers,
});

const invalidNoncePolicy = evaluateActivation(baseRequest({
  provablyFairNoncePolicyValid: false,
}));
addCheck("invalid Provably Fair nonce policy fails closed", !invalidNoncePolicy.allowed, {
  blockers: invalidNoncePolicy.blockers,
});

const invalidCommitmentPolicy = evaluateActivation(baseRequest({
  provablyFairCommitmentPolicyValid: false,
}));
addCheck("invalid Provably Fair commitment policy fails closed", !invalidCommitmentPolicy.allowed, {
  blockers: invalidCommitmentPolicy.blockers,
});

const provablyFairSeedLeakage = evaluateActivation(baseRequest({
  provablyFairNoSeedLeakage: false,
}));
addCheck("Provably Fair seed leakage fails closed", !provablyFairSeedLeakage.allowed, {
  blockers: provablyFairSeedLeakage.blockers,
});

const missingRuntimeMarker = evaluateActivation(baseRequest({
  markers: allMarkers({ outcomeProviderRuntimeReady: false }),
}));
addCheck("missing Outcome Provider runtime marker fails closed", !missingRuntimeMarker.allowed, {
  blockers: missingRuntimeMarker.blockers,
});

const missingRuntimeReady = evaluateActivation(baseRequest({
  outcomeProviderRuntimeReady: false,
}));
addCheck("missing Outcome Provider runtime readiness fails closed", !missingRuntimeReady.allowed, {
  blockers: missingRuntimeReady.blockers,
});

const missingRuntimeIdempotency = evaluateActivation(baseRequest({
  outcomeRuntimeIdempotencyConfigured: false,
}));
addCheck("missing outcome runtime idempotency fails closed", !missingRuntimeIdempotency.allowed, {
  blockers: missingRuntimeIdempotency.blockers,
});

const missingRuntimeLocking = evaluateActivation(baseRequest({
  outcomeRuntimeAdvisoryLockingConfigured: false,
}));
addCheck("missing outcome runtime advisory locking fails closed", !missingRuntimeLocking.allowed, {
  blockers: missingRuntimeLocking.blockers,
});

const productionGenerationEnabled = evaluateActivation(baseRequest({
  productionOutcomeGenerationDisabled: false,
}));
addCheck("production outcome generation enabled fails closed", !productionGenerationEnabled.allowed, {
  blockers: productionGenerationEnabled.blockers,
});

const emergencyControlId = randomUUID();
const emergencyTarget = randomUUID();
runSql(insertEmergencyDisableSql({
  controlId: emergencyControlId,
  targetArtifactId: String(emergencyTarget),
  evidenceHash: `sha256:p0-005-12-emergency-disable:${emergencyControlId}`,
}));
const activeEmergencyDisable = rowCount(`
select count(*)
from game_engine.outcome_operational_controls
where control_type = 'EMERGENCY_DISABLE'
  and dual_approval_status = 'Approved'
  and effective_at <= now()
  and (expires_at is null or expires_at > now());
`) > 0;
const emergencyDisable = evaluateActivation(baseRequest({
  hasActiveEmergencyDisable: activeEmergencyDisable,
}));
addCheck("emergency disable fails closed", !emergencyDisable.allowed, { blockers: emergencyDisable.blockers });

const optionalJurisdiction = evaluateActivation(baseRequest({
  jurisdictionOmitted: true,
  certificationOmitted: false,
}));
addCheck("optional jurisdiction omitted still allowed", optionalJurisdiction.allowed, {
  warnings: optionalJurisdiction.warnings,
});

const optionalCertification = evaluateActivation(baseRequest({
  manifestRequiresCertification: false,
  certificationOmitted: true,
}));
addCheck("optional certification omitted allowed when manifest does not require certification", optionalCertification.allowed, {
  warnings: optionalCertification.warnings,
});

const manifestCertificationRequired = evaluateActivation(baseRequest({
  manifestRequiresCertification: true,
  certificationOmitted: true,
}));
addCheck("manifest-required certification omission fails closed", !manifestCertificationRequired.allowed, {
  blockers: manifestCertificationRequired.blockers,
});

const syntheticApproved = evaluateActivation(baseRequest({
  productionOutcomeAuthorityEnabled: true,
  productionRngProviderEligible: true,
  signingProviderProductionEligible: true,
  certificationPackReady: true,
  usesSimulationOrTestProvider: false,
  hasFailedOrInconclusiveStatisticalValidation: false,
  hasActiveEmergencyDisable: false,
}));
addCheck("full synthetic approved activation check passes without activating production", syntheticApproved.allowed, {
  warnings: syntheticApproved.warnings,
});

addCheck("production outcome authority remains disabled in runtime env", !productionEnvEnabled, {
  OUTCOME_AUTHORITY: process.env.OUTCOME_AUTHORITY ?? null,
  PRODUCTION_OUTCOME_AUTHORITY_ENABLED: process.env.PRODUCTION_OUTCOME_AUTHORITY_ENABLED ?? null,
});

addCheck(
  "no production outcome authority switch persisted",
  !existsRegclass("game_engine.outcome_authority_activations"),
);

const ledgerAfter = rowCount("select count(*) from public.financial_ledger_entries;");
addCheck("no settlement or ledger effects created", ledgerAfter === ledgerBefore, { before: ledgerBefore, after: ledgerAfter });

const failed = checks.filter((check) => check.status !== "PASS");
const report = {
  status: failed.length === 0 ? "PASS" : "FAIL",
  checks,
};

printJson(report);

if (failed.length > 0) {
  process.exitCode = 1;
}
