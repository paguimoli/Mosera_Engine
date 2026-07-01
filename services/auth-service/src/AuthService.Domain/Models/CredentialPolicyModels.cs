namespace AuthService.Domain.Models;

public enum PasswordHashingDecision
{
    Deferred,
    Argon2idPreferred,
    Pbkdf2Allowed,
    BCryptAllowed
}

public enum MfaMethod
{
    Totp,
    WebAuthnPasskey,
    EmailOtpPlaceholder,
    SmsOtpPlaceholder,
    RecoveryCodePlaceholder
}

public sealed record PasswordPolicy(
    int MinimumLength,
    int MaximumLength,
    bool RequireUppercase,
    bool RequireLowercase,
    bool RequireDigit,
    bool RequireSymbol,
    bool CompromisedPasswordCheckPlaceholder,
    bool PasswordReusePreventionPlaceholder,
    bool PasswordExpirationPolicyPlaceholder,
    bool PasswordResetRequiredFlagSupported,
    bool TemporaryPasswordFlagSupported,
    int FailedLoginLockoutThreshold,
    TimeSpan LockoutDuration,
    bool AdminForcedResetSupported,
    bool PasswordlessAllowed,
    PasswordHashingDecision HashingDecision,
    bool PlaintextPasswordStorageAllowed);

public sealed record MfaPolicy(
    IReadOnlyCollection<IdentityType> RequiredIdentityTypes,
    IReadOnlyCollection<string> RequiredRoles,
    IReadOnlyCollection<string> RequiredPolicyCodes,
    bool RequiredForPrivilegedOperations,
    bool RequiredForSuspiciousLogin,
    IReadOnlyCollection<MfaMethod> SupportedMethods,
    bool RememberedDevicePlaceholder,
    bool StepUpAuthenticationPlaceholder,
    bool ProductionMfaVerificationImplemented);

public sealed record CredentialVerificationPolicy(
    PasswordPolicy PasswordPolicy,
    MfaPolicy MfaPolicy,
    bool LifecycleGateRequired,
    bool AuditEventRequired,
    bool SessionCreationAllowed,
    bool TokenIssuanceAllowed);
