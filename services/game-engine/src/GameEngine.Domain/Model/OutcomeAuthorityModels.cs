namespace GameEngine.Domain.Model;

public enum OutcomeAuthorityMode
{
    DryRun,
    Simulation,
    ProductionDisabled
}

public enum OutcomeCustodyState
{
    Generated,
    Sealed,
    Certified,
    Superseded,
    Voided,
    Disputed
}

public sealed record OutcomeAuthorityRequest(
    Guid RequestId,
    Guid DrawId,
    string GameManifestReference,
    string OutcomeStrategyId,
    string OutcomeStrategyVersion,
    string RngProviderId,
    string RngProviderVersion,
    string RngEvidenceHash,
    string IdempotencyKey,
    OutcomeAuthorityMode Mode);

public sealed record OutcomeCertificate(
    Guid CertificateId,
    Guid OutcomeId,
    Guid DrawId,
    string StrategyId,
    string StrategyVersion,
    string RngProviderId,
    string RngProviderVersion,
    string CanonicalOutcomeHash,
    string EvidenceHashReference,
    IReadOnlyCollection<CertificateReference> PreviousCertificates,
    SignatureMetadata? SigningMetadata,
    OutcomeCustodyState CustodyState,
    DateTimeOffset IssuedAt);

public sealed record OutcomeAuthorityResult(
    Guid OutcomeId,
    Guid RequestId,
    Guid DrawId,
    string IdempotencyKey,
    OutcomeAuthorityMode Mode,
    IReadOnlyDictionary<string, object?> OutcomePayload,
    string CanonicalOutcomeJson,
    string CanonicalOutcomeHash,
    OutcomeCertificate Certificate,
    DateTimeOffset GeneratedAt);
