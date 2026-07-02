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

var sessionModel = service.GetSessionModel();
Assert(!sessionModel.RuntimeEnabled, "Session runtime must remain disabled.");
Assert(sessionModel.SessionTypes.Contains("Interactive"), "Interactive sessions must be modeled.");
Assert(sessionModel.SessionTypes.Contains("ServiceAccount"), "Service account sessions must be modeled.");
Assert(sessionModel.Policy.MaxConcurrentSessions > 0, "Max concurrent session policy must be modeled.");
Assert(sessionModel.Policy.IdleTimeout < sessionModel.Policy.AbsoluteLifetime, "Idle and absolute session timeouts must be modeled.");
Assert(sessionModel.Policy.MfaRequired, "MFA session requirement must be modeled.");

var tokenIssuance = service.GetTokenIssuanceModel();
Assert(!tokenIssuance.RuntimeEnabled, "Token issuance runtime must remain disabled.");
Assert(tokenIssuance.AccessTokenTypes.Contains("Jwt"), "JWT access token type must be modeled.");
Assert(tokenIssuance.AccessTokenTypes.Contains("OpaqueReference"), "Opaque access token type must be modeled.");
Assert(tokenIssuance.RefreshTokenRotationModeled, "Refresh token rotation must be modeled.");
Assert(tokenIssuance.TokenRevocationModeled, "Token revocation must be modeled.");
Assert(tokenIssuance.TokenIntrospectionModeled, "Token introspection must be modeled.");
Assert(tokenIssuance.StandardClaims.Contains("identity_id"), "identity_id claim must be modeled.");
Assert(tokenIssuance.StandardClaims.Contains("memberships"), "membership claims must be modeled.");

var oauthRuntime = service.GetOAuthRuntimeModel();
Assert(!oauthRuntime.RuntimeEndpointsEnabled, "OAuth runtime endpoints must remain disabled.");
Assert(oauthRuntime.GrantTypes.Contains("AuthorizationCode"), "Authorization code grant must be modeled.");
Assert(oauthRuntime.GrantTypes.Contains("ClientCredentials"), "Client credentials grant must be modeled.");
Assert(oauthRuntime.GrantTypes.Contains("RefreshToken"), "Refresh token grant must be modeled.");
Assert(oauthRuntime.ClientTypes.Contains("Confidential"), "Confidential clients must be modeled.");
Assert(oauthRuntime.ClientTypes.Contains("Service"), "Service clients must be modeled.");
Assert(oauthRuntime.RedirectUrisModeled, "Redirect URI model must exist.");
Assert(oauthRuntime.ConsentModeled, "Consent grant must be modeled.");
Assert(oauthRuntime.ClientSecretRotationModeled, "Client secret rotation must be modeled.");

var jwks = service.GetJwksModel();
Assert(jwks.JwksModeled, "JWKS must be modeled.");
Assert(!jwks.PublicationEnabled, "JWKS publication must remain disabled.");
Assert(!jwks.SigningKeyGenerationEnabled, "Signing key generation must remain disabled.");

var serviceAuth = service.GetServiceAuthModel();
Assert(!serviceAuth.RuntimeEnabled, "Service auth runtime must remain disabled.");
Assert(serviceAuth.ClientCredentialsModeled, "Client credentials model must exist.");
Assert(serviceAuth.ScopesRequired, "Service scopes must be required.");
Assert(serviceAuth.AuditRequired, "Service auth audit must be required.");
Assert(serviceAuth.OptionalMtlsBindingPlaceholder, "Optional mTLS binding placeholder must be modeled.");

Assert(service.GetSessionReadiness().Status == AuthService.Domain.Models.AuthRuntimeGateStatus.Blocked, "Session activation gate must be blocked.");
Assert(service.GetTokenReadiness().Status == AuthService.Domain.Models.AuthRuntimeGateStatus.Blocked, "Token activation gate must be blocked.");
Assert(service.GetOAuthReadiness().Status == AuthService.Domain.Models.AuthRuntimeGateStatus.Blocked, "OAuth activation gate must be blocked.");
Assert(service.GetTokenReadiness().Blockers.Any(blocker => blocker.Code == "SIGNING_KEYS_NOT_ACTIVE"), "Signing key blocker must be present.");
Assert(service.GetTokenReadiness().Blockers.Any(blocker => blocker.Code == "CURRENT_PLATFORM_MIGRATION_NOT_APPROVED"), "Current platform migration blocker must be present.");

var migrationPlan = service.GetMigrationPlan();
Assert(migrationPlan.Phases.Count == 8, "Migration phases must be documented.");
Assert(migrationPlan.Phases.Any(phase => phase.Name.Contains("Shadow validation", StringComparison.Ordinal)), "Shadow validation phase must exist.");
Assert(migrationPlan.Phases.Any(phase => phase.Name.Contains("Legacy retirement", StringComparison.Ordinal)), "Legacy retirement phase must exist.");
Assert(migrationPlan.Phases.All(phase => phase.RollbackCriteria.Count > 0), "Every migration phase must include rollback criteria.");
Assert(migrationPlan.IdentityMappings.Count >= 6, "Identity mapping must be complete.");
Assert(migrationPlan.IdentityMappings.All(mapping => mapping.DuplicatePreventionRequired), "Identity mapping must prevent duplicates.");
Assert(migrationPlan.IdentityMappings.All(mapping => mapping.AuditHistoryPreserved), "Identity mapping must preserve audit history.");
Assert(migrationPlan.CredentialMappings.Any(mapping => mapping.CredentialSource == "password hashes" && mapping.TransparentUpgradeSupported), "Password hash transparent upgrade must be modeled.");
Assert(migrationPlan.CredentialMappings.Any(mapping => mapping.CredentialSource == "service accounts"), "Service account credential migration must be modeled.");
Assert(migrationPlan.SessionMigration.ParallelValidationModeled, "Session coexistence must be modeled.");
Assert(migrationPlan.TokenMigration.LegacyTokensValidDuringCoexistence, "Legacy token coexistence must be modeled.");
Assert(migrationPlan.OAuthMigration.OidcModeled, "OIDC migration must be modeled.");
Assert(migrationPlan.CompatibilityLayer.MigrationBridge, "Compatibility migration bridge must be modeled.");
Assert(!migrationPlan.MigrationExecutionEnabled, "Migration execution must remain disabled.");
Assert(migrationPlan.LegacyAuthUnchanged, "Legacy auth must remain unchanged.");

var coexistence = service.GetCoexistenceStatus();
Assert(coexistence.ExistingPlatformAuthAuthoritative, "Existing auth must remain authoritative.");
Assert(!coexistence.AuthServiceRuntimeTrafficEnabled, "Auth Service runtime traffic must remain disabled.");
Assert(coexistence.RollbackAvailable, "Rollback strategy must exist.");
Assert(coexistence.Blockers.Count > 0, "Coexistence status must expose blockers.");

var compatibility = service.GetCompatibilityModel();
Assert(compatibility.LegacySessionValidator, "Legacy session validator must be modeled.");
Assert(compatibility.LegacyTokenValidator, "Legacy token validator must be modeled.");
Assert(compatibility.LegacyUserLookup, "Legacy user lookup must be modeled.");
Assert(compatibility.FeatureFlags, "Feature flags must be modeled.");
Assert(compatibility.CompatibilityDiagnostics, "Compatibility diagnostics must be modeled.");
Assert(!compatibility.RuntimeImplemented, "Compatibility runtime must remain unimplemented.");

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
