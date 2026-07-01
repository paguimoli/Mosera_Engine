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

var verificationModel = service.GetCredentialVerificationModel();
Assert(verificationModel.ProviderBasedVerification, "Credential verification must be provider-based.");
Assert(verificationModel.VerifierContracts.Contains("IPasswordCredentialVerifier"), "Password verifier contract must be present.");
Assert(verificationModel.VerifierContracts.Contains("ITotpCredentialVerifier"), "TOTP verifier contract must be present.");
Assert(verificationModel.VerifierContracts.Contains("IWebAuthnCredentialVerifier"), "WebAuthn verifier contract must be present.");
Assert(verificationModel.ResultStatuses.Contains("UnsupportedCredential"), "Unsupported credentials must have structured status.");
Assert(!verificationModel.SecretValuesExposed, "Verification model must not expose secret values.");
Assert(!verificationModel.SessionCreationAllowed, "Credential verification must not create sessions in Phase 23.3.");
Assert(!verificationModel.TokenIssuanceAllowed, "Credential verification must not issue tokens in Phase 23.3.");

var passwordPolicy = service.GetPasswordPolicy();
Assert(passwordPolicy.MinimumLength >= 12, "Password minimum length policy must exist.");
Assert(passwordPolicy.PasswordlessAllowed, "Passwordless policy must be supported.");
Assert(passwordPolicy.FailedLoginLockoutThreshold > 0, "Failed-login lockout threshold must be modeled.");
Assert(!passwordPolicy.PlaintextPasswordStorageAllowed, "Plaintext password storage must remain disallowed.");

var mfaPolicy = service.GetMfaPolicy();
Assert(mfaPolicy.RequiredIdentityTypes.Contains(AuthService.Domain.Models.IdentityType.Admin), "MFA must be requireable by identity type.");
Assert(mfaPolicy.RequiredRoles.Contains("operations_admin"), "MFA must be requireable by role.");
Assert(mfaPolicy.RequiredPolicyCodes.Contains("authority.approval"), "MFA must be requireable by policy.");
Assert(mfaPolicy.SupportedMethods.Contains(AuthService.Domain.Models.MfaMethod.Totp), "TOTP must be modeled as supported MFA method.");
Assert(mfaPolicy.SupportedMethods.Contains(AuthService.Domain.Models.MfaMethod.WebAuthnPasskey), "WebAuthn/passkey must be modeled as supported MFA method.");
Assert(!mfaPolicy.ProductionMfaVerificationImplemented, "Production MFA verification must remain deferred.");

var eligibility = service.GetAuthenticationEligibility();
Assert(eligibility.ActiveMayProceed, "Active identity must be eligible for credential verification.");
Assert(eligibility.StructuredOutcomes.Any(outcome => outcome.Status == AuthService.Domain.Models.AuthenticationEligibilityStatus.PendingVerification), "Pending identity must return pending verification.");
Assert(eligibility.StructuredOutcomes.Any(outcome => outcome.Status == AuthService.Domain.Models.AuthenticationEligibilityStatus.Locked), "Locked identity must return locked result.");
Assert(eligibility.StructuredOutcomes.Any(outcome => outcome.Status == AuthService.Domain.Models.AuthenticationEligibilityStatus.Suspended), "Suspended identity must be blocked.");
Assert(eligibility.StructuredOutcomes.Any(outcome => outcome.Status == AuthService.Domain.Models.AuthenticationEligibilityStatus.Disabled), "Disabled identity must be blocked.");
Assert(eligibility.StructuredOutcomes.Any(outcome => outcome.Status == AuthService.Domain.Models.AuthenticationEligibilityStatus.Archived), "Archived identity must be blocked.");

var verifierCatalog = service.GetCredentialVerifiers();
Assert(verifierCatalog.Verifiers.Any(verifier => verifier.InterfaceName == "IPasswordCredentialVerifier"), "Password verifier must be cataloged.");
Assert(verifierCatalog.Verifiers.Any(verifier => verifier.InterfaceName == "ICertificateCredentialVerifier"), "Certificate verifier must be cataloged.");
Assert(verifierCatalog.DefaultUnsupportedResult == AuthService.Domain.Models.CredentialVerificationStatus.UnsupportedCredential, "Unsupported verifier result must be structured.");
Assert(!verifierCatalog.ProductionVerificationImplemented, "Production verification must remain deferred.");
Assert(!verifierCatalog.SecretValuesExposed, "Verifier catalog must not expose secret values.");

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
