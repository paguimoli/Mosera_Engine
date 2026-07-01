namespace AuthService.Domain.Models;

public enum OAuthClientType
{
    Confidential,
    Public,
    FirstParty,
    ThirdParty,
    Service
}

public enum OAuthGrantType
{
    AuthorizationCode,
    ClientCredentials,
    RefreshToken,
    DeviceCode,
    TokenExchange
}

public sealed record OAuthScope(
    string Value,
    string Description,
    bool RequiresConsent);

public sealed record OAuthRedirectUri(
    Uri Uri,
    bool ExactMatchRequired,
    bool LoopbackAllowed);

public sealed record OAuthClientSecretMetadata(
    Guid SecretId,
    string SecretMaterialRef,
    int Version,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ExpiresAt,
    DateTimeOffset? RotatedAt);

public sealed record OAuthConsentGrant(
    Guid GrantId,
    Guid IdentityId,
    string ClientId,
    IReadOnlyCollection<OAuthScope> Scopes,
    DateTimeOffset GrantedAt,
    DateTimeOffset? ExpiresAt,
    bool Revoked);

public sealed record OAuthAuthorizationRequest(
    string ClientId,
    OAuthRedirectUri RedirectUri,
    IReadOnlyCollection<OAuthScope> Scopes,
    string ResponseType,
    string State,
    string? CodeChallenge,
    bool PlaceholderOnly);

public sealed record OAuthAuthorizationCode(
    string CodeHash,
    string ClientId,
    Guid IdentityId,
    OAuthRedirectUri RedirectUri,
    DateTimeOffset ExpiresAt,
    bool Consumed);

public sealed record OAuthTokenRequest(
    string ClientId,
    OAuthGrantType GrantType,
    IReadOnlyCollection<OAuthScope> Scopes,
    string CorrelationId,
    bool PlaceholderOnly);

public sealed record OidcIdentityTokenMetadata(
    Guid TokenId,
    Guid IdentityId,
    string Issuer,
    string Audience,
    string Nonce,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

public sealed record JwksKey(
    string KeyId,
    string KeyType,
    string Algorithm,
    string Use,
    IReadOnlyDictionary<string, string> PublicParameters);

public sealed record JwksDocument(
    string Issuer,
    Uri JwksUri,
    IReadOnlyCollection<JwksKey> Keys,
    DateTimeOffset GeneratedAt);

public sealed record OidcProviderMetadata(
    string Issuer,
    Uri AuthorizationEndpoint,
    Uri TokenEndpoint,
    Uri JwksUri,
    Uri UserInfoEndpoint,
    IReadOnlyCollection<string> ResponseTypesSupported,
    IReadOnlyCollection<OAuthGrantType> GrantTypesSupported,
    IReadOnlyCollection<string> SubjectTypesSupported,
    IReadOnlyCollection<string> IdTokenSigningAlgValuesSupported,
    bool RuntimeEndpointsEnabled);

public sealed record OAuthClientRegistration(
    string ClientId,
    OAuthClientType ClientType,
    IReadOnlyCollection<OAuthGrantType> AllowedGrantTypes,
    IReadOnlyCollection<OAuthRedirectUri> RedirectUris,
    IReadOnlyCollection<OAuthScope> AllowedScopes,
    bool ClientSecretRotationModeled,
    bool MtlsBoundPlaceholder);
