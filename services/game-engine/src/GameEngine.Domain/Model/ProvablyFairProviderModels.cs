namespace GameEngine.Domain.Model;

public enum ProvablyFairCommitAlgorithm
{
    HashCommitment
}

public enum ProvablyFairVerificationAlgorithm
{
    HmacSha256,
    HmacSha384,
    HmacSha512
}

public enum ProvablyFairHashAlgorithm
{
    Sha256,
    Sha384,
    Sha512
}

public enum ProvablyFairLifecycleState
{
    Draft,
    Active,
    Suspended,
    Retired,
    Superseded
}

public enum ProvablyFairSeedLifecycleState
{
    Committed,
    Active,
    Retired,
    Revealed,
    Superseded,
    Disputed
}

public enum ProvablyFairRevealState
{
    NotEligible,
    Eligible,
    Delayed,
    WindowOpen,
    Expired,
    Disputed,
    Superseded
}

public enum ProvablyFairNonceScopeType
{
    Wager,
    Draw
}

public enum ProvablyFairVerificationStatus
{
    PendingReveal,
    Verified,
    Failed,
    Disputed,
    Superseded
}

public enum ProvablyFairEncoding
{
    Utf8,
    Base64Url,
    Hex
}

public sealed record ProvablyFairClientSeedPolicy(
    bool Required,
    int MaximumLength,
    ProvablyFairEncoding AllowedEncoding,
    IReadOnlyCollection<string> ValidationRules,
    IReadOnlyCollection<string> CanonicalizationRules);

public sealed record ProvablyFairProviderDefinitionV1(
    Guid Id,
    string ProviderId,
    string ProviderVersion,
    string OutcomeProviderId,
    string OutcomeProviderVersion,
    ProvablyFairCommitAlgorithm CommitAlgorithm,
    ProvablyFairVerificationAlgorithm VerificationAlgorithm,
    ProvablyFairHashAlgorithm HashAlgorithm,
    IReadOnlyDictionary<string, object?> ServerSeedPolicy,
    ProvablyFairClientSeedPolicy ClientSeedPolicy,
    IReadOnlyDictionary<string, object?> NoncePolicy,
    IReadOnlyDictionary<string, object?> RevealPolicy,
    TimeSpan CommitmentLifetime,
    bool ReceiptSupport,
    bool ProductionEligible,
    ProvablyFairLifecycleState LifecycleState,
    string ContentHash,
    string? CertificationBinding);

public sealed record ProvablyFairServerSeedCommitment(
    Guid SeedId,
    string ProviderId,
    string ProviderVersion,
    DateTimeOffset SeedGenerationTimestamp,
    string CommitmentHash,
    ProvablyFairSeedLifecycleState SeedLifecycle,
    IReadOnlyDictionary<string, object?> RotationPolicy,
    DateTimeOffset? ActivationTimestamp,
    DateTimeOffset? RetirementTimestamp,
    string ContentHash);

public sealed record ProvablyFairNonceSequence(
    Guid Id,
    string ProviderId,
    string ProviderVersion,
    string ProviderScope,
    ProvablyFairNonceScopeType ScopeType,
    long Nonce,
    IReadOnlyDictionary<string, object?> NoncePolicy,
    bool MonotonicRequired,
    string UniquenessScope,
    string ContentHash);

public sealed record ProvablyFairVerificationReceipt(
    Guid ReceiptId,
    string WagerReference,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    string ProviderId,
    string ProviderVersion,
    string ServerCommitment,
    string ClientSeed,
    long Nonce,
    string? RevealedServerSeedPlaceholder,
    ProvablyFairVerificationAlgorithm VerificationAlgorithm,
    IReadOnlyDictionary<string, object?> CanonicalVerificationPayload,
    ProvablyFairVerificationStatus VerificationStatus,
    string ReceiptHash,
    SignatureMetadata? ReceiptSignature,
    IReadOnlyDictionary<string, object?> QrExportPayload);
