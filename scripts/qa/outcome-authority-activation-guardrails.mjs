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
