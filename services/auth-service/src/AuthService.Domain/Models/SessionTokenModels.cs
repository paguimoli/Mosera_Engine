namespace AuthService.Domain.Models;

public enum SessionStatus
{
    PendingMfa,
    Active,
    Expired,
    Revoked,
    Locked,
    Terminated,
    Suspicious
}

public enum SessionType
{
    Interactive,
    ApiClient,
    ServiceAccount,
    MachineToMachine,
    Federated,
    Impersonation,
    BreakGlass
}

public enum AccessTokenType
{
    Jwt,
    OpaqueReference
}

public enum TokenIssuanceStatus
{
    Disabled,
    WouldIssue,
    Blocked,
    PolicyDenied
}

public sealed record SessionDevice(
    string DeviceId,
    string DeviceType,
    bool TrustedPlaceholder,
    DateTimeOffset FirstSeenAt,
    DateTimeOffset LastSeenAt);

public sealed record SessionRiskContext(
    string IpAddress,
    string? Geography,
    bool SuspiciousLogin,
    IReadOnlyCollection<SecurityRiskFlag> RiskFlags);

public sealed record SessionPolicy(
    int MaxConcurrentSessions,
    TimeSpan IdleTimeout,
    TimeSpan AbsoluteLifetime,
    bool MfaRequired,
    bool DeviceTrustPlaceholder,
    bool IpGeographyPlaceholder,
    bool ForcedLogoutSupported,
    bool SessionRevocationSupported,
    bool IdentityLifecycleValidationRequired);

public sealed record AuthSession(
    Guid SessionId,
    Guid IdentityId,
    SessionType Type,
    SessionStatus Status,
    SessionPolicy Policy,
    SessionDevice? Device,
    SessionRiskContext RiskContext,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? RevokedAt);

public sealed record SessionCreationRequest(
    Guid IdentityId,
    SessionType Type,
    string CorrelationId,
    SessionDevice? Device,
    SessionRiskContext RiskContext);

public sealed record SessionCreationResult(
    bool Created,
    SessionStatus Status,
    Guid? SessionId,
    string Reason,
    bool TokenIssued);

public sealed record SessionRevocationRecord(
    Guid SessionId,
    string Reason,
    Guid? ActorIdentityId,
    DateTimeOffset RevokedAt);

public sealed record TokenAudience(
    string Value,
    bool ServiceAudience,
    bool PlayerAudience);

public sealed record TokenScope(
    string Value,
    string Description,
    bool Required);

public sealed record TokenClaim(
    string Type,
    string Value,
    string ValueType,
    string Issuer);

public sealed record AccessToken(
    Guid TokenId,
    AccessTokenType Type,
    TokenAudience Audience,
    IReadOnlyCollection<TokenScope> Scopes,
    IReadOnlyCollection<TokenClaim> Claims,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

public sealed record JwtAccessTokenMetadata(
    Guid TokenId,
    string JwtId,
    string Issuer,
    string Subject,
    string SigningKeyId,
    string Algorithm,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

public sealed record OpaqueAccessTokenMetadata(
    Guid TokenId,
    string ReferenceHash,
    bool IntrospectionRequired,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

public sealed record RefreshTokenRotationPolicy(
    bool Enabled,
    bool ReuseDetectionEnabled,
    TimeSpan AbsoluteLifetime,
    TimeSpan IdleLifetime);

public sealed record RefreshToken(
    Guid RefreshTokenId,
    Guid FamilyId,
    Guid SessionId,
    int RotationCounter,
    Guid? PreviousRefreshTokenId,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? RevokedAt);

public sealed record TokenIssuanceRequest(
    Guid IdentityId,
    Guid SessionId,
    AccessTokenType AccessTokenType,
    TokenAudience Audience,
    IReadOnlyCollection<TokenScope> Scopes,
    bool IncludeRefreshToken,
    string CorrelationId);

public sealed record TokenIssuanceResult(
    TokenIssuanceStatus Status,
    Guid? AccessTokenId,
    Guid? RefreshTokenId,
    string Reason,
    bool SignedTokenGenerated);

public sealed record TokenRevocationRecord(
    Guid TokenId,
    string TokenType,
    string Reason,
    Guid? ActorIdentityId,
    DateTimeOffset RevokedAt);

public sealed record TokenIntrospectionResult(
    bool Active,
    AccessTokenType TokenType,
    Guid? IdentityId,
    Guid? SessionId,
    IReadOnlyCollection<TokenScope> Scopes,
    DateTimeOffset? ExpiresAt);

public sealed record TokenExchangeRequest(
    string SubjectTokenType,
    string RequestedTokenType,
    TokenAudience Audience,
    IReadOnlyCollection<TokenScope> Scopes,
    bool PlaceholderOnly);
