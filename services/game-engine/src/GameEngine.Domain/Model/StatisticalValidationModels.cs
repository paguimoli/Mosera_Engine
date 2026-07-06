namespace GameEngine.Domain.Model;

public enum StatisticalValidationType
{
    Frequency,
    ChiSquare,
    Runs,
    DistributionDrift,
    RtpSimulation,
    PrizeDistribution
}

public enum StatisticalValidationTargetArtifactType
{
    OutcomeStrategy,
    RngProvider,
    MathModel,
    Paytable,
    CertificationPack
}

public enum StatisticalValidationStatus
{
    Pass,
    Fail,
    Inconclusive
}

public enum SimulationMode
{
    DryRun,
    Simulation,
    ProductionDisabled
}

public sealed record StatisticalValidationResult(
    Guid ValidationId,
    StatisticalValidationType ValidationType,
    StatisticalValidationTargetArtifactType TargetArtifactType,
    string TargetArtifactId,
    string? TargetArtifactVersion,
    string TargetArtifactHash,
    long SampleSize,
    IReadOnlyDictionary<string, object?> ExpectedDistribution,
    IReadOnlyDictionary<string, object?> ObservedDistribution,
    decimal? PValue,
    decimal? Score,
    StatisticalValidationStatus ResultStatus,
    DateTimeOffset GeneratedAt,
    string CanonicalResultHash,
    SignatureMetadata? SigningMetadata);

public sealed record SimulationEvidence(
    Guid SimulationId,
    SimulationMode SimulationMode,
    string OutcomeStrategyId,
    string OutcomeStrategyVersion,
    string OutcomeStrategyHash,
    string MathModelId,
    string MathModelVersion,
    string MathModelHash,
    string PaytableId,
    string PaytableVersion,
    string PaytableHash,
    string RngProviderId,
    string RngProviderVersion,
    string RngProviderHash,
    long IterationCount,
    decimal TheoreticalRtp,
    decimal ObservedRtp,
    decimal Variance,
    decimal HitFrequency,
    IReadOnlyDictionary<string, object?> PrizeDistribution,
    IReadOnlyDictionary<string, object?> ConfidenceInterval,
    string CanonicalEvidenceHash,
    SignatureMetadata? SigningMetadata);

public sealed record StatisticalCertificationReadiness(
    bool IsCertificationReady,
    IReadOnlyCollection<string> Blockers);
