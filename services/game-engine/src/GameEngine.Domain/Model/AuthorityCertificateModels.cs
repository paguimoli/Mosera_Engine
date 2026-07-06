namespace GameEngine.Domain.Model;

public enum GameManifestLifecycleState
{
    Draft,
    InternalReview,
    SimulationCertified,
    CertificationPending,
    Certified,
    GovernanceApproved,
    ProductionActive,
    Suspended,
    Retired,
    Superseded
}

public enum OperatorApprovalState
{
    NotSubmitted,
    PendingApproval,
    Approved,
    Rejected,
    Revoked
}

public enum AuthorityCertificateType
{
    GovernanceApproval,
    GameManifest,
    OutcomeStrategy,
    RngProvider,
    Outcome,
    MathModel,
    MathEvaluation,
    Settlement,
    Financial,
    AuditExport
}

public enum AuthorityCertificateApprovalState
{
    Draft,
    PendingApproval,
    Approved,
    Rejected,
    Revoked,
    Superseded
}

public sealed record SignatureMetadata(
    string SigningKeyId,
    string HashAlgorithmVersion,
    string SigningAlgorithmVersion,
    string Signature,
    DateTimeOffset SignedAt);

public sealed record GameManifestV1(
    Guid Id,
    Guid GameId,
    string GameCode,
    string GameName,
    string GameFamily,
    IReadOnlyCollection<string> JurisdictionBindings,
    IReadOnlyCollection<string> WagerSchemas,
    IReadOnlyCollection<string> OutcomeStrategyReferences,
    IReadOnlyCollection<string> MathModelReferences,
    IReadOnlyCollection<string> PaytableReferences,
    IReadOnlyCollection<string> SettlementPolicyReferences,
    IReadOnlyDictionary<string, object?> SalesRules,
    IReadOnlyDictionary<string, object?> CancellationCorrectionRules,
    IReadOnlyDictionary<string, object?> ReplayResettlementPolicy,
    string CertificationPackReference,
    string RegulatorProfile,
    OperatorApprovalState OperatorApprovalState,
    GameManifestLifecycleState LifecycleState,
    DateTimeOffset EffectiveFrom,
    DateTimeOffset? EffectiveTo,
    string SemanticVersion,
    string ContentHash,
    SignatureMetadata SignatureMetadata);

public sealed record CertificateReference(
    Guid? CertificateId,
    string? CertificateHash);

public sealed record AuthorityCertificate(
    Guid CertificateId,
    string AuthorityId,
    AuthorityCertificateType CertificateType,
    string SubjectId,
    string SubjectVersion,
    string CanonicalPayloadHash,
    IReadOnlyCollection<CertificateReference> PreviousCertificates,
    string SigningKeyId,
    string HashAlgorithmVersion,
    string SigningAlgorithmVersion,
    DateTimeOffset IssuedAt,
    string JurisdictionProfile,
    AuthorityCertificateApprovalState ApprovalState,
    Guid? RevocationCertificateId,
    Guid? SupersedesCertificateId,
    IReadOnlyDictionary<string, object?> Payload);
