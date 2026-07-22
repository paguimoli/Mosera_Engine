namespace AuthService.Domain.Models;

public enum AuthenticationAuthorityMode
{
    Monolith,
    ServiceShadow,
    ServiceDryRun,
    Service
}

public enum CanonicalIdentityStatus
{
    Active,
    Disabled,
    Locked,
    Compromised,
    Emergency,
    Deleted
}

public sealed record CanonicalIdentity(
    Guid IdentityId,
    Guid TenantId,
    Guid? BrandId,
    string Username,
    string NormalizedUsername,
    string? Email,
    string? NormalizedEmail,
    string AccountType,
    CanonicalIdentityStatus Status,
    string CredentialStatus,
    string MfaStatus,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt,
    DateTimeOffset? ReviewDueAt);

public sealed record PasswordCredentialVersion(
    Guid CredentialVersionId,
    Guid IdentityId,
    int Version,
    string PasswordHash,
    string Algorithm,
    int MemoryCostKiB,
    int Iterations,
    int Parallelism,
    bool Compromised,
    DateTimeOffset CreatedAt,
    DateTimeOffset? RotatedAt,
    DateTimeOffset? RetiredAt);

public sealed record CanonicalSession(
    Guid SessionId,
    Guid IdentityId,
    string OpaqueToken,
    string TokenHash,
    DateTimeOffset CreatedAt,
    DateTimeOffset IdleExpiresAt,
    DateTimeOffset AbsoluteExpiresAt,
    DateTimeOffset? RevokedAt,
    string? IpAddress,
    string? UserAgent,
    string? DeviceMetadata);

public sealed record AuthenticationAuditEvidence(
    Guid EvidenceId,
    Guid TenantId,
    Guid? BrandId,
    Guid? ActorIdentityId,
    Guid? SubjectIdentityId,
    string Action,
    string Result,
    string Reason,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    string? IpAddress,
    string? UserAgent,
    string Authority);

public sealed record AuthenticationAuthorityReadiness(
    AuthenticationAuthorityMode AuthorityMode,
    bool IdentityInvariantsReady,
    bool Argon2idConfigured,
    bool CredentialHistoryReady,
    bool SessionAuthorityReady,
    bool LegacyMutationsRemoved,
    bool ImmutableAuditReady,
    bool DatabaseReachable,
    bool ProductionPromotionAllowed,
    IReadOnlyCollection<string> Blockers);
