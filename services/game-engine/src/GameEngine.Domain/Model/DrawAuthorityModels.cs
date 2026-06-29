namespace GameEngine.Domain.Model;

public enum DrawAuthorityType
{
    InternalProductionPrng,
    InternalTestPrng,
    ExternalRngProvider,
    OfficialFeed,
    ManualCertifiedEntry,
    SupplierApi
}

public enum DrawAuthorityApprovalStatus
{
    NotApproved,
    InternallyApproved,
    ExternallyCertified,
    ProductionApproved
}

public enum DrawAuthorityCapability
{
    CanGenerateInternalResults,
    CanImportExternalResults,
    CanAcceptManualResults,
    CanSubmitEvidenceOnly,
    CanCertifyOfficialResult,
    RequiresOperatorCertification
}

public enum DrawAuthorityAssignmentStatus
{
    Draft,
    TestingOnly,
    Validated,
    Rejected,
    Active,
    Retired
}

public enum DrawResultSubmissionStatus
{
    Submitted,
    Rejected,
    Certified,
    Superseded
}

public enum DrawCertificationStatus
{
    Approved,
    Rejected
}

public enum DrawAuthorityHealthStatus
{
    Unknown,
    Healthy,
    Warning,
    Unhealthy
}

public sealed record DrawAuthorityVersionMetadata(
    string Version,
    string ProviderVersion,
    string ConfigurationSchemaVersion,
    string ApprovalReference,
    string EvidenceHash,
    DateTimeOffset CreatedAt);

public sealed record DrawProviderMetadata(
    string ProviderId,
    string ProviderName,
    DrawProviderType ProviderType,
    string ProviderVersion,
    bool ProductionRngImplemented,
    string ImplementationStatus);

public sealed record DrawProviderHealth(
    DrawAuthorityHealthStatus Status,
    IReadOnlyCollection<string> Reasons,
    DateTimeOffset CheckedAt);

public sealed record DrawAuthorityDefinition(
    Guid Id,
    string Code,
    string DisplayName,
    DrawAuthorityType AuthorityType,
    DrawProviderType ProviderType,
    DrawAuthorityStatus Status,
    DrawAuthorityApprovalStatus ApprovalStatus,
    IReadOnlyCollection<DrawAuthorityCapability> Capabilities,
    Guid ActiveVersionId,
    DateTimeOffset CreatedAt);

public sealed record DrawAuthorityVersionDefinition(
    Guid Id,
    Guid DrawAuthorityId,
    string Version,
    DrawAuthorityVersionMetadata Metadata,
    IReadOnlyDictionary<string, object?> Configuration,
    ValidationResult Validation,
    DateTimeOffset CreatedAt);

public sealed record DrawAuthorityAssignmentDefinition(
    Guid Id,
    Guid DrawAuthorityId,
    Guid DrawAuthorityVersionId,
    Guid GameBindingId,
    bool ProductionBinding,
    DrawAuthorityAssignmentStatus Status,
    ValidationResult Validation,
    DateTimeOffset EffectiveFrom,
    DateTimeOffset? EffectiveTo);

public sealed record DrawResultEvidence(
    string EvidenceType,
    string EvidenceHash,
    string SubmittedBy,
    DateTimeOffset SubmittedAt,
    IReadOnlyDictionary<string, object?> Metadata);

public sealed record DrawResultSubmissionDefinition(
    Guid Id,
    Guid DrawScheduleId,
    Guid DrawAuthorityId,
    Guid DrawAuthorityVersionId,
    string ResultHash,
    IReadOnlyDictionary<string, object?> Payload,
    DrawResultEvidence Evidence,
    DrawResultSubmissionStatus Status,
    DateTimeOffset SubmittedAt);

public sealed record DrawCertificationDecision(
    Guid DrawScheduleId,
    Guid DrawResultSubmissionId,
    Guid DrawAuthorityId,
    string CertifiedBy,
    bool OperatorCertificationMetadataPresent,
    DateTimeOffset DecidedAt);

public sealed record OfficialCertifiedDrawResultDefinition(
    Guid Id,
    Guid DrawScheduleId,
    Guid DrawResultSubmissionId,
    Guid DrawAuthorityId,
    string ResultHash,
    DrawCertificationStatus Status,
    DrawResultEvidence Evidence,
    DateTimeOffset CertifiedAt);

public sealed record DrawAuthorityRegistryEntry(
    DrawAuthorityDefinition Authority,
    DrawAuthorityVersionDefinition Version,
    DrawProviderMetadata ProviderMetadata,
    DrawProviderHealth ProviderHealth,
    bool ProductionReady,
    ValidationResult Validation,
    DateTimeOffset RegisteredAt);

public sealed record DrawAuthorityRegistryStatus(
    GameModuleRegistryHealth Health,
    int RegisteredAuthorityCount,
    int ActiveAuthorityCount,
    int RetiredAuthorityCount,
    int ProductionReadyAuthorityCount,
    int InvalidAuthorityCount,
    int ProviderCount,
    IReadOnlyCollection<string> Reasons,
    DateTimeOffset GeneratedAt);
