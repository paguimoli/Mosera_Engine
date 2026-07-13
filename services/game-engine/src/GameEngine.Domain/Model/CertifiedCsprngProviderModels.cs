namespace GameEngine.Domain.Model;

public enum OsEntropyPlatform
{
    Linux,
    Windows,
    MacOS,
    Unsupported
}

public enum EntropyProviderType
{
    OsCsprng,
    HardwareEntropy,
    Hybrid,
    TestSimulation
}

public enum CertifiedDrbgType
{
    HmacDrbg
}

public enum CertifiedCsprngHashAlgorithm
{
    Sha256,
    Sha384,
    Sha512
}

public enum CertifiedCsprngFailureMode
{
    FailClosed,
    Disabled
}

public enum CertifiedCsprngLifecycleState
{
    Draft,
    Active,
    Suspended,
    Retired,
    Superseded
}

public enum CertifiedSamplingCapability
{
    RejectionSampling,
    FisherYatesShuffle,
    UniqueNumberSelection,
    IntegerRationalWeightedSelection
}

public enum DrbgEvidenceTestResult
{
    Passed,
    Failed,
    Missing,
    NotApplicable
}

public sealed record EntropyProviderDefinitionV1(
    Guid Id,
    string ProviderId,
    string ProviderVersion,
    EntropyProviderType ProviderType,
    string PlatformRuntimeReference,
    IReadOnlyDictionary<string, object?> EntropySourceMetadata,
    int MinimumEntropyBits,
    IReadOnlyCollection<string> HealthTestCapabilities,
    bool ProductionEligible,
    CertifiedCsprngFailureMode FailureMode,
    string ContentHash);

public sealed record CertifiedCsprngProviderDefinitionV1(
    Guid Id,
    string ProviderId,
    string ProviderVersion,
    string OutcomeProviderId,
    string OutcomeProviderVersion,
    string LinkedRngProviderId,
    string LinkedRngProviderVersion,
    EntropyProviderType EntropyProviderType,
    CertifiedDrbgType DrbgType,
    CertifiedCsprngHashAlgorithm HashAlgorithm,
    int SecurityStrengthBits,
    IReadOnlyDictionary<string, object?> ReseedPolicy,
    IReadOnlyDictionary<string, object?> SessionIsolationPolicy,
    IReadOnlyDictionary<string, object?> ZeroizationPolicy,
    bool StartupSelfTestSupported,
    bool KnownAnswerTestSupported,
    bool ContinuousHealthTestSupported,
    bool ProductionEligible,
    CertifiedCsprngLifecycleState LifecycleState,
    CertifiedCsprngFailureMode FailureMode,
    IReadOnlyCollection<CertifiedSamplingCapability> SamplingCapabilities,
    string ContentHash,
    string? CertificationBinding);

public sealed record DrbgSessionEvidence(
    Guid SessionId,
    string DrawRequestScope,
    string ProviderId,
    string ProviderVersion,
    string EntropyProviderId,
    string EntropyProviderVersion,
    long ReseedCounter,
    string PersonalizationStringHash,
    string NonceHash,
    string SeedCommitmentHash,
    DrbgEvidenceTestResult StartupSelfTestResult,
    DrbgEvidenceTestResult KnownAnswerTestResult,
    DrbgEvidenceTestResult ContinuousTestResult,
    DateTimeOffset GeneratedAt,
    DateTimeOffset DestroyedZeroizedAt,
    string CanonicalEvidenceHash,
    SignatureMetadata? SigningMetadata);
