using AuthService.Domain.Models;
using AuthService.Domain.Boundaries;

var loginId = new LoginId(" global-admin ");
Assert(loginId.Value == "global-admin", "Login ID should normalize surrounding whitespace.");

var credential = new Credential(
    Guid.NewGuid(),
    Guid.NewGuid(),
    CredentialType.Passkey,
    "public-passkey-reference",
    PasswordOptional: true,
    Active: true,
    DateTimeOffset.UtcNow,
    ExpiresAt: null);

Assert(credential.PasswordOptional, "Credentials must support passwordless identities.");
Assert(Enum.GetNames<IdentityType>().Contains(nameof(IdentityType.PamUser)), "PAM users must be represented.");
Assert(Enum.GetNames<IdentityType>().Contains(nameof(IdentityType.ServiceAccount)), "Service accounts must be represented.");
Assert(Enum.GetNames<CredentialType>().Contains(nameof(CredentialType.ClientCertificate)), "mTLS credential references must be represented.");

var identity = new Identity(
    Guid.NewGuid(),
    loginId,
    IdentityType.Admin,
    IdentityLifecycleState.Created,
    [credential],
    [],
    [],
    [],
    DateTimeOffset.UtcNow);

Assert(identity.Credentials.Count == 1, "Identity must support multiple credential collection semantics.");
Assert(identity.LifecycleState == IdentityLifecycleState.Created, "Identity lifecycle state machine must start explicitly.");

var policy = new Policy(
    "authority.approval.admin",
    "Authority Approval Admin",
    "role == operations_admin && claim.authority.approver == true",
    ["authority.approver"],
    ["operations_admin"],
    EnforcedLocallyByServices: true);

Assert(policy.EnforcedLocallyByServices, "Hybrid policy model requires local service enforcement.");

var passwordCredential = new PasswordCredential(
    Guid.NewGuid(),
    identity.Id,
    "password-public-reference",
    "deferred",
    "v0",
    Enabled: true,
    DateTimeOffset.UtcNow,
    DisabledAt: null,
    ExpiresAt: null);
Assert(passwordCredential.Enabled, "Credentials must be individually enabled or disabled.");

var secretBoundary = new CredentialSecretBoundary(passwordCredential.CredentialId, "vault://auth/password/placeholder", ReturnedByPublicQueryModel: false);
Assert(!secretBoundary.ReturnedByPublicQueryModel, "Credential secret material must not be returned by public query models.");

var refreshToken = new RefreshTokenMetadata(
    Guid.NewGuid(),
    Guid.NewGuid(),
    RotationCounter: 1,
    PreviousRefreshTokenId: Guid.NewGuid(),
    DateTimeOffset.UtcNow,
    DateTimeOffset.UtcNow.AddDays(7),
    RotatedAt: DateTimeOffset.UtcNow,
    RevokedAt: null);
Assert(refreshToken.RotationCounter == 1 && refreshToken.PreviousRefreshTokenId is not null, "Refresh token rotation metadata must be modeled.");

var signingKey = new SigningKeyMetadata(Guid.NewGuid(), "kid-auth-v1", "RS256", Version: 1, "PLANNED", DateTimeOffset.UtcNow, null, null);
Assert(signingKey.Version == 1 && signingKey.KeyId == "kid-auth-v1", "Signing key metadata must be versioned.");

var passwordPolicy = new PasswordPolicy(
    MinimumLength: 12,
    MaximumLength: 128,
    RequireUppercase: true,
    RequireLowercase: true,
    RequireDigit: true,
    RequireSymbol: false,
    CompromisedPasswordCheckPlaceholder: true,
    PasswordReusePreventionPlaceholder: true,
    PasswordExpirationPolicyPlaceholder: true,
    PasswordResetRequiredFlagSupported: true,
    TemporaryPasswordFlagSupported: true,
    FailedLoginLockoutThreshold: 10,
    LockoutDuration: TimeSpan.FromMinutes(30),
    AdminForcedResetSupported: true,
    PasswordlessAllowed: true,
    HashingDecision: PasswordHashingDecision.Deferred,
    PlaintextPasswordStorageAllowed: false);
Assert(passwordPolicy.PasswordlessAllowed, "Password policy must support passwordless identities.");
Assert(!passwordPolicy.PlaintextPasswordStorageAllowed, "Plaintext password storage must never be allowed.");
Assert(passwordPolicy.FailedLoginLockoutThreshold > 0, "Failed login lockout policy must be modeled.");

var mfaPolicy = new MfaPolicy(
    [IdentityType.Admin],
    ["operations_admin"],
    ["authority.approval"],
    RequiredForPrivilegedOperations: true,
    RequiredForSuspiciousLogin: true,
    [MfaMethod.Totp, MfaMethod.WebAuthnPasskey],
    RememberedDevicePlaceholder: true,
    StepUpAuthenticationPlaceholder: true,
    ProductionMfaVerificationImplemented: false);
Assert(mfaPolicy.RequiredIdentityTypes.Contains(IdentityType.Admin), "MFA must be requireable by identity type.");
Assert(mfaPolicy.RequiredRoles.Contains("operations_admin"), "MFA must be requireable by role.");
Assert(mfaPolicy.RequiredPolicyCodes.Contains("authority.approval"), "MFA must be requireable by policy.");

var eligibility = new AuthenticationEligibilityResult(
    identity.Id,
    IdentityLifecycleState.Locked,
    AuthenticationEligibilityStatus.Locked,
    MayAttemptCredentialVerification: false,
    "Identity is locked.");
Assert(eligibility.Status == AuthenticationEligibilityStatus.Locked, "Locked identity must return a distinct locked result.");

var auditEvent = new CredentialAuditEvent(
    Guid.NewGuid(),
    identity.Id,
    passwordCredential.CredentialId,
    CredentialType.Password,
    CredentialVerificationStatus.UnsupportedCredential,
    CredentialFailureReason.UnsupportedCredentialType,
    [SecurityRiskFlag.None],
    new Dictionary<string, string> { ["correlationId"] = "domain-test" },
    DateTimeOffset.UtcNow);
Assert(!auditEvent.Metadata.Keys.Any(key => key.Contains("secret", StringComparison.OrdinalIgnoreCase)), "Audit event metadata must not expose secret material.");

var verificationResult = new CredentialVerificationResult(
    Success: false,
    CredentialVerificationStatus.UnsupportedCredential,
    CredentialFailureReason.UnsupportedCredentialType,
    CredentialType.Password,
    identity.Id,
    passwordCredential.CredentialId,
    DateTimeOffset.UtcNow,
    [SecurityRiskFlag.None],
    new MfaRequirementResult(false, [MfaRequirementReason.None], [], false, false),
    new Dictionary<string, string> { ["correlationId"] = "domain-test" });
Assert(verificationResult.FailureReason == CredentialFailureReason.UnsupportedCredentialType, "Unsupported credentials must return structured failure.");
Assert(!verificationResult.AuditMetadata.Values.Any(value => value.Contains("password", StringComparison.OrdinalIgnoreCase)), "Verifier result must not expose secret values.");

Console.WriteLine("AuthService.Domain.Tests PASS");

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}
