namespace GameEngine.Domain.Model;

public sealed record OutcomeAuthorityReadinessMarkers(
    bool GameManifestSchemaReady,
    bool AuthorityCertificateChainReady,
    bool OutcomeDslReady,
    bool MathRtpGovernanceReady,
    bool RngProviderGovernanceReady,
    bool OutcomeDryRunPipelineReady,
    bool MathEvaluationDryRunReady,
    bool CertificationPackReady,
    bool CertificateSigningFrameworkReady,
    bool StatisticalValidationReady,
    bool OperationalControlsReady);

public sealed record OutcomeAuthorityActivationRequest(
    OutcomeAuthorityReadinessMarkers ReadinessMarkers,
    bool ProductionOutcomeAuthorityEnabled,
    bool ProductionRngProviderEligible,
    bool SigningProviderProductionEligible,
    bool CertificationPackReady,
    bool UsesSimulationOrTestProvider,
    bool JurisdictionOmitted,
    bool ManifestRequiresCertification,
    bool CertificationOmitted,
    bool HasFailedOrInconclusiveStatisticalValidation,
    bool HasActiveEmergencyDisable);

public sealed record OutcomeAuthorityActivationGuardrailResult(
    bool Allowed,
    IReadOnlyCollection<string> Blockers,
    IReadOnlyCollection<string> Warnings);
