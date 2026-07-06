namespace GameEngine.Domain.Model;

public enum SigningProviderType
{
    LocalTest,
    SoftwareKey,
    Kms,
    Hsm,
    Simulation
}

public enum SigningProviderLifecycleState
{
    Draft,
    Active,
    Disabled,
    Retired,
    Revoked
}

public enum SigningFailureMode
{
    FailClosed,
    FailOpen
}

public enum SignatureVerificationStatus
{
    Pending,
    Verified,
    Failed,
    Revoked
}

public enum CertificateVerificationMode
{
    DryRun,
    Simulation,
    ProductionDisabled
}

public sealed record SigningProviderDefinition(
    string ProviderId,
    string ProviderVersion,
    SigningProviderType ProviderType,
    bool ProductionEligible,
    string Algorithm,
    string KeyIdentifier,
    string AlgorithmVersion,
    bool VerificationSupport,
    bool KeyRotationSupport,
    SigningFailureMode FailureMode,
    string ContentHash,
    SigningProviderLifecycleState LifecycleState);

public sealed record CertificateSignature(
    Guid SignatureId,
    string CertificateReferenceType,
    Guid CertificateId,
    string ProviderId,
    string ProviderVersion,
    string Algorithm,
    string AlgorithmVersion,
    string CanonicalPayloadHash,
    string SignatureValue,
    SignatureVerificationStatus VerificationStatus,
    DateTimeOffset IssuedAt);

public sealed record CertificateVerificationRequest(
    string CertificateReferenceType,
    Guid CertificateId,
    string CanonicalPayloadHash,
    string CanonicalPayloadJson,
    CertificateSignature Signature,
    SigningProviderDefinition SigningProvider,
    IReadOnlyCollection<CertificateReference> PreviousCertificates,
    CertificateVerificationMode Mode);

public sealed record CertificateVerificationResult(
    bool IsValid,
    IReadOnlyCollection<string> Errors,
    SignatureVerificationStatus VerificationStatus);
