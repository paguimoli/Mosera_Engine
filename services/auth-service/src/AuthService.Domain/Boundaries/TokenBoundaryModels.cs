namespace AuthService.Domain.Boundaries;

public sealed record AccessTokenMetadata(
    Guid TokenId,
    Guid? IdentityId,
    string TokenFormat,
    string Issuer,
    string Audience,
    IReadOnlyCollection<string> Scopes,
    string? JwtId,
    Guid? SigningKeyId,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

public sealed record OpaqueTokenReference(
    Guid TokenId,
    string ReferenceHash,
    string TokenType,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt,
    bool Revoked);

public sealed record RefreshTokenMetadata(
    Guid RefreshTokenId,
    Guid FamilyId,
    int RotationCounter,
    Guid? PreviousRefreshTokenId,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? RotatedAt,
    DateTimeOffset? RevokedAt);

public sealed record TokenRevocationMetadata(
    Guid TokenId,
    string TokenType,
    string Reason,
    Guid? ActorIdentityId,
    DateTimeOffset RevokedAt);

public sealed record TokenIntrospectionRecord(
    Guid TokenId,
    string TokenFormat,
    bool Active,
    string Issuer,
    string Audience,
    IReadOnlyCollection<string> Scopes,
    DateTimeOffset ExpiresAt);

public sealed record SigningKeyMetadata(
    Guid SigningKeyId,
    string KeyId,
    string Algorithm,
    int Version,
    string Status,
    DateTimeOffset ActivatesAt,
    DateTimeOffset? ExpiresAt,
    DateTimeOffset? RetiredAt);

public sealed record JwksKeyDescriptor(
    string KeyId,
    string Algorithm,
    string Use,
    IReadOnlyDictionary<string, string> PublicParameters);
