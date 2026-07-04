using AuthService.Application;
using AuthService.Application.Services;
using AuthService.Application.Contracts;
using AuthService.Domain.Boundaries;
using AuthService.Domain.Models;
using AuthService.Infrastructure;
using System.Security.Cryptography;

var service = new AuthArchitectureService();
var status = service.GetStatus();
Assert(status.ProductionAuthenticationEnabled, "Auth Service login runtime must be enabled.");
Assert(status.ProductionTokenIssuanceEnabled, "P0-001.5 must issue JWT access tokens.");
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
Assert(credentialModel.VerificationImplemented, "Password credential verification must be implemented.");

var tokenModel = service.GetTokenModel();
Assert(tokenModel.JwtSupportedByModel, "JWT tokens must be modeled.");
Assert(tokenModel.OpaqueReferenceSupportedByModel, "Opaque reference tokens must be modeled.");
Assert(tokenModel.RefreshTokenRotationModeled, "Refresh token rotation metadata must exist.");
Assert(tokenModel.SigningKeyRotationModeled, "Signing key rotation metadata must exist.");
Assert(tokenModel.TokenIssuanceImplemented, "Token issuance must be implemented.");

var verificationModel = service.GetCredentialVerificationModel();
Assert(verificationModel.ProviderBasedVerification, "Credential verification must be provider-based.");
Assert(verificationModel.VerifierContracts.Contains("IPasswordCredentialVerifier"), "Password verifier contract must be present.");
Assert(verificationModel.VerifierContracts.Contains("ITotpCredentialVerifier"), "TOTP verifier contract must be present.");
Assert(verificationModel.VerifierContracts.Contains("IWebAuthnCredentialVerifier"), "WebAuthn verifier contract must be present.");
Assert(verificationModel.ResultStatuses.Contains("UnsupportedCredential"), "Unsupported credentials must have structured status.");
Assert(!verificationModel.SecretValuesExposed, "Verification model must not expose secret values.");
Assert(verificationModel.SessionCreationAllowed, "Credential verification must create Auth Service sessions in P0-001.2.");
Assert(verificationModel.TokenIssuanceAllowed, "Credential verification may issue JWT access tokens in P0-001.5.");

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
Assert(verifierCatalog.ProductionVerificationImplemented, "Password production verification must be active.");
Assert(!verifierCatalog.SecretValuesExposed, "Verifier catalog must not expose secret values.");

var sessionModel = service.GetSessionModel();
Assert(sessionModel.RuntimeEnabled, "Session runtime must be active.");
Assert(sessionModel.SessionTypes.Contains("Interactive"), "Interactive sessions must be modeled.");
Assert(sessionModel.SessionTypes.Contains("ServiceAccount"), "Service account sessions must be modeled.");
Assert(sessionModel.Policy.MaxConcurrentSessions > 0, "Max concurrent session policy must be modeled.");
Assert(sessionModel.Policy.IdleTimeout < sessionModel.Policy.AbsoluteLifetime, "Idle and absolute session timeouts must be modeled.");
Assert(sessionModel.Policy.MfaRequired, "MFA session requirement must be modeled.");

var tokenIssuance = service.GetTokenIssuanceModel();
Assert(tokenIssuance.RuntimeEnabled, "Token issuance runtime must be enabled.");
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
Assert(jwks.PublicationEnabled, "JWKS publication must be enabled.");
Assert(jwks.SigningKeyGenerationEnabled, "Signing key generation must be enabled.");

var serviceAuth = service.GetServiceAuthModel();
Assert(serviceAuth.RuntimeEnabled, "Service auth runtime foundation must be enabled.");
Assert(serviceAuth.ClientCredentialsModeled, "Client credentials model must exist.");
Assert(serviceAuth.ScopesRequired, "Service scopes must be required.");
Assert(serviceAuth.AuditRequired, "Service auth audit must be required.");
Assert(serviceAuth.OptionalMtlsBindingPlaceholder, "Optional mTLS binding placeholder must be modeled.");

Assert(service.GetSessionReadiness().Status == AuthService.Domain.Models.AuthRuntimeGateStatus.Ready, "Session activation gate must be ready.");
Assert(service.GetTokenReadiness().Status == AuthService.Domain.Models.AuthRuntimeGateStatus.Ready, "Token activation gate must be ready.");
Assert(service.GetOAuthReadiness().Status == AuthService.Domain.Models.AuthRuntimeGateStatus.Blocked, "OAuth activation gate must be blocked.");

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

var shadowSource = new TestLegacyPlatformIdentitySource();
var identityMapping = new IdentityMappingService();
var shadowValidation = new ShadowValidationService();
var shadowImport = new ShadowIdentityImportService(shadowSource, identityMapping, shadowValidation);
var migrationReadiness = new MigrationReadinessService(shadowImport);
var snapshot = await shadowSource.ReadSnapshotAsync();
var mappedIdentities = identityMapping.MapAll(snapshot).ToArray();

Assert(mappedIdentities.Length == snapshot.Identities.Count, "Every platform identity must map to a shadow identity.");
Assert(mappedIdentities.Select(mapping => mapping.IdentityId).Distinct().Count() == mappedIdentities.Length, "Identity IDs must be deterministic and unique for source identities.");
var adminSource = snapshot.Identities.Single(identity => identity.SourceId == "admin-1");
var firstAdminMapping = identityMapping.Map(adminSource);
var secondAdminMapping = identityMapping.Map(adminSource);
Assert(firstAdminMapping.IdentityId == secondAdminMapping.IdentityId && firstAdminMapping.LoginId == secondAdminMapping.LoginId, "Identity mapping must be deterministic.");
Assert(mappedIdentities.Any(mapping => mapping.IdentityType == AuthService.Domain.Models.IdentityType.Admin), "Admin identities must map.");
Assert(mappedIdentities.Any(mapping => mapping.IdentityType == AuthService.Domain.Models.IdentityType.Player), "Player identities must map.");
Assert(mappedIdentities.Any(mapping => mapping.IdentityType == AuthService.Domain.Models.IdentityType.Agent), "Agent identities must map.");
Assert(mappedIdentities.Any(mapping => mapping.IdentityType == AuthService.Domain.Models.IdentityType.ApiClient), "API clients must map.");
Assert(mappedIdentities.Any(mapping => mapping.IdentityType == AuthService.Domain.Models.IdentityType.ServiceAccount), "Service accounts must map.");
Assert(mappedIdentities.Any(mapping => mapping.Roles.Contains("SUPER_ADMIN")), "Role mapping must preserve platform groups.");
Assert(mappedIdentities.Any(mapping => mapping.Claims.Any(claim => claim.Type == "PERMISSION" && claim.Value == "system.admin")), "Claim mapping must preserve permissions.");
Assert(mappedIdentities.Any(mapping => mapping.Memberships.Any(membership => membership.ScopeType == "ACCOUNT")), "Membership mapping must preserve account scopes.");

var validation = shadowValidation.Validate(snapshot, mappedIdentities);
Assert(validation.Issues.Any(issue => issue.Code == "DUPLICATE_USERNAME"), "Duplicate usernames must be detected.");
Assert(validation.Issues.Any(issue => issue.Code == "DUPLICATE_EMAIL"), "Duplicate emails must be detected.");
Assert(validation.Issues.Any(issue => issue.Code == "DUPLICATE_LOGIN_ID"), "Duplicate login IDs must be detected.");
Assert(validation.Issues.Any(issue => issue.Code == "MISSING_CREDENTIALS"), "Missing credentials must be detected.");
Assert(validation.Issues.Any(issue => issue.Code == "INVALID_ROLE_MAPPING"), "Invalid role mappings must be detected.");
Assert(validation.Issues.Any(issue => issue.Code == "INVALID_MEMBERSHIP"), "Invalid memberships must be detected.");
Assert(validation.Issues.Any(issue => issue.Code == "UNSUPPORTED_CREDENTIAL_TYPE"), "Unsupported credentials must be detected.");
Assert(validation.Issues.Any(issue => issue.Code == "MISSING_LIFECYCLE_STATE"), "Missing lifecycle state must be detected.");
Assert(validation.Issues.Any(issue => issue.Code == "UNKNOWN_ACCOUNT_TYPE"), "Unknown account types must be detected.");

var shadowRun = await shadowImport.RunAsync();
Assert(shadowRun.ImportedIdentities.Count == mappedIdentities.Length, "Shadow import must create in-memory identities.");
Assert(shadowRun.ReadOnly, "Shadow import must be read-only.");
Assert(!shadowRun.Persisted, "Shadow import must not persist identities.");
Assert(!shadowRun.Authenticated, "Shadow import must not authenticate.");
Assert(!shadowRun.SessionsCreated, "Shadow import must not create sessions.");
Assert(!shadowRun.TokensIssued, "Shadow import must not issue tokens.");
Assert(!shadowRun.LegacyAuthChanged, "Shadow import must leave legacy auth unchanged.");
Assert(shadowRun.WriteOperationsAttempted == 0, "Shadow import must not attempt DB writes.");
Assert(shadowSource.ReadCount == 2, "Shadow source must only be read.");
Assert(shadowSource.WriteCount == 0, "Shadow source writes must remain zero.");

var report = await migrationReadiness.BuildReportAsync();
var secondReport = await migrationReadiness.BuildReportAsync();
Assert(report.Summary.IdentitiesDiscovered == mappedIdentities.Length, "Report must include identity count.");
Assert(report.IdentityTypes.ContainsKey("Admin"), "Report must include identity types.");
Assert(report.Conflicts.Count > 0, "Report must include conflicts.");
Assert(report.Errors.Count > 0, "Report must include errors.");
Assert(report.MigrationBlockers.Count > 0, "Report must include migration blockers.");
Assert(report.EstimatedMigrationDuration.StartsWith("PT", StringComparison.Ordinal), "Report must estimate migration duration.");
Assert(report.ReadinessScore < 100, "Readiness score must reflect blockers.");
Assert(report.ExportableJsonReport, "Report must be exportable as JSON.");
Assert(report.GeneratedAt == secondReport.GeneratedAt, "Reports must be deterministic.");
Assert(report.ReadinessScore == secondReport.ReadinessScore, "Report scoring must be deterministic.");

await VerifyAuthPersistenceAsync();
await VerifyAuthLoginRuntimeAsync();

Console.WriteLine("AuthService.Application.Tests PASS");

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

static async Task VerifyAuthPersistenceAsync()
{
    var disabled = new DisabledAuthRepository();
    Assert(await disabled.FindById(Guid.NewGuid()) is null, "Disabled auth repository must return no identities.");
    Assert((await disabled.ListPublicCredentials(Guid.NewGuid())).Count == 0, "Disabled auth repository must return no credentials.");
    Assert((await disabled.ListPermissions(Guid.NewGuid())).Count == 0, "Disabled auth repository must return no permissions.");
    Assert((await disabled.ListMemberships(Guid.NewGuid())).Count == 0, "Disabled auth repository must return no memberships.");
    Assert((await disabled.ListByCorrelationId("missing")).Count == 0, "Disabled auth repository must return no audit events.");

    var databaseUrl = Environment.GetEnvironmentVariable("DATABASE_URL");
    if (string.IsNullOrWhiteSpace(databaseUrl))
    {
        return;
    }

    var repository = new PostgresAuthRepository(databaseUrl);
    var suffix = Guid.NewGuid().ToString("N");
    var identityId = Guid.NewGuid();
    var createdAt = DateTimeOffset.UtcNow;
    var identity = new Identity(
        identityId,
        new LoginId($"persist-{suffix}@example.com"),
        IdentityType.Admin,
        IdentityLifecycleState.Active,
        Credentials: [],
        Roles: [],
        Claims: [],
        Memberships: [],
        CreatedAt: createdAt);

    repository.UpsertIdentity(identity);
    var persistedIdentity = await repository.FindByLoginId(identity.LoginId);
    Assert(persistedIdentity?.Id == identityId, "Postgres identity repository must persist and read identities.");

    var credentialId = Guid.NewGuid();
    var credential = new Credential(
        credentialId,
        identityId,
        CredentialType.Password,
        $"credential:{suffix}",
        PasswordOptional: false,
        Active: true,
        CreatedAt: createdAt,
        ExpiresAt: null);
    repository.UpsertCredential(credential, passwordHash: "argon2id-test-hash", hashAlgorithm: "ARGON2ID");
    var credentials = await repository.ListPublicCredentials(identityId);
    Assert(credentials.OfType<PasswordCredential>().Any(item => item.CredentialId == credentialId), "Postgres credential repository must persist and read public credentials.");
    var secret = await repository.FindSecretBoundary(credentialId);
    Assert(secret is { ReturnedByPublicQueryModel: false }, "Postgres credential repository must keep secret material out of public query models.");

    repository.UpsertRole(new Role($"ROLE_{suffix}", "Persistence Test Role", Permissions: [], SystemRole: false));
    repository.AssignRole(identityId, $"ROLE_{suffix}");
    var roles = await repository.ListRoles(identityId);
    Assert(roles.Any(role => role.Code == $"ROLE_{suffix}"), "Postgres role repository must persist and read assigned roles.");

    repository.UpsertPermission($"permission.{suffix}", "Persistence Test Permission");
    repository.AddPermissionClaim(identityId, $"permission.{suffix}");
    var permissions = await repository.ListPermissions(identityId);
    Assert(permissions.Contains($"permission.{suffix}"), "Postgres permission repository must persist and read direct permission claims.");

    var membership = new Membership(
        Guid.NewGuid(),
        identityId,
        "GLOBAL",
        "platform",
        Roles: [],
        Claims: [],
        EffectiveFrom: createdAt,
        EffectiveTo: null);
    repository.UpsertMembership(membership);
    var memberships = await repository.ListMemberships(identityId);
    Assert(memberships.Any(item => item.Id == membership.Id), "Postgres membership repository must persist and read memberships.");

    var session = new Session(
        Guid.NewGuid(),
        identityId,
        SessionState.Active,
        "default",
        createdAt,
        createdAt.AddHours(1),
        RevokedAt: null);
    repository.UpsertSession(session);
    var persistedSession = await repository.FindSession(session.Id);
    Assert(persistedSession?.State == SessionState.Active, "Postgres session repository must persist and read sessions.");
    var revokedSession = repository.RevokeSession(session.Id, createdAt.AddMinutes(10));
    Assert(revokedSession?.State == SessionState.Revoked && revokedSession.RevokedAt is not null, "Postgres session repository must persist revocation.");

    var auditEvent = new AuditEvent(
        Guid.NewGuid(),
        AuditEventCategory.Identity,
        ActorIdentityId: identityId,
        SubjectIdentityId: identityId,
        Action: "PERSISTENCE_TEST",
        CorrelationId: $"corr-{suffix}",
        Metadata: new Dictionary<string, string> { ["phase"] = "P0-001.1" },
        CreatedAt: createdAt);
    repository.AppendAuditEvent(auditEvent);
    var auditEvents = await repository.ListByCorrelationId(auditEvent.CorrelationId);
    Assert(auditEvents.Any(item => item.Id == auditEvent.Id), "Postgres audit event repository must append and read audit events.");
}

static async Task VerifyAuthLoginRuntimeAsync()
{
    var repository = new TestAuthRuntimeRepository();
    var identity = new Identity(
        Guid.NewGuid(),
        new LoginId("runtime-login@example.com"),
        IdentityType.Admin,
        IdentityLifecycleState.Active,
        Credentials: [],
        Roles: [],
        Claims: [],
        Memberships: [],
        CreatedAt: DateTimeOffset.UtcNow);
    var credential = new PasswordCredential(
        Guid.NewGuid(),
        identity.Id,
        "runtime-password",
        "PBKDF2-SHA256",
        "1",
        Enabled: true,
        CreatedAt: DateTimeOffset.UtcNow,
        DisabledAt: null,
        ExpiresAt: null);

    repository.AddIdentity(identity);
    repository.AddCredential(credential, CreatePbkdf2Hash("Correct-Horse-2026!"));

    var runtime = new AuthLoginRuntimeService(repository, repository, repository, repository, repository, repository);
    var success = await runtime.LoginAsync(new LoginRuntimeRequest(identity.LoginId.Value, "Correct-Horse-2026!", "runtime-success"));
    Assert(success.Success, "Valid login must create a session.");
    Assert(success.Session is { State: SessionState.Active }, "Valid login must create an active session.");
    Assert(repository.Sessions.ContainsKey(success.Session!.Id), "Created session must be persisted.");

    var me = await runtime.ValidateSessionAsync(success.Session.Id);
    Assert(me.Valid && me.Identity?.Id == identity.Id, "/me validation must return identity and session context.");

    repository.AddServiceCredential(
        identity.Id,
        "local-test-service",
        "local-test-service-client",
        ["settlement.run"],
        CreatePbkdf2Hash("Service-Secret-2026!"));

    var tokens = new AuthAccessTokenService(repository, repository, repository, repository, repository, runtime);
    var issued = await tokens.IssueForValidatedSessionAsync(me, "runtime-token");
    Assert(issued.Issued && !string.IsNullOrWhiteSpace(issued.AccessToken), "Login validation must issue a JWT access token.");
    var refresh = await tokens.IssueRefreshTokenForValidatedSessionAsync(me, "runtime-token");
    Assert(refresh.Issued && !string.IsNullOrWhiteSpace(refresh.RefreshToken), "Login validation must issue a refresh token.");
    var jwks = await tokens.GetJwksAsync();
    Assert(jwks.Any(key => key.KeyId == issued.KeyId), "JWKS must expose the active public signing key.");
    var tokenValidation = await tokens.ValidateAsync(issued.AccessToken!);
    Assert(tokenValidation.Valid, "Issued JWT access token must validate.");
    Assert(
        tokenValidation.Claims.TryGetValue("permissions", out var permissionClaim) &&
        permissionClaim.EnumerateArray().Any(item => item.GetString() == "system.admin"),
        "JWT access token must include permission claims.");
    var serviceToken = await tokens.IssueServiceTokenAsync("local-test-service", "Service-Secret-2026!", ["settlement.run"], "runtime-service-token");
    Assert(serviceToken.Success && !string.IsNullOrWhiteSpace(serviceToken.AccessToken), "Valid service credential must issue a service token.");
    var serviceTokenValidation = await tokens.ValidateServiceTokenAsync(serviceToken.AccessToken!, "settlement.run");
    Assert(serviceTokenValidation.Valid, "Service token must validate for allowed scope.");
    var invalidServiceToken = await tokens.IssueServiceTokenAsync("local-test-service", "wrong-secret", ["settlement.run"], "runtime-service-token-invalid");
    Assert(!invalidServiceToken.Success && invalidServiceToken.Reason == "invalid_service_credential", "Invalid service credential must fail.");
    var deniedServiceScope = await tokens.ValidateServiceTokenAsync(serviceToken.AccessToken!, "ledger.write");
    Assert(!deniedServiceScope.Valid && deniedServiceScope.Reason == "insufficient_scope", "Service token validation must fail for unauthorized scope.");
    var rotated = await tokens.RefreshAsync(refresh.RefreshToken!, "runtime-refresh");
    Assert(rotated.Success && rotated.AccessToken?.Issued == true && !string.IsNullOrWhiteSpace(rotated.RefreshToken), "Refresh must rotate refresh token and issue a new access token.");
    Assert(rotated.RefreshToken != refresh.RefreshToken, "Refresh rotation must return a new refresh token.");
    var oldRefreshReplay = await tokens.RefreshAsync(refresh.RefreshToken!, "runtime-refresh-replay");
    Assert(!oldRefreshReplay.Success && oldRefreshReplay.ReplayDetected, "Reused old refresh token must be treated as replay.");
    var replaySession = await runtime.ValidateSessionAsync(success.Session.Id);
    Assert(!replaySession.Valid && replaySession.Reason == "session_revoked", "Refresh replay must revoke the bound session.");

    var secondLogin = await runtime.LoginAsync(new LoginRuntimeRequest(identity.LoginId.Value, "Correct-Horse-2026!", "runtime-second-login"));
    var secondValidation = await runtime.ValidateSessionAsync(secondLogin.Session!.Id);
    var secondRefresh = await tokens.IssueRefreshTokenForValidatedSessionAsync(secondValidation, "runtime-second-login");

    var invalid = await runtime.LoginAsync(new LoginRuntimeRequest(identity.LoginId.Value, "wrong-password", "runtime-failure"));
    Assert(!invalid.Success && invalid.FailureReason == CredentialFailureReason.InvalidCredential, "Invalid password must fail.");

    await tokens.RevokeRefreshTokensForSessionAsync(secondLogin.Session.Id, "runtime-logout");
    await runtime.LogoutAsync(secondLogin.Session.Id, "runtime-logout");
    var revoked = await runtime.ValidateSessionAsync(secondLogin.Session.Id);
    Assert(!revoked.Valid && revoked.Reason == "session_revoked", "Revoked session must be invalid.");
    var refreshAfterLogout = await tokens.RefreshAsync(secondRefresh.RefreshToken!, "runtime-refresh-after-logout");
    Assert(!refreshAfterLogout.Success && refreshAfterLogout.ReplayDetected, "Refresh token must fail after logout revokes it.");
    var revokedToken = await tokens.ValidateAsync(issued.AccessToken!);
    Assert(!revokedToken.Valid && revokedToken.Reason == "session_revoked", "Revoked session must make JWT validation fail through the session path.");

    var expired = new Session(Guid.NewGuid(), identity.Id, SessionState.Active, "interactive-default", DateTimeOffset.UtcNow.AddHours(-2), DateTimeOffset.UtcNow.AddMinutes(-1), null);
    await repository.SaveSession(expired);
    var expiredValidation = await runtime.ValidateSessionAsync(expired.Id);
    Assert(!expiredValidation.Valid && expiredValidation.Reason == "session_expired", "Expired session must be invalid.");

    var expiredToken = repository.SignTestToken(identity.Id, expired.Id, issued.KeyId!, DateTimeOffset.UtcNow.AddMinutes(-10), DateTimeOffset.UtcNow.AddMinutes(-5));
    var expiredTokenValidation = await tokens.ValidateAsync(expiredToken);
    Assert(!expiredTokenValidation.Valid && expiredTokenValidation.Reason == "token_expired", "Expired JWT access token must fail validation.");
    var expiredRawRefreshToken = "rt_expired_refresh_token";
    await repository.SaveRefreshToken(
        Guid.NewGuid(),
        identity.Id,
        expired.Id,
        Guid.NewGuid(),
        Guid.NewGuid(),
        0,
        null,
        HashTestRefreshToken(expiredRawRefreshToken),
        DateTimeOffset.UtcNow.AddDays(-31),
        DateTimeOffset.UtcNow.AddMinutes(-1));
    var expiredRefreshValidation = await tokens.RefreshAsync("expired-refresh-token", "runtime-expired-refresh");
    Assert(!expiredRefreshValidation.Success && expiredRefreshValidation.Reason == "refresh_token_not_found", "Unknown refresh token must fail.");
    var expiredKnownRefreshValidation = await tokens.RefreshAsync(expiredRawRefreshToken, "runtime-expired-refresh-known");
    Assert(!expiredKnownRefreshValidation.Success && expiredKnownRefreshValidation.Reason == "refresh_token_expired", "Expired refresh token must fail.");

    var auditEvents = await repository.ListByCorrelationId("runtime-success");
    Assert(auditEvents.Any(item => item.Action == "LOGIN_SUCCESS"), "Login success audit event must be written.");
    var failureAuditEvents = await repository.ListByCorrelationId("runtime-failure");
    Assert(failureAuditEvents.Any(item => item.Action == "LOGIN_FAILURE"), "Login failure audit event must be written.");
    var logoutAuditEvents = await repository.ListByCorrelationId("runtime-logout");
    Assert(logoutAuditEvents.Any(item => item.Action == "LOGOUT"), "Logout audit event must be written.");
}

static string CreatePbkdf2Hash(string password)
{
    var salt = RandomNumberGenerator.GetBytes(16);
    var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, 100_000, HashAlgorithmName.SHA256, 32);
    return $"pbkdf2-sha256$100000${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
}

static string HashTestRefreshToken(string refreshToken)
{
    return Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(refreshToken))).ToLowerInvariant();
}

sealed class TestLegacyPlatformIdentitySource : ILegacyPlatformIdentitySource
{
    public int ReadCount { get; private set; }
    public int WriteCount { get; private set; }

    public Task<LegacyPlatformSnapshot> ReadSnapshotAsync(CancellationToken cancellationToken = default)
    {
        ReadCount++;
        return Task.FromResult(new LegacyPlatformSnapshot(
            Source: "test-legacy-platform",
            SourceWired: true,
            CapturedAt: new DateTimeOffset(2026, 7, 1, 12, 0, 0, TimeSpan.Zero),
            Identities:
            [
                Identity("platform_users", "admin-1", "ADMIN", "PLATFORM_OPERATOR", "admin", "admin@example.com", "ACTIVE", [Role("SUPER_ADMIN", ["system.admin"])], [Claim("permission", "system.admin")], [Credential("PASSWORD_HASH", "platform_users:admin-1:password", "ARGON2ID")], [Membership("GLOBAL", "platform", ["SUPER_ADMIN"])]),
                Identity("accounts", "player-1", "PLAYER", "PLAYER", "player", "player@example.com", "ACTIVE", [Role("PLAYER", ["players.view"])], [Claim("permission", "players.view")], [Credential("PASSWORD_HASH", "accounts:player-1:password", "BCRYPT")], [Membership("ACCOUNT", "player-1", ["PLAYER"])]),
                Identity("accounts", "agent-1", "AGENT", "AGENT", "agent", "agent@example.com", "ACTIVE", [Role("AGENT", ["agents.view"])], [Claim("permission", "agents.view")], [Credential("PASSWORD_HASH", "accounts:agent-1:password", "BCRYPT")], [Membership("ACCOUNT", "agent-1", ["AGENT"])]),
                Identity("oauth_clients", "api-client-1", "API_CLIENT", null, "client-a", "client-a@example.com", "ACTIVE", [Role("API_CLIENT", ["system.api"])], [Claim("scope", "tickets.read")], [Credential("CLIENT_SECRET", "oauth_clients:api-client-1:secret", "SHA256")], [Membership("GLOBAL", "platform", ["API_CLIENT"])]),
                Identity("service_accounts", "service-1", "SERVICE_ACCOUNT", null, "settlement-service", "settlement@example.com", "ACTIVE", [Role("SERVICE_ACCOUNT", ["settlement.run"])], [Claim("scope", "settlement.run")], [Credential("CERTIFICATE", "service_accounts:service-1:certificate", null)], [Membership("GLOBAL", "platform", ["SERVICE_ACCOUNT"])]),
                Identity("platform_users", "dupe-1", "ADMIN", "PLATFORM_OPERATOR", "dupe", "dupe@example.com", "ACTIVE", [Role("OPERATIONS_ADMIN", ["operations.view"])], [Claim("permission", "operations.view")], [Credential("PASSWORD_HASH", "platform_users:dupe-1:password", "ARGON2ID")], [Membership("GLOBAL", "platform", ["OPERATIONS_ADMIN"])]),
                Identity("platform_users", "dupe-2", "ADMIN", "PLATFORM_OPERATOR", "dupe", "dupe@example.com", "ACTIVE", [Role("OPERATIONS_ADMIN", ["operations.view"])], [Claim("permission", "operations.view")], [Credential("PASSWORD_HASH", "platform_users:dupe-2:password", "ARGON2ID")], [Membership("GLOBAL", "platform", ["OPERATIONS_ADMIN"])]),
                Identity("platform_users", "bad-1", "ALIEN", "UNKNOWN", "bad", "bad@example.com", null, [Role("UNKNOWN_ROLE", [])], [Claim("permission", "bad.permission")], [Credential("LEGACY_MD5", "platform_users:bad-1:password", "MD5")], [Membership("UNKNOWN_SCOPE", "bad", ["UNKNOWN_ROLE"])]),
                Identity("platform_users", "missing-credential-1", "ADMIN", "PLATFORM_OPERATOR", "missing", "missing@example.com", "ACTIVE", [Role("SUPPORT_ADMIN", ["support.view"])], [Claim("permission", "support.view")], [], [Membership("GLOBAL", "platform", ["SUPPORT_ADMIN"])])
            ],
            Sessions:
            [
                new LegacySessionMetadata("session-1", "platform_users:admin-1", "ACTIVE", new DateTimeOffset(2026, 7, 1, 13, 0, 0, TimeSpan.Zero)),
                new LegacySessionMetadata("session-orphan", "platform_users:missing-user", "ACTIVE", new DateTimeOffset(2026, 7, 1, 13, 0, 0, TimeSpan.Zero))
            ],
            Roles: [Role("SUPER_ADMIN", ["system.admin"]), Role("PLAYER", ["players.view"])],
            Permissions: ["system.admin", "players.view", "agents.view"],
            PlayerAccountCount: 1,
            AgentAccountCount: 1,
            AdminAccountCount: 5,
            ServiceAccountCount: 1,
            ApiClientCount: 1));
    }

    private static LegacyPlatformIdentity Identity(
        string sourceSystem,
        string sourceId,
        string accountType,
        string? identityClass,
        string username,
        string email,
        string? status,
        IReadOnlyCollection<LegacyRoleMetadata> roles,
        IReadOnlyCollection<LegacyClaimMetadata> claims,
        IReadOnlyCollection<LegacyCredentialMetadata> credentials,
        IReadOnlyCollection<LegacyMembershipMetadata> memberships)
    {
        return new LegacyPlatformIdentity(
            sourceSystem,
            sourceId,
            accountType,
            identityClass,
            username,
            username,
            email,
            status,
            null,
            roles,
            claims,
            credentials,
            memberships);
    }

    private static LegacyRoleMetadata Role(string code, IReadOnlyCollection<string> permissions)
    {
        return new LegacyRoleMetadata(code, permissions);
    }

    private static LegacyClaimMetadata Claim(string type, string value)
    {
        return new LegacyClaimMetadata(type, value, "legacy-platform");
    }

    private static LegacyCredentialMetadata Credential(string type, string reference, string? hashAlgorithm)
    {
        return new LegacyCredentialMetadata(type, reference, hashAlgorithm, Active: true);
    }

    private static LegacyMembershipMetadata Membership(
        string scopeType,
        string scopeId,
        IReadOnlyCollection<string> roles)
    {
        return new LegacyMembershipMetadata(scopeType, scopeId, roles);
    }
}

sealed class TestAuthRuntimeRepository :
    IIdentityRepository,
    ICredentialRepository,
    ISessionRepository,
    IRoleRepository,
    IPermissionRepository,
    ITokenRepository,
    IRefreshTokenRepository,
    IServiceAccountRepository,
    ISigningKeyRepository,
    IAuthRuntimeStore,
    IAuditEventRepository
{
    private readonly Dictionary<Guid, Identity> identities = new();
    private readonly Dictionary<string, Guid> loginIndex = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<Guid, PasswordCredential> credentials = new();
    private readonly Dictionary<Guid, CredentialSecretBoundary> secrets = new();
    private readonly Dictionary<Guid, AccessTokenMetadata> accessTokens = new();
    private readonly Dictionary<Guid, RefreshTokenRuntimeRecord> refreshTokens = new();
    private readonly Dictionary<string, Guid> refreshTokenHashIndex = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ServiceCredentialSecretBoundary> serviceCredentials = new(StringComparer.Ordinal);
    private readonly Dictionary<Guid, SigningKeyMaterial> signingKeys = new();
    private readonly List<AuditEvent> auditEvents = [];

    public Dictionary<Guid, Session> Sessions { get; } = new();

    public bool RuntimeAvailable => true;

    public void AddIdentity(Identity identity)
    {
        identities[identity.Id] = identity;
        loginIndex[identity.LoginId.Value] = identity.Id;
    }

    public void AddCredential(PasswordCredential credential, string passwordHash)
    {
        credentials[credential.CredentialId] = credential;
        secrets[credential.CredentialId] = new CredentialSecretBoundary(
            credential.CredentialId,
            passwordHash,
            ReturnedByPublicQueryModel: false);
    }

    public void AddServiceCredential(Guid identityId, string serviceName, string clientId, IReadOnlyCollection<string> scopes, string secretHash)
    {
        serviceCredentials[serviceName] = new ServiceCredentialSecretBoundary(
            Guid.NewGuid(),
            identityId,
            Guid.NewGuid(),
            serviceName,
            clientId,
            scopes,
            secretHash,
            "PBKDF2-SHA256");
    }

    public Task<Identity?> FindById(Guid identityId, CancellationToken cancellationToken = default)
    {
        identities.TryGetValue(identityId, out var identity);
        return Task.FromResult(identity);
    }

    public Task<Identity?> FindByLoginId(LoginId loginId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(loginIndex.TryGetValue(loginId.Value, out var identityId) ? identities[identityId] : null);
    }

    public Task<IReadOnlyCollection<CredentialBoundary>> ListPublicCredentials(Guid identityId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<CredentialBoundary>>(
            credentials.Values.Where(credential => credential.IdentityId == identityId).Cast<CredentialBoundary>().ToArray());
    }

    public Task<CredentialSecretBoundary?> FindSecretBoundary(Guid credentialId, CancellationToken cancellationToken = default)
    {
        secrets.TryGetValue(credentialId, out var secret);
        return Task.FromResult(secret);
    }

    public Task<IReadOnlyCollection<Role>> ListRoles(Guid identityId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<Role>>(
        [
            new Role("LOCAL_ADMIN", "Local Admin", Permissions: ["system.admin"], SystemRole: true)
        ]);
    }

    public Task<IReadOnlyCollection<string>> ListPermissions(Guid identityId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<string>>(["system.admin"]);
    }

    public Task<Session?> FindSession(Guid sessionId, CancellationToken cancellationToken = default)
    {
        Sessions.TryGetValue(sessionId, out var session);
        return Task.FromResult(session);
    }

    public Task<Session> SaveSession(Session session, CancellationToken cancellationToken = default)
    {
        Sessions[session.Id] = session;
        return Task.FromResult(session);
    }

    public Task<Session?> RevokeSession(Guid sessionId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default)
    {
        if (!Sessions.TryGetValue(sessionId, out var session))
        {
            return Task.FromResult<Session?>(null);
        }

        var revoked = session with { State = SessionState.Revoked, RevokedAt = revokedAt };
        Sessions[sessionId] = revoked;
        return Task.FromResult<Session?>(revoked);
    }

    public Task<AuditEvent> AppendAuditEvent(AuditEvent auditEvent, CancellationToken cancellationToken = default)
    {
        auditEvents.Add(auditEvent);
        return Task.FromResult(auditEvent);
    }

    public Task<IReadOnlyCollection<AuditEvent>> ListByCorrelationId(string correlationId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<AuditEvent>>(
            auditEvents.Where(item => item.CorrelationId == correlationId).OrderBy(item => item.CreatedAt).ToArray());
    }

    public Task<AccessTokenMetadata?> FindAccessTokenMetadata(Guid tokenId, CancellationToken cancellationToken = default)
    {
        accessTokens.TryGetValue(tokenId, out var token);
        return Task.FromResult<AccessTokenMetadata?>(token);
    }

    public Task<OpaqueTokenReference?> FindOpaqueReference(string referenceHash, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<OpaqueTokenReference?>(null);
    }

    public Task<AccessTokenMetadata> SaveJwtAccessToken(
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
        CancellationToken cancellationToken = default)
    {
        var metadata = new AccessTokenMetadata(tokenId, identityId, "JWT", issuer, audience, scopes, jwtId, signingKeyId, issuedAt, expiresAt);
        accessTokens[tokenId] = metadata;
        return Task.FromResult(metadata);
    }

    public Task<RefreshTokenMetadata?> FindRefreshToken(Guid refreshTokenId, CancellationToken cancellationToken = default)
    {
        if (!refreshTokens.TryGetValue(refreshTokenId, out var token))
        {
            return Task.FromResult<RefreshTokenMetadata?>(null);
        }

        return Task.FromResult<RefreshTokenMetadata?>(new RefreshTokenMetadata(
            token.RefreshTokenId,
            token.FamilyId,
            token.RotationCounter,
            token.PreviousRefreshTokenId,
            token.IssuedAt,
            token.ExpiresAt,
            token.RotatedAt,
            token.RevokedAt));
    }

    public Task<ServiceAccount?> FindByServiceName(string serviceName, CancellationToken cancellationToken = default)
    {
        if (!serviceCredentials.TryGetValue(serviceName, out var credential))
        {
            return Task.FromResult<ServiceAccount?>(null);
        }

        var client = new OAuthClient(
            credential.OAuthClientId,
            credential.ClientId,
            credential.ServiceName,
            ["client_credentials"],
            [],
            credential.Scopes,
            RequiresPkce: false,
            MtlsBound: false);
        return Task.FromResult<ServiceAccount?>(new ServiceAccount(
            credential.ServiceAccountId,
            credential.IdentityId,
            credential.ServiceName,
            client,
            MtlsOptional: true));
    }

    public Task<ServiceCredentialSecretBoundary?> FindServiceCredentialSecret(string serviceName, CancellationToken cancellationToken = default)
    {
        serviceCredentials.TryGetValue(serviceName, out var credential);
        return Task.FromResult<ServiceCredentialSecretBoundary?>(credential);
    }

    public Task<RefreshTokenRuntimeRecord?> FindRefreshTokenByHash(string referenceHash, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(
            refreshTokenHashIndex.TryGetValue(referenceHash, out var refreshTokenId)
                ? refreshTokens[refreshTokenId]
                : null);
    }

    public Task<RefreshTokenRuntimeRecord> SaveRefreshToken(
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
        CancellationToken cancellationToken = default)
    {
        var token = new RefreshTokenRuntimeRecord(
            refreshTokenId,
            identityId,
            sessionId,
            tokenId,
            familyId,
            rotationCounter,
            previousRefreshTokenId,
            referenceHash,
            issuedAt,
            expiresAt,
            RotatedAt: null,
            RevokedAt: null,
            RevokedReason: null);
        refreshTokens[refreshTokenId] = token;
        refreshTokenHashIndex[referenceHash] = refreshTokenId;
        return Task.FromResult(token);
    }

    public Task<RefreshTokenRuntimeRecord?> MarkRefreshTokenRotated(Guid refreshTokenId, DateTimeOffset rotatedAt, CancellationToken cancellationToken = default)
    {
        if (!refreshTokens.TryGetValue(refreshTokenId, out var token))
        {
            return Task.FromResult<RefreshTokenRuntimeRecord?>(null);
        }

        var rotated = token with { RotatedAt = token.RotatedAt ?? rotatedAt };
        refreshTokens[refreshTokenId] = rotated;
        return Task.FromResult<RefreshTokenRuntimeRecord?>(rotated);
    }

    public Task<int> RevokeRefreshTokensForSession(Guid sessionId, DateTimeOffset revokedAt, string reason, CancellationToken cancellationToken = default)
    {
        var count = 0;
        foreach (var token in refreshTokens.Values.Where(token => token.SessionId == sessionId && token.RevokedAt is null).ToArray())
        {
            refreshTokens[token.RefreshTokenId] = token with { RevokedAt = revokedAt, RevokedReason = reason };
            count++;
        }

        return Task.FromResult(count);
    }

    public Task<int> RevokeRefreshTokenFamily(Guid familyId, DateTimeOffset revokedAt, string reason, CancellationToken cancellationToken = default)
    {
        var count = 0;
        foreach (var token in refreshTokens.Values.Where(token => token.FamilyId == familyId && token.RevokedAt is null).ToArray())
        {
            refreshTokens[token.RefreshTokenId] = token with { RevokedAt = revokedAt, RevokedReason = reason };
            count++;
        }

        return Task.FromResult(count);
    }

    public Task<IReadOnlyCollection<SigningKeyMetadata>> ListSigningKeys(CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<SigningKeyMetadata>>(
            signingKeys.Values.Select(key => new SigningKeyMetadata(
                key.SigningKeyId,
                key.KeyId,
                key.Algorithm,
                key.Version,
                key.Status,
                key.ActivatesAt,
                key.ExpiresAt,
                key.RetiredAt)).ToArray());
    }

    public Task<IReadOnlyCollection<JwksKeyDescriptor>> ListPublicJwks(CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<JwksKeyDescriptor>>(
            signingKeys.Values
                .Where(key => key.Status == "ACTIVE")
                .Select(key => new JwksKeyDescriptor(key.KeyId, key.Algorithm, "sig", key.PublicParameters))
                .ToArray());
    }

    public Task<SigningKeyMaterial?> FindActiveSigningKey(CancellationToken cancellationToken = default)
    {
        return Task.FromResult<SigningKeyMaterial?>(
            signingKeys.Values.FirstOrDefault(key => key.Status == "ACTIVE"));
    }

    public Task<SigningKeyMaterial> SaveSigningKey(SigningKeyMaterial signingKey, CancellationToken cancellationToken = default)
    {
        signingKeys[signingKey.SigningKeyId] = signingKey;
        return Task.FromResult(signingKey);
    }

    public string SignTestToken(Guid identityId, Guid sessionId, string keyId, DateTimeOffset issuedAt, DateTimeOffset expiresAt)
    {
        var key = signingKeys.Values.Single(item => item.KeyId == keyId);
        var header = new Dictionary<string, object?> { ["typ"] = "JWT", ["alg"] = "RS256", ["kid"] = key.KeyId };
        var payload = new Dictionary<string, object?>
        {
            ["iss"] = "lottery-auth-service",
            ["aud"] = "lottery-platform",
            ["sub"] = identityId.ToString(),
            ["identity_id"] = identityId.ToString(),
            ["session_id"] = sessionId.ToString(),
            ["jti"] = Guid.NewGuid().ToString("N"),
            ["iat"] = issuedAt.ToUnixTimeSeconds(),
            ["nbf"] = issuedAt.ToUnixTimeSeconds(),
            ["exp"] = expiresAt.ToUnixTimeSeconds(),
            ["permissions"] = new[] { "system.admin" },
            ["roles"] = new[] { "LOCAL_ADMIN" },
            ["groups"] = new[] { "LOCAL_ADMIN" }
        };
        var encodedHeader = Base64UrlEncode(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(header));
        var encodedPayload = Base64UrlEncode(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(payload));
        var signedPayload = System.Text.Encoding.ASCII.GetBytes($"{encodedHeader}.{encodedPayload}");
        using var rsa = RSA.Create();
        rsa.ImportFromPem(key.PrivateKeyPem);
        var signature = rsa.SignData(signedPayload, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{encodedHeader}.{encodedPayload}.{Base64UrlEncode(signature)}";
    }

    private static string Base64UrlEncode(byte[] bytes)
    {
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }
}
