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

public interface ITokenRepository
{
    Task<AccessTokenMetadata?> FindAccessTokenMetadata(Guid tokenId, CancellationToken cancellationToken = default);
    Task<OpaqueTokenReference?> FindOpaqueReference(string referenceHash, CancellationToken cancellationToken = default);
}

public interface IRefreshTokenRepository
{
    Task<RefreshTokenMetadata?> FindRefreshToken(Guid refreshTokenId, CancellationToken cancellationToken = default);
}

public interface IOAuthClientRepository
{
    Task<OAuthClient?> FindByClientId(string clientId, CancellationToken cancellationToken = default);
}

public interface IServiceAccountRepository
{
    Task<ServiceAccount?> FindByServiceName(string serviceName, CancellationToken cancellationToken = default);
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
}
