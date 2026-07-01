namespace AuthService.Domain.Models;

public enum IdentityType
{
    Admin,
    Player,
    Agent,
    Operator,
    ApiClient,
    ServiceAccount,
    PamUser
}

public enum CredentialType
{
    Password,
    Passkey,
    Totp,
    RecoveryCode,
    OAuthFederation,
    PamFederation,
    ApiKey,
    ApiSecret,
    ClientSecret,
    ClientCertificate,
    Certificate,
    SsoAssertion
}

public enum IdentityLifecycleState
{
    Created,
    PendingActivation,
    Active,
    Suspended,
    Locked,
    Disabled,
    Archived,
    Deleted
}

public enum SessionState
{
    Created,
    Active,
    Expired,
    Revoked
}

public enum TokenType
{
    JwtAccessToken,
    OpaqueReferenceToken,
    RefreshToken,
    IdToken,
    ClientAssertion
}

public enum SecurityRelationshipType
{
    TenantMembership,
    BrandMembership,
    MarketMembership,
    OperatorMembership,
    Delegation,
    ServiceTrust,
    PamAssociation
}

public enum AuditEventCategory
{
    Identity,
    Credential,
    Authorization,
    Session,
    Token,
    OAuthClient,
    ServiceTrust
}

public sealed record LoginId
{
    public LoginId(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("Login ID is required.", nameof(value));
        }

        Value = value.Trim();
    }

    public string Value { get; }
}

public sealed record Identity(
    Guid Id,
    LoginId LoginId,
    IdentityType Type,
    IdentityLifecycleState LifecycleState,
    IReadOnlyCollection<Credential> Credentials,
    IReadOnlyCollection<Role> Roles,
    IReadOnlyCollection<Claim> Claims,
    IReadOnlyCollection<Membership> Memberships,
    DateTimeOffset CreatedAt);

public sealed record Credential(
    Guid Id,
    Guid IdentityId,
    CredentialType Type,
    string PublicReference,
    bool PasswordOptional,
    bool Active,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ExpiresAt);

public sealed record Role(
    string Code,
    string DisplayName,
    IReadOnlyCollection<string> Permissions,
    bool SystemRole);

public sealed record Claim(
    string Type,
    string Value,
    string Issuer,
    DateTimeOffset IssuedAt,
    DateTimeOffset? ExpiresAt);

public sealed record Policy(
    string Code,
    string DisplayName,
    string Expression,
    IReadOnlyCollection<string> RequiredClaims,
    IReadOnlyCollection<string> RequiredRoles,
    bool EnforcedLocallyByServices);

public sealed record Membership(
    Guid Id,
    Guid IdentityId,
    string ScopeType,
    string ScopeId,
    IReadOnlyCollection<Role> Roles,
    IReadOnlyCollection<Claim> Claims,
    DateTimeOffset EffectiveFrom,
    DateTimeOffset? EffectiveTo);

public sealed record Session(
    Guid Id,
    Guid IdentityId,
    SessionState State,
    string PolicyCode,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? RevokedAt);

public sealed record Token(
    Guid Id,
    Guid IdentityId,
    TokenType Type,
    string Audience,
    string Issuer,
    IReadOnlyCollection<string> Scopes,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt,
    bool ReferenceToken);

public sealed record OAuthClient(
    Guid Id,
    string ClientId,
    string DisplayName,
    IReadOnlyCollection<string> AllowedGrantTypes,
    IReadOnlyCollection<string> RedirectUris,
    IReadOnlyCollection<string> Scopes,
    bool RequiresPkce,
    bool MtlsBound);

public sealed record ServiceAccount(
    Guid Id,
    Guid IdentityId,
    string ServiceName,
    OAuthClient OAuthClient,
    bool MtlsOptional);

public sealed record ApiClient(
    Guid Id,
    Guid IdentityId,
    OAuthClient OAuthClient,
    string OwnerScope,
    bool Active);

public sealed record SecurityRelationship(
    Guid Id,
    SecurityRelationshipType Type,
    Guid SubjectIdentityId,
    string ResourceType,
    string ResourceId,
    IReadOnlyCollection<Policy> Policies,
    DateTimeOffset CreatedAt);

public sealed record AuditEvent(
    Guid Id,
    AuditEventCategory Category,
    Guid? ActorIdentityId,
    Guid? SubjectIdentityId,
    string Action,
    string CorrelationId,
    IReadOnlyDictionary<string, string> Metadata,
    DateTimeOffset CreatedAt);
