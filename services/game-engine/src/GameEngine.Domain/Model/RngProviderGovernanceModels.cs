namespace GameEngine.Domain.Model;

public enum RngProviderType
{
    OsCsprng,
    HmacDrbg,
    CtrDrbg,
    HashDrbg,
    HardwareEntropy,
    TestDeterministic,
    Simulation
}

public enum RngProviderCertificationState
{
    None,
    InternalVerified,
    LabSubmitted,
    Certified
}

public enum RngProviderFailureMode
{
    FailClosed,
    DegradedReadOnly,
    Disabled
}

public enum RngHealthTestResult
{
    NotApplicable,
    Passed,
    Failed,
    Missing
}

public sealed record RngProviderDefinitionV1(
    Guid Id,
    string ProviderId,
    string ProviderVersion,
    RngProviderType ProviderType,
    bool ProductionEligible,
    RngProviderCertificationState CertificationState,
    IReadOnlyCollection<string> AlgorithmReferences,
    IReadOnlyDictionary<string, object?> EntropySourceMetadata,
    IReadOnlyCollection<string> HealthTestCapabilities,
    RngProviderFailureMode FailureMode,
    string ContentHash,
    SignatureMetadata? SignatureMetadata);

public sealed record RngProviderEvidence(
    Guid EvidenceId,
    string ProviderId,
    string ProviderVersion,
    string EntropySourceReference,
    RngHealthTestResult HealthTestResult,
    RngHealthTestResult KnownAnswerTestResult,
    RngHealthTestResult ContinuousTestResult,
    DateTimeOffset GeneratedAt,
    string CanonicalEvidenceHash,
    SignatureMetadata? SigningMetadata);
