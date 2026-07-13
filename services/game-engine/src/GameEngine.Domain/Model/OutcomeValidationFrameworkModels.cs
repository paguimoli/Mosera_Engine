namespace GameEngine.Domain.Model;

public enum CryptographicConformanceSubjectType
{
    CertifiedCsprng,
    ProvablyFair,
    OutcomeProvider,
    EntropyProvider,
    SigningProvider
}

public enum CryptographicConformanceCheckType
{
    HmacDrbgInstantiate,
    HmacDrbgGenerate,
    HmacDrbgReseed,
    HmacDrbgUpdate,
    HmacDrbgDestroy,
    SecurityStrength,
    PredictionResistancePolicy,
    ReseedIntervalPolicy,
    PersonalizationHandling,
    AdditionalInputHandling,
    KnownAnswerTests,
    ContinuousTests,
    HealthTests,
    ProviderVersionCompatibility,
    ProviderConfiguration
}

public enum ValidationEvaluationStatus
{
    Pass,
    Fail,
    Inconclusive
}

public enum StatisticalValidationSuiteType
{
    Frequency,
    ChiSquare,
    Runs,
    SerialCorrelation,
    Distribution,
    Variance,
    Mean,
    EntropyEstimate,
    CollisionRate,
    Uniformity,
    Independence,
    BiasDetection,
    WeightedSelection,
    FisherYatesShuffle,
    OutcomeDslPrimitive,
    RtpSimulation,
    PrizeDistribution,
    ExternalImported
}

public enum ProviderValidationSubjectType
{
    OutcomeProvider,
    EntropyProvider,
    CertifiedCsprng,
    ProvablyFair,
    ExternalOfficial,
    PhysicalDraw,
    SigningProvider
}

public enum CertificationReadinessStatus
{
    NotValidated,
    StatisticallyValidated,
    CryptographicallyConformant,
    CertificationReady,
    ProductionEligible
}

public sealed record ValidationSupplyChainProvenance(
    string GitCommitSha,
    string SemanticVersion,
    string BuildNumber,
    string? DockerImageDigest,
    string CompilerRuntimeVersion,
    string ImplementationHash,
    string ConfigurationHash);

public sealed record CryptographicConformanceReport(
    Guid ReportId,
    CryptographicConformanceSubjectType SubjectType,
    string SubjectId,
    string SubjectVersion,
    string SubjectContentHash,
    IReadOnlyCollection<CryptographicConformanceCheckType> ChecksEvaluated,
    ValidationEvaluationStatus Status,
    IReadOnlyCollection<string> Blockers,
    IReadOnlyDictionary<string, object?> TestVectors,
    IReadOnlyDictionary<string, object?> ProviderEvidence,
    ValidationSupplyChainProvenance Provenance,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    string CanonicalReportHash,
    SignatureMetadata? SigningMetadata);

public sealed record StatisticalValidationFrameworkReport(
    Guid ReportId,
    StatisticalValidationSuiteType SuiteType,
    ProviderValidationSubjectType TargetType,
    string TargetId,
    string TargetVersion,
    string TargetContentHash,
    string? ManifestId,
    string? ManifestVersion,
    string AlgorithmVersion,
    long SampleSize,
    IReadOnlyDictionary<string, object?> Configuration,
    IReadOnlyDictionary<string, object?> StatisticalSummary,
    ValidationEvaluationStatus Status,
    IReadOnlyCollection<string> Blockers,
    ValidationSupplyChainProvenance Provenance,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    string CanonicalReportHash,
    SignatureMetadata? SigningMetadata);

public sealed record ProviderValidationRegistryEntry(
    Guid RegistryEntryId,
    ProviderValidationSubjectType ProviderType,
    string ProviderId,
    string ProviderVersion,
    string ValidationVersion,
    string ImplementationHash,
    string ConfigurationHash,
    ValidationEvaluationStatus ValidationStatus,
    DateTimeOffset ValidationDate,
    string Operator,
    IReadOnlyCollection<string> EvidenceHashes,
    string CanonicalRegistryHash);

public sealed record CertificationReadinessEvaluation(
    Guid EvaluationId,
    ProviderValidationSubjectType TargetType,
    string TargetId,
    string TargetVersion,
    CertificationReadinessStatus Status,
    bool StatisticalValidationPassed,
    bool CryptographicConformancePassed,
    bool RequiredEvidenceComplete,
    bool ProviderHealthPassed,
    bool RuntimeReadinessPassed,
    bool GuardrailsPassed,
    bool ProviderApproved,
    bool OutcomeAuthorityDisabled,
    IReadOnlyCollection<string> Blockers,
    IReadOnlyCollection<string> EvidenceHashes,
    ValidationSupplyChainProvenance Provenance,
    DateTimeOffset EvaluatedAt,
    string CanonicalEvaluationHash);
