using AuthService.Domain.Models;

namespace AuthService.Application;

public sealed class AuthArchitectureService
{
    public AuthServiceStatus GetStatus()
    {
        return new AuthServiceStatus(
            ServiceName: "auth-service",
            ArchitecturePhase: "23.1",
            ProductionAuthenticationEnabled: false,
            ProductionTokenIssuanceEnabled: false,
            ExistingPlatformAuthBehaviorChanged: false,
            IdentityStoreMode: "GLOBAL_SINGLE_STORE_SPECIFICATION",
            AuthorizationModel: "RBAC_CLAIMS_POLICIES",
            TokenStrategy: "JWT_AND_OPAQUE_REFERENCE_TOKENS",
            ServiceTrustModel: "OAUTH2_CLIENT_CREDENTIALS_OPTIONAL_MTLS",
            GeneratedAt: DateTimeOffset.UtcNow);
    }

    public IdentityModelSummary GetIdentityModel()
    {
        return new IdentityModelSummary(
            IdentityTypes: Enum.GetNames<IdentityType>(),
            CredentialTypes: Enum.GetNames<CredentialType>(),
            LifecycleStates: Enum.GetNames<IdentityLifecycleState>(),
            LoginIdImmutable: true,
            PasswordsOptional: true,
            MultipleCredentialsPerIdentity: true,
            OwnsAllIdentityTypes: true,
            DomainModels:
            [
                nameof(Identity),
                nameof(LoginId),
                nameof(Credential),
                nameof(Role),
                nameof(Claim),
                nameof(Membership),
                nameof(Session),
                nameof(SecurityRelationship),
                nameof(AuditEvent)
            ]);
    }

    public OAuthModelSummary GetOAuthModel()
    {
        return new OAuthModelSummary(
            ProviderMode: "OAUTH2_OPENID_CONNECT_IDP_SPECIFICATION",
            SupportedFutureGrantTypes:
            [
                "authorization_code",
                "client_credentials",
                "refresh_token",
                "device_code"
            ],
            TokenTypes: Enum.GetNames<TokenType>(),
            ServiceTrust: "client_credentials_with_optional_mtls",
            TokenIssuanceEnabled: false,
            PasswordGrantEnabled: false,
            Models: [nameof(Token), nameof(OAuthClient), nameof(ServiceAccount), nameof(ApiClient)]);
    }

    public PolicyModelSummary GetPolicyModel()
    {
        return new PolicyModelSummary(
            PolicyAuthority: "AUTH_SERVICE",
            EnforcementModel: "SERVICES_ENFORCE_LOCALLY",
            AuthorizationModes: ["RBAC", "CLAIMS", "POLICIES"],
            MembershipScopes: ["tenant", "brand", "market", "operator"],
            SessionPolicyBased: true,
            SecurityRelationshipsOnly: true,
            ProductionPolicyEvaluationEnabled: false);
    }
}

public sealed record AuthServiceStatus(
    string ServiceName,
    string ArchitecturePhase,
    bool ProductionAuthenticationEnabled,
    bool ProductionTokenIssuanceEnabled,
    bool ExistingPlatformAuthBehaviorChanged,
    string IdentityStoreMode,
    string AuthorizationModel,
    string TokenStrategy,
    string ServiceTrustModel,
    DateTimeOffset GeneratedAt);

public sealed record IdentityModelSummary(
    IReadOnlyCollection<string> IdentityTypes,
    IReadOnlyCollection<string> CredentialTypes,
    IReadOnlyCollection<string> LifecycleStates,
    bool LoginIdImmutable,
    bool PasswordsOptional,
    bool MultipleCredentialsPerIdentity,
    bool OwnsAllIdentityTypes,
    IReadOnlyCollection<string> DomainModels);

public sealed record OAuthModelSummary(
    string ProviderMode,
    IReadOnlyCollection<string> SupportedFutureGrantTypes,
    IReadOnlyCollection<string> TokenTypes,
    string ServiceTrust,
    bool TokenIssuanceEnabled,
    bool PasswordGrantEnabled,
    IReadOnlyCollection<string> Models);

public sealed record PolicyModelSummary(
    string PolicyAuthority,
    string EnforcementModel,
    IReadOnlyCollection<string> AuthorizationModes,
    IReadOnlyCollection<string> MembershipScopes,
    bool SessionPolicyBased,
    bool SecurityRelationshipsOnly,
    bool ProductionPolicyEvaluationEnabled);
