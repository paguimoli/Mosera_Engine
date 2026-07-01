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

var persistence = service.GetPersistenceModel();
Assert(persistence.RequiredTables.Contains("auth_service.identities"), "Identity table must be documented.");
Assert(persistence.RequiredTables.Contains("auth_service.identity_credentials"), "Credential table must be documented.");
Assert(persistence.LoginIdUnique, "login_id uniqueness must be modeled.");
Assert(persistence.LoginIdImmutable, "login_id immutability must be modeled.");
Assert(!persistence.HardDeletesAllowed, "Hard deletes must be disallowed.");
Assert(persistence.CredentialStorageSeparated, "Credentials must be separated from identities.");
Assert(persistence.BusinessHierarchyExcluded, "Business hierarchy must be excluded.");

var credentialModel = service.GetCredentialModel();
Assert(credentialModel.CredentialModels.Contains("PasswordCredential"), "Password credentials must be modeled.");
Assert(credentialModel.CredentialModels.Contains("CertificateCredential"), "Certificate credentials must be modeled.");
Assert(!credentialModel.SecretMaterialReturnedByNormalQueries, "Credential secrets must not be exposed.");
Assert(!credentialModel.VerificationImplemented, "Credential verification must remain disabled.");

var tokenModel = service.GetTokenModel();
Assert(tokenModel.JwtSupportedByModel, "JWT tokens must be modeled.");
Assert(tokenModel.OpaqueReferenceSupportedByModel, "Opaque reference tokens must be modeled.");
Assert(tokenModel.RefreshTokenRotationModeled, "Refresh token rotation metadata must exist.");
Assert(tokenModel.SigningKeyRotationModeled, "Signing key rotation metadata must exist.");
Assert(!tokenModel.TokenIssuanceImplemented, "Token issuance must remain disabled.");

var migration = service.GetMigrationReadiness();
Assert(migration.Status == AuthService.Domain.Models.AuthMigrationGateStatus.Blocked, "Migration gate must be blocked by default.");
Assert(migration.Blockers.Any(blocker => blocker.Code == "SCHEMA_NOT_APPLIED"), "Schema blocker must be present.");
Assert(migration.Blockers.Any(blocker => blocker.Code == "TOKEN_ISSUANCE_NOT_IMPLEMENTED"), "Token issuance blocker must be present.");

Console.WriteLine("AuthService.Application.Tests PASS");

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}
