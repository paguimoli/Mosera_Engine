using AuthService.Domain.Boundaries;
using AuthService.Domain.Models;

namespace AuthService.Application.Contracts;

public interface IIdentityRepository
{
    Task<Identity?> FindById(Guid identityId, CancellationToken cancellationToken = default);
    Task<Identity?> FindByLoginId(LoginId loginId, CancellationToken cancellationToken = default);
}

public interface IIdentityAliasRepository
{
    Task<IReadOnlyCollection<string>> ListAliases(Guid identityId, CancellationToken cancellationToken = default);
}

public interface ICredentialRepository
{
    Task<IReadOnlyCollection<CredentialBoundary>> ListPublicCredentials(Guid identityId, CancellationToken cancellationToken = default);
    Task<CredentialSecretBoundary?> FindSecretBoundary(Guid credentialId, CancellationToken cancellationToken = default);
}

public interface ILifecycleRepository
{
    Task<IReadOnlyCollection<AuditEvent>> ListLifecycleEvidence(Guid identityId, CancellationToken cancellationToken = default);
}

public interface IRoleRepository
{
    Task<IReadOnlyCollection<Role>> ListRoles(Guid identityId, CancellationToken cancellationToken = default);
}

public interface IPermissionRepository
{
    Task<IReadOnlyCollection<string>> ListPermissions(Guid identityId, CancellationToken cancellationToken = default);
}

public interface IClaimRepository
{
    Task<IReadOnlyCollection<Claim>> ListClaims(Guid identityId, CancellationToken cancellationToken = default);
}

public interface IPolicyRepository
{
    Task<Policy?> FindPolicy(string code, CancellationToken cancellationToken = default);
}

public interface IMembershipRepository
{
    Task<IReadOnlyCollection<Membership>> ListMemberships(Guid identityId, CancellationToken cancellationToken = default);
}

public interface ISessionRepository
{
    Task<Session?> FindSession(Guid sessionId, CancellationToken cancellationToken = default);
}

public interface IAuthRuntimeStore
{
    bool RuntimeAvailable { get; }
    Task<Session> SaveSession(Session session, CancellationToken cancellationToken = default);
    Task<Session?> RevokeSession(Guid sessionId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default);
    Task<AuditEvent> AppendAuditEvent(AuditEvent auditEvent, CancellationToken cancellationToken = default);
}

public interface ITokenRepository
{
    Task<AccessTokenMetadata?> FindAccessTokenMetadata(Guid tokenId, CancellationToken cancellationToken = default);
    Task<OpaqueTokenReference?> FindOpaqueReference(string referenceHash, CancellationToken cancellationToken = default);
    Task<AccessTokenMetadata> SaveJwtAccessToken(
        Guid tokenId,
        Guid identityId,
        Guid sessionId,
        string issuer,
        string audience,
        IReadOnlyCollection<string> scopes,
        string jwtId,
        Guid signingKeyId,
        DateTimeOffset issuedAt,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken = default);
}

public interface IRefreshTokenRepository
{
    Task<RefreshTokenMetadata?> FindRefreshToken(Guid refreshTokenId, CancellationToken cancellationToken = default);
    Task<RefreshTokenRuntimeRecord?> FindRefreshTokenByHash(string referenceHash, CancellationToken cancellationToken = default);
    Task<RefreshTokenRuntimeRecord> SaveRefreshToken(
        Guid refreshTokenId,
        Guid identityId,
        Guid sessionId,
        Guid tokenId,
        Guid familyId,
        int rotationCounter,
        Guid? previousRefreshTokenId,
        string referenceHash,
        DateTimeOffset issuedAt,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken = default);
    Task<RefreshTokenRuntimeRecord?> MarkRefreshTokenRotated(Guid refreshTokenId, DateTimeOffset rotatedAt, CancellationToken cancellationToken = default);
    Task<int> RevokeRefreshTokensForSession(Guid sessionId, DateTimeOffset revokedAt, string reason, CancellationToken cancellationToken = default);
    Task<int> RevokeRefreshTokenFamily(Guid familyId, DateTimeOffset revokedAt, string reason, CancellationToken cancellationToken = default);
}

public interface IOAuthClientRepository
{
    Task<OAuthClient?> FindByClientId(string clientId, CancellationToken cancellationToken = default);
}

public interface IServiceAccountRepository
{
    Task<ServiceAccount?> FindByServiceName(string serviceName, CancellationToken cancellationToken = default);
    Task<ServiceCredentialSecretBoundary?> FindServiceCredentialSecret(string serviceName, CancellationToken cancellationToken = default);
}

public interface IApiClientRepository
{
    Task<ApiClient?> FindByClientId(string clientId, CancellationToken cancellationToken = default);
}

public interface ISecurityRelationshipRepository
{
    Task<IReadOnlyCollection<SecurityRelationship>> ListForIdentity(Guid identityId, CancellationToken cancellationToken = default);
}

public interface IAuditEventRepository
{
    Task<IReadOnlyCollection<AuditEvent>> ListByCorrelationId(string correlationId, CancellationToken cancellationToken = default);
}

public interface ISigningKeyRepository
{
    Task<IReadOnlyCollection<SigningKeyMetadata>> ListSigningKeys(CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<JwksKeyDescriptor>> ListPublicJwks(CancellationToken cancellationToken = default);
    Task<SigningKeyMaterial?> FindActiveSigningKey(CancellationToken cancellationToken = default);
    Task<SigningKeyMaterial> SaveSigningKey(SigningKeyMaterial signingKey, CancellationToken cancellationToken = default);
}

public sealed record SigningKeyMaterial(
    Guid SigningKeyId,
    string KeyId,
    string Algorithm,
    int Version,
    string Status,
    IReadOnlyDictionary<string, string> PublicParameters,
    string PrivateKeyPem,
    DateTimeOffset ActivatesAt,
    DateTimeOffset? ExpiresAt,
    DateTimeOffset? RetiredAt);

public sealed record RefreshTokenRuntimeRecord(
    Guid RefreshTokenId,
    Guid IdentityId,
    Guid SessionId,
    Guid TokenId,
    Guid FamilyId,
    int RotationCounter,
    Guid? PreviousRefreshTokenId,
    string ReferenceHash,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? RotatedAt,
    DateTimeOffset? RevokedAt,
    string? RevokedReason);

public sealed record ServiceCredentialSecretBoundary(
    Guid ServiceAccountId,
    Guid IdentityId,
    Guid OAuthClientId,
    string ServiceName,
    string ClientId,
    IReadOnlyCollection<string> Scopes,
    string SecretHash,
    string HashAlgorithm);
