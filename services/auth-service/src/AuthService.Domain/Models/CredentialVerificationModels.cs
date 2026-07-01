namespace AuthService.Domain.Models;

public enum CredentialVerificationStatus
{
    Success,
    Failed,
    Locked,
    PendingVerification,
    Suspended,
    Disabled,
    Archived,
    MfaRequired,
    UnsupportedCredential,
    CredentialExpired,
    CredentialDisabled,
    PolicyDenied
}

public enum CredentialFailureReason
{
    None,
    IdentityNotFound,
    LifecycleDenied,
    CredentialNotFound,
    UnsupportedCredentialType,
    CredentialDisabled,
    CredentialExpired,
    InvalidCredential,
    MfaRequired,
    PolicyDenied,
    VerificationNotImplemented,
    RiskRejected
}

public enum MfaRequirementReason
{
    None,
    IdentityType,
    Role,
    Policy,
    PrivilegedOperation,
    SuspiciousLogin,
    StepUpRequired
}

public enum SecurityRiskFlag
{
    None,
    SuspiciousLogin,
    UnknownDevice,
    ImpossibleTravel,
    HighRiskNetwork,
    RepeatedFailure,
    CredentialStuffingSuspected,
    PrivilegedIdentity
}

public enum AuthenticationEligibilityStatus
{
    Eligible,
    Locked,
    PendingVerification,
    Suspended,
    Disabled,
    Archived,
    Denied
}

public sealed record MfaRequirementResult(
    bool Required,
    IReadOnlyCollection<MfaRequirementReason> Reasons,
    IReadOnlyCollection<MfaMethod> AllowedMethods,
    bool RememberedDeviceAccepted,
    bool StepUpRequired);

public sealed record AuthenticationEligibilityResult(
    Guid IdentityId,
    IdentityLifecycleState LifecycleState,
    AuthenticationEligibilityStatus Status,
    bool MayAttemptCredentialVerification,
    string Reason);

public sealed record CredentialAuditEvent(
    Guid EventId,
    Guid? IdentityId,
    Guid? CredentialId,
    CredentialType? CredentialType,
    CredentialVerificationStatus Status,
    CredentialFailureReason FailureReason,
    IReadOnlyCollection<SecurityRiskFlag> RiskFlags,
    IReadOnlyDictionary<string, string> Metadata,
    DateTimeOffset CreatedAt);

public sealed record CredentialVerificationResult(
    bool Success,
    CredentialVerificationStatus Status,
    CredentialFailureReason FailureReason,
    CredentialType CredentialType,
    Guid IdentityId,
    Guid? CredentialId,
    DateTimeOffset VerifiedAt,
    IReadOnlyCollection<SecurityRiskFlag> RiskFlags,
    MfaRequirementResult MfaRequirement,
    IReadOnlyDictionary<string, string> AuditMetadata);
