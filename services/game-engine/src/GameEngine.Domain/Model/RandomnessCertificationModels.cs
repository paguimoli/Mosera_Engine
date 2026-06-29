namespace GameEngine.Domain.Model;

public enum RandomnessProviderType
{
    ProductionPrng,
    TestPrng
}

public enum RandomnessCapability
{
    GenerateRandomBytes,
    GenerateBoundedInteger,
    DeterministicSeed,
    CryptographicProvider,
    CertificationEvidence
}

public enum RandomnessProviderHealthStatus
{
    Healthy,
    Warning,
    Unhealthy
}

public enum DrawSamplingMode
{
    WithoutReplacement,
    WithReplacement,
    FutureDeck,
    FutureDice,
    FutureWheel
}

public enum CertificationStatus
{
    Draft,
    Ready,
    Generated,
    Failed
}

public enum CertificationArtifactType
{
    StructuredMetadata,
    ValidationResult,
    Checksum,
    EnvironmentSummary,
    ApprovalPlaceholder
}

public enum CertificationRecipientType
{
    InternalReview,
    ExternalLaboratory,
    Regulator,
    Partner
}

public enum EvidenceSource
{
    GameEngine,
    GameModule,
    RandomnessProvider,
    ValidationSuite,
    Operator,
    BuildSystem
}

public enum EvidenceCategory
{
    Rules,
    Configuration,
    Randomness,
    Validation,
    Benchmark,
    Build,
    Environment,
    Approval
}

public enum EvidenceHashAlgorithm
{
    Sha256,
    Future
}

public enum ValidationSuiteCommand
{
    ValidatePrng,
    ValidateDrawGenerator,
    CompareVersions,
    BenchmarkModule,
    GenerateCertificationPackage,
    AnalyzeHistoricalDraws
}

public enum ValidationCheckStatus
{
    Placeholder,
    Ready,
    Warning,
    Failed
}

public sealed record RandomnessProviderMetadata(
    string ProviderId,
    string ProviderName,
    RandomnessProviderType ProviderType,
    string ProviderVersion,
    bool ProductionRngImplemented,
    bool Deterministic,
    string ImplementationStatus);

public sealed record RandomnessProviderHealth(
    RandomnessProviderHealthStatus Status,
    IReadOnlyCollection<string> Reasons,
    DateTimeOffset CheckedAt);

public sealed record RandomnessProviderDiagnostic(
    RandomnessProviderMetadata Metadata,
    IReadOnlyCollection<RandomnessCapability> Capabilities,
    RandomnessProviderHealth Health);

public sealed record DrawSamplingRequest(
    int MinimumInclusive,
    int MaximumInclusive,
    int SelectionCount,
    DrawSamplingMode SamplingMode);

public sealed record DrawSamplingDiagnostic(
    DrawSamplingMode SamplingMode,
    string Status,
    IReadOnlyCollection<string> SupportedFutureGenerators);

public sealed record EvidenceHash(
    EvidenceHashAlgorithm Algorithm,
    string Value);

public sealed record EvidenceVersion(
    string SchemaVersion,
    string ProducerVersion);

public sealed record EvidenceChecksum(
    EvidenceHashAlgorithm Algorithm,
    string Value,
    DateTimeOffset CreatedAt);

public sealed record EvidenceTimestamp(
    DateTimeOffset CreatedAt,
    string ClockSource);

public sealed record EvidenceProducer(
    string ProducerId,
    string ProducerName,
    string ProducerVersion);

public sealed record EvidenceReference(
    string ReferenceId,
    string ReferenceType,
    EvidenceHash Hash);

public sealed record EvidenceFile(
    string FileName,
    EvidenceSource Source,
    EvidenceCategory Category,
    EvidenceVersion Version,
    EvidenceChecksum Checksum,
    EvidenceTimestamp Timestamp,
    EvidenceProducer Producer,
    IReadOnlyDictionary<string, object?> Metadata,
    IReadOnlyCollection<EvidenceReference> References);

public sealed record CertificationMetadata(
    string CertificationId,
    string ProfileId,
    string Status,
    DateTimeOffset CreatedAt,
    IReadOnlyDictionary<string, object?> Metadata);

public sealed record CertificationArtifact(
    string ArtifactId,
    CertificationArtifactType ArtifactType,
    EvidenceHash Hash,
    IReadOnlyDictionary<string, object?> Metadata);

public sealed record CertificationRecipient(
    string RecipientId,
    CertificationRecipientType RecipientType,
    string Name);

public sealed record CertificationProfile(
    string ProfileId,
    string ProfileName,
    IReadOnlyCollection<string> RequiredValidationChecks,
    IReadOnlyCollection<CertificationRecipient> Recipients);

public sealed record CertificationEvidence(
    string EvidenceId,
    EvidenceFile EvidenceFile,
    IReadOnlyCollection<CertificationArtifact> Artifacts);

public sealed record ValidationSuiteResult(
    string ValidatorId,
    string ValidatorName,
    ValidationSuiteCommand Command,
    ValidationCheckStatus Status,
    string Message,
    IReadOnlyDictionary<string, object?> Metrics);

public sealed record CertificationReport(
    string ReportId,
    CertificationStatus Status,
    IReadOnlyCollection<ValidationSuiteResult> ValidationResults,
    IReadOnlyCollection<string> Warnings,
    DateTimeOffset GeneratedAt);

public sealed record CertificationPackage(
    string PackageId,
    CertificationStatus Status,
    IReadOnlyDictionary<string, object?> GameMetadata,
    IReadOnlyDictionary<string, object?> ModuleMetadata,
    RandomnessProviderMetadata PrngMetadata,
    IReadOnlyDictionary<string, object?> DrawGeneratorMetadata,
    IReadOnlyDictionary<string, object?> VersionMetadata,
    IReadOnlyDictionary<string, object?> ConfigurationMetadata,
    IReadOnlyDictionary<string, object?> BuildMetadata,
    IReadOnlyDictionary<string, object?> EnvironmentMetadata,
    IReadOnlyDictionary<string, object?> HardwareMetadata,
    IReadOnlyCollection<EvidenceChecksum> Checksums,
    IReadOnlyCollection<ValidationSuiteResult> ValidationResults,
    CertificationMetadata CertificationMetadata,
    IReadOnlyCollection<CertificationEvidence> Evidence,
    IReadOnlyCollection<CertificationArtifact> Artifacts);

public sealed record CertificationRun(
    string RunId,
    CertificationProfile Profile,
    CertificationPackage Package,
    CertificationReport Report,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt);

public sealed record CertificationSuiteStatus(
    CertificationStatus Status,
    int PackageCount,
    int ValidationCheckCount,
    int EvidenceFileCount,
    IReadOnlyCollection<string> Warnings,
    DateTimeOffset GeneratedAt);

public sealed record StatisticalFrameworkStatus(
    int ValidatorCount,
    int BenchmarkCount,
    IReadOnlyCollection<string> Validators,
    IReadOnlyCollection<string> Benchmarks,
    string AlgorithmStatus,
    DateTimeOffset GeneratedAt);
