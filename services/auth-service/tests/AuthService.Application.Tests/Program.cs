using AuthService.Application;

var service = new AuthArchitectureService();
var status = service.GetStatus();
Assert(!status.ProductionAuthenticationEnabled, "Phase 23.1 must not enable production authentication.");
Assert(!status.ProductionTokenIssuanceEnabled, "Phase 23.1 must not issue tokens.");
Assert(!status.ExistingPlatformAuthBehaviorChanged, "Existing platform auth behavior must remain unchanged.");

var identityModel = service.GetIdentityModel();
Assert(identityModel.LoginIdImmutable, "Login ID must be immutable.");
Assert(identityModel.PasswordsOptional, "Passwords must be optional.");
Assert(identityModel.MultipleCredentialsPerIdentity, "Multiple credentials per identity must be supported.");
Assert(identityModel.IdentityTypes.Contains("Player"), "Players must be represented in the global identity store.");
Assert(identityModel.IdentityTypes.Contains("ApiClient"), "API clients must be represented in the global identity store.");

var oauthModel = service.GetOAuthModel();
Assert(oauthModel.ProviderMode.Contains("OPENID_CONNECT", StringComparison.Ordinal), "Auth Service must be an OIDC provider.");
Assert(oauthModel.TokenTypes.Contains("JwtAccessToken"), "JWT access tokens must be modeled.");
Assert(oauthModel.TokenTypes.Contains("OpaqueReferenceToken"), "Opaque reference tokens must be modeled.");
Assert(!oauthModel.TokenIssuanceEnabled, "Token issuance must remain disabled in Phase 23.1.");

var policyModel = service.GetPolicyModel();
Assert(policyModel.AuthorizationModes.Contains("RBAC"), "RBAC must be modeled.");
Assert(policyModel.AuthorizationModes.Contains("CLAIMS"), "Claims must be modeled.");
Assert(policyModel.AuthorizationModes.Contains("POLICIES"), "Policies must be modeled.");
Assert(policyModel.SecurityRelationshipsOnly, "Auth Service must own security relationships only.");
Assert(!policyModel.ProductionPolicyEvaluationEnabled, "Production policy evaluation must remain disabled.");

Console.WriteLine("AuthService.Application.Tests PASS");

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}
