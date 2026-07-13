namespace GameEngine.Domain.Model;

public enum OutcomeAuthorityReadinessSectionStatus
{
    Ready,
    Blocked
}

public enum OutcomeAuthorityRollbackWatermarkStatus
{
    Accepted,
    RegressionDetected,
    ChainMismatch,
    MissingEvidence
}

public enum LegacyRandomnessUsageMode
{
    TestOnly,
    DryRunOnly,
    SimulationOnly
}

public sealed record HmacDrbgConformanceVector(
    string VectorId,
    string VectorVersion,
    CertifiedCsprngHashAlgorithm HashAlgorithm,
    int SecurityStrengthBits,
    string EntropyHex,
    string NonceHex,
    string PersonalizationHex,
    string AdditionalInputHex,
    string ReseedEntropyHex,
    string ReseedAdditionalInputHex,
    int GenerateByteCount,
    string ExpectedFirstGenerateHex,
    string ExpectedPostReseedGenerateHex,
    string ExpectedFinalKeyHex,
    string ExpectedFinalValueHex,
    string SourceReference);

public sealed record HmacDrbgConformanceVectorResult(
    string VectorId,
    string VectorVersion,
    CertifiedCsprngHashAlgorithm HashAlgorithm,
    bool Passed,
    string ProviderBuildIdentity,
    string? FailureReason);

public sealed record HmacDrbgConformanceSuiteResult(
    string SuiteId,
    string SuiteVersion,
    bool Passed,
    IReadOnlyCollection<HmacDrbgConformanceVectorResult> VectorResults,
    IReadOnlyCollection<string> Blockers,
    string CanonicalResultHash);

public sealed record EntropyProviderDeploymentConfiguration(
    string ProviderId,
    string ProviderVersion,
    EntropyProviderType ProviderType,
    OsEntropyPlatform ExpectedPlatform,
    bool Approved,
    bool ProductionEligible,
    CertifiedCsprngFailureMode FailureMode,
    string ConfigurationHash);

public sealed record EntropyProviderConfigurationEvidence(
    bool ExactlyOneProviderConfigured,
    bool ProviderApproved,
    bool PlatformCompatible,
    bool FallbackDisabled,
    bool ProviderSubstitutionDetected,
    bool Ready,
    IReadOnlyCollection<string> Blockers);

public sealed record LegacyRandomnessIsolationEvidence(
    string SourcePath,
    LegacyRandomnessUsageMode UsageMode,
    bool ProductionEligible,
    bool RegisteredForCertifiedCsprngRuntime,
    IReadOnlyCollection<string> Blockers);

public sealed record OutcomeAuthorityReadinessSection(
    string Section,
    OutcomeAuthorityReadinessSectionStatus Status,
    IReadOnlyCollection<string> EvidenceReferences,
    IReadOnlyCollection<string> Blockers);

public sealed record OutcomeAuthorityReadinessReport(
    Guid ReportId,
    DateTimeOffset GeneratedAt,
    bool ProductionAuthorityEnabled,
    bool ProductionEligibleEvidenceOnly,
    IReadOnlyCollection<OutcomeAuthorityReadinessSection> Sections,
    IReadOnlyCollection<string> Blockers,
    string CanonicalReportHash);

public sealed record OutcomeRuntimeAdvisoryLockScopeEvidence(
    string Purpose,
    string Namespace,
    string ResourceScope,
    string DerivedLockScope,
    string DerivationAlgorithm,
    TimeSpan BoundedTimeout,
    bool RedisDependencyAbsent);

public sealed record OutcomeRuntimeRollbackWatermark(
    Guid WatermarkId,
    string WatermarkScope,
    long SequenceNumber,
    string? PreviousChainHash,
    string ChainRootHash,
    Guid BootId,
    Guid? RuntimeRequestId,
    IReadOnlyCollection<string> EvidenceHashes,
    DateTimeOffset ObservedAt);

public sealed record OutcomeRuntimeRollbackWatermarkEvaluation(
    OutcomeAuthorityRollbackWatermarkStatus Status,
    bool FailClosed,
    IReadOnlyCollection<string> Blockers);

public sealed record ExternalStatisticalEvidenceImportRequest(
    StatisticalValidationSuiteType SuiteType,
    ProviderValidationSubjectType TargetType,
    string TargetId,
    string TargetVersion,
    string TargetContentHash,
    string ToolName,
    string ToolVersion,
    string ProviderBuildIdentity,
    IReadOnlyDictionary<string, object?> Configuration,
    long SampleSize,
    string ReportHash,
    ValidationEvaluationStatus Status,
    string Operator,
    IReadOnlyCollection<string> Blockers,
    ValidationSupplyChainProvenance Provenance);

public sealed record ProcessRestartRecoveryHarnessPlan(
    string HarnessId,
    IReadOnlyCollection<OutcomeRuntimeCrashInjectionStage> SupportedCheckpoints,
    IReadOnlyCollection<string> VerificationSteps,
    bool RequiresContainerKillApproval,
    bool ProductionAuthorityDisabled);
