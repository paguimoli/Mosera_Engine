using AuthService.Domain.Models;

namespace AuthService.Application;

public sealed class AuthArchitectureService
{
    public AuthServiceStatus GetStatus()
    {
        return new AuthServiceStatus(
            ServiceName: "auth-service",
            ArchitecturePhase: "23.3",
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

    public PersistenceModelSummary GetPersistenceModel()
    {
        return new PersistenceModelSummary(
            SchemaName: "auth_service",
            SchemaArtifact: "services/auth-service/database/001_auth_service_schema_draft.sql",
            RequiredTables:
            [
                "auth_service.identities",
                "auth_service.identity_aliases",
                "auth_service.identity_credentials",
                "auth_service.identity_lifecycle_events",
                "auth_service.roles",
                "auth_service.permissions",
                "auth_service.identity_roles",
                "auth_service.identity_claims",
                "auth_service.policies",
                "auth_service.memberships",
                "auth_service.sessions",
                "auth_service.tokens",
                "auth_service.refresh_tokens",
                "auth_service.oauth_clients",
                "auth_service.oauth_client_secrets",
                "auth_service.service_accounts",
                "auth_service.api_clients",
                "auth_service.security_relationships",
                "auth_service.audit_events",
                "auth_service.signing_keys"
            ],
            RepositoryContracts:
            [
                "IIdentityRepository",
                "IIdentityAliasRepository",
                "ICredentialRepository",
                "ILifecycleRepository",
                "IRoleRepository",
                "IPermissionRepository",
                "IClaimRepository",
                "IPolicyRepository",
                "IMembershipRepository",
                "ISessionRepository",
                "ITokenRepository",
                "IRefreshTokenRepository",
                "IOAuthClientRepository",
                "IServiceAccountRepository",
                "IApiClientRepository",
                "ISecurityRelationshipRepository",
                "IAuditEventRepository",
                "ISigningKeyRepository"
            ],
            LoginIdUnique: true,
            LoginIdImmutable: true,
            HardDeletesAllowed: false,
            CredentialStorageSeparated: true,
            BusinessHierarchyExcluded: true,
            TriggerEnforcementDeferred: true);
    }

    public CredentialModelSummary GetCredentialModel()
    {
        return new CredentialModelSummary(
            PasswordsOptional: true,
            MultipleCredentialsPerIdentity: true,
            IndividualCredentialDisableSupported: true,
            SecretMaterialReturnedByNormalQueries: false,
            VerificationImplemented: false,
            SecretStorageSeparated: true,
            CredentialModels:
            [
                "PasswordCredential",
                "TotpCredential",
                "WebAuthnCredential",
                "OAuthFederatedCredential",
                "PamFederatedCredential",
                "ApiKeyCredential",
                "ClientSecretCredential",
                "CertificateCredential"
            ]);
    }

    public CredentialVerificationModelSummary GetCredentialVerificationModel()
    {
        return new CredentialVerificationModelSummary(
            ProviderBasedVerification: true,
            ProductionVerificationImplemented: false,
            SessionCreationAllowed: false,
            TokenIssuanceAllowed: false,
            Flow:
            [
                "Resolve identity by Login ID or alias.",
                "Check lifecycle state.",
                "Resolve enabled credentials.",
                "Select credential verifier.",
                "Verify credential with provider.",
                "Evaluate MFA policy.",
                "Emit audit/security event.",
                "Return structured verification result."
            ],
            VerifierContracts:
            [
                "ICredentialVerifier",
                "IPasswordCredentialVerifier",
                "ITotpCredentialVerifier",
                "IWebAuthnCredentialVerifier",
                "IFederatedCredentialVerifier",
                "IPamCredentialVerifier",
                "IApiKeyCredentialVerifier",
                "IClientSecretCredentialVerifier",
                "ICertificateCredentialVerifier",
                "ICredentialVerificationPolicy",
                "ICredentialVerificationAuditSink"
            ],
            ResultStatuses: Enum.GetNames<CredentialVerificationStatus>(),
            FailureReasons: Enum.GetNames<CredentialFailureReason>(),
            RiskFlags: Enum.GetNames<SecurityRiskFlag>(),
            SecretValuesExposed: false);
    }

    public PasswordPolicy GetPasswordPolicy()
    {
        return new PasswordPolicy(
            MinimumLength: 12,
            MaximumLength: 128,
            RequireUppercase: true,
            RequireLowercase: true,
            RequireDigit: true,
            RequireSymbol: false,
            CompromisedPasswordCheckPlaceholder: true,
            PasswordReusePreventionPlaceholder: true,
            PasswordExpirationPolicyPlaceholder: true,
            PasswordResetRequiredFlagSupported: true,
            TemporaryPasswordFlagSupported: true,
            FailedLoginLockoutThreshold: 10,
            LockoutDuration: TimeSpan.FromMinutes(30),
            AdminForcedResetSupported: true,
            PasswordlessAllowed: true,
            HashingDecision: PasswordHashingDecision.Deferred,
            PlaintextPasswordStorageAllowed: false);
    }

    public MfaPolicy GetMfaPolicy()
    {
        return new MfaPolicy(
            RequiredIdentityTypes:
            [
                IdentityType.Admin,
                IdentityType.Operator,
                IdentityType.ServiceAccount,
                IdentityType.ApiClient
            ],
            RequiredRoles:
            [
                "super_admin",
                "operations_admin",
                "security_admin",
                "authority_approver"
            ],
            RequiredPolicyCodes:
            [
                "authority.approval",
                "credential.management",
                "security.relationship.management"
            ],
            RequiredForPrivilegedOperations: true,
            RequiredForSuspiciousLogin: true,
            SupportedMethods:
            [
                MfaMethod.Totp,
                MfaMethod.WebAuthnPasskey,
                MfaMethod.EmailOtpPlaceholder,
                MfaMethod.SmsOtpPlaceholder,
                MfaMethod.RecoveryCodePlaceholder
            ],
            RememberedDevicePlaceholder: true,
            StepUpAuthenticationPlaceholder: true,
            ProductionMfaVerificationImplemented: false);
    }

    public AuthenticationEligibilityReport GetAuthenticationEligibility()
    {
        var samples = new[]
        {
            BuildEligibilitySample(IdentityLifecycleState.Active),
            BuildEligibilitySample(IdentityLifecycleState.PendingActivation),
            BuildEligibilitySample(IdentityLifecycleState.Locked),
            BuildEligibilitySample(IdentityLifecycleState.Suspended),
            BuildEligibilitySample(IdentityLifecycleState.Disabled),
            BuildEligibilitySample(IdentityLifecycleState.Archived)
        };

        return new AuthenticationEligibilityReport(
            LifecycleGateRequired: true,
            ActiveMayProceed: true,
            DeniedStates:
            [
                IdentityLifecycleState.Suspended.ToString(),
                IdentityLifecycleState.Disabled.ToString(),
                IdentityLifecycleState.Archived.ToString(),
                IdentityLifecycleState.Deleted.ToString()
            ],
            StructuredOutcomes: samples,
            GeneratedAt: DateTimeOffset.UtcNow);
    }

    public CredentialVerifierCatalog GetCredentialVerifiers()
    {
        return new CredentialVerifierCatalog(
            Verifiers:
            [
                new CredentialVerifierDescriptor("Password", "IPasswordCredentialVerifier", false, true),
                new CredentialVerifierDescriptor("Totp", "ITotpCredentialVerifier", false, true),
                new CredentialVerifierDescriptor("WebAuthnPasskey", "IWebAuthnCredentialVerifier", false, true),
                new CredentialVerifierDescriptor("OAuthFederated", "IFederatedCredentialVerifier", false, true),
                new CredentialVerifierDescriptor("PAMFederated", "IPamCredentialVerifier", false, true),
                new CredentialVerifierDescriptor("ApiKey", "IApiKeyCredentialVerifier", false, true),
                new CredentialVerifierDescriptor("ClientSecret", "IClientSecretCredentialVerifier", false, true),
                new CredentialVerifierDescriptor("Certificate", "ICertificateCredentialVerifier", false, true)
            ],
            ProductionVerificationImplemented: false,
            DefaultUnsupportedResult: CredentialVerificationStatus.UnsupportedCredential,
            SecretValuesExposed: false,
            GeneratedAt: DateTimeOffset.UtcNow);
    }

    public TokenModelSummary GetTokenModel()
    {
        return new TokenModelSummary(
            JwtSupportedByModel: true,
            OpaqueReferenceSupportedByModel: true,
            TokenIssuanceImplemented: false,
            TokenIntrospectionImplemented: false,
            TokenRevocationModeled: true,
            RefreshTokenRotationModeled: true,
            SigningKeyRotationModeled: true,
            TokenModels:
            [
                "AccessTokenMetadata",
                "OpaqueTokenReference",
                "RefreshTokenMetadata",
                "TokenRevocationRecord",
                "TokenIntrospectionRecord",
                "SigningKeyMetadata",
                "JwksKeyDescriptor"
            ]);
    }

    public AuthMigrationReadiness GetMigrationReadiness()
    {
        var blockers = new[]
        {
            new AuthMigrationBlocker("SCHEMA_NOT_APPLIED", "Auth Service schema has not been applied.", Resolved: false),
            new AuthMigrationBlocker("CREDENTIAL_VERIFICATION_NOT_IMPLEMENTED", "Credential verification is not implemented.", Resolved: false),
            new AuthMigrationBlocker("TOKEN_ISSUANCE_NOT_IMPLEMENTED", "Token issuance is not implemented.", Resolved: false),
            new AuthMigrationBlocker("CURRENT_PLATFORM_AUTH_NOT_MAPPED", "Current platform auth is not mapped to Auth Service identities.", Resolved: false),
            new AuthMigrationBlocker("SESSION_MIGRATION_NOT_DESIGNED", "Session migration is not designed.", Resolved: false),
            new AuthMigrationBlocker("OAUTH_OIDC_NOT_IMPLEMENTED", "OAuth/OIDC runtime is not implemented.", Resolved: false),
            new AuthMigrationBlocker("ROLLBACK_PLAN_NOT_DEFINED", "Auth migration rollback plan is not defined.", Resolved: false),
            new AuthMigrationBlocker("QA_MIGRATION_TESTS_NOT_PASSED", "Auth migration QA tests have not passed.", Resolved: false)
        };

        return new AuthMigrationReadiness(
            AuthMigrationGateStatus.Blocked,
            [
                new AuthMigrationGate("PERSISTENCE", AuthMigrationGateStatus.Blocked, blockers.Where(blocker => blocker.Code == "SCHEMA_NOT_APPLIED").ToArray()),
                new AuthMigrationGate("RUNTIME", AuthMigrationGateStatus.Blocked, blockers.Where(blocker => blocker.Code is "CREDENTIAL_VERIFICATION_NOT_IMPLEMENTED" or "TOKEN_ISSUANCE_NOT_IMPLEMENTED" or "OAUTH_OIDC_NOT_IMPLEMENTED").ToArray()),
                new AuthMigrationGate("MIGRATION", AuthMigrationGateStatus.Blocked, blockers.Where(blocker => blocker.Code is "CURRENT_PLATFORM_AUTH_NOT_MAPPED" or "SESSION_MIGRATION_NOT_DESIGNED" or "ROLLBACK_PLAN_NOT_DEFINED" or "QA_MIGRATION_TESTS_NOT_PASSED").ToArray())
            ],
            blockers,
            DateTimeOffset.UtcNow);
    }

    public SchemaStatusSummary GetSchemaStatus()
    {
        return new SchemaStatusSummary(
            SchemaArtifactPresent: true,
            SchemaApplied: false,
            RequiredTableCount: GetPersistenceModel().RequiredTables.Count,
            TriggerEnforcementDeferred: true,
            MigrationAllowed: false,
            Reasons:
            [
                "Phase 23.2 creates schema artifacts only.",
                "Production Auth Service persistence is not wired.",
                "Current platform auth is unchanged."
            ],
            GeneratedAt: DateTimeOffset.UtcNow);
    }

    private static AuthenticationEligibilityResult BuildEligibilitySample(IdentityLifecycleState lifecycleState)
    {
        return lifecycleState switch
        {
            IdentityLifecycleState.Active => new AuthenticationEligibilityResult(
                Guid.Empty,
                lifecycleState,
                AuthenticationEligibilityStatus.Eligible,
                MayAttemptCredentialVerification: true,
                Reason: "Identity is active."),
            IdentityLifecycleState.PendingActivation => new AuthenticationEligibilityResult(
                Guid.Empty,
                lifecycleState,
                AuthenticationEligibilityStatus.PendingVerification,
                MayAttemptCredentialVerification: false,
                Reason: "Identity is pending verification."),
            IdentityLifecycleState.Locked => new AuthenticationEligibilityResult(
                Guid.Empty,
                lifecycleState,
                AuthenticationEligibilityStatus.Locked,
                MayAttemptCredentialVerification: false,
                Reason: "Identity is locked."),
            IdentityLifecycleState.Suspended => new AuthenticationEligibilityResult(
                Guid.Empty,
                lifecycleState,
                AuthenticationEligibilityStatus.Suspended,
                MayAttemptCredentialVerification: false,
                Reason: "Identity is suspended."),
            IdentityLifecycleState.Disabled => new AuthenticationEligibilityResult(
                Guid.Empty,
                lifecycleState,
                AuthenticationEligibilityStatus.Disabled,
                MayAttemptCredentialVerification: false,
                Reason: "Identity is disabled."),
            IdentityLifecycleState.Archived or IdentityLifecycleState.Deleted => new AuthenticationEligibilityResult(
                Guid.Empty,
                lifecycleState,
                AuthenticationEligibilityStatus.Archived,
                MayAttemptCredentialVerification: false,
                Reason: "Identity is archived."),
            _ => new AuthenticationEligibilityResult(
                Guid.Empty,
                lifecycleState,
                AuthenticationEligibilityStatus.Denied,
                MayAttemptCredentialVerification: false,
                Reason: "Identity lifecycle state is not eligible.")
        };
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

public sealed record PersistenceModelSummary(
    string SchemaName,
    string SchemaArtifact,
    IReadOnlyCollection<string> RequiredTables,
    IReadOnlyCollection<string> RepositoryContracts,
    bool LoginIdUnique,
    bool LoginIdImmutable,
    bool HardDeletesAllowed,
    bool CredentialStorageSeparated,
    bool BusinessHierarchyExcluded,
    bool TriggerEnforcementDeferred);

public sealed record CredentialModelSummary(
    bool PasswordsOptional,
    bool MultipleCredentialsPerIdentity,
    bool IndividualCredentialDisableSupported,
    bool SecretMaterialReturnedByNormalQueries,
    bool VerificationImplemented,
    bool SecretStorageSeparated,
    IReadOnlyCollection<string> CredentialModels);

public sealed record TokenModelSummary(
    bool JwtSupportedByModel,
    bool OpaqueReferenceSupportedByModel,
    bool TokenIssuanceImplemented,
    bool TokenIntrospectionImplemented,
    bool TokenRevocationModeled,
    bool RefreshTokenRotationModeled,
    bool SigningKeyRotationModeled,
    IReadOnlyCollection<string> TokenModels);

public sealed record SchemaStatusSummary(
    bool SchemaArtifactPresent,
    bool SchemaApplied,
    int RequiredTableCount,
    bool TriggerEnforcementDeferred,
    bool MigrationAllowed,
    IReadOnlyCollection<string> Reasons,
    DateTimeOffset GeneratedAt);

public sealed record CredentialVerificationModelSummary(
    bool ProviderBasedVerification,
    bool ProductionVerificationImplemented,
    bool SessionCreationAllowed,
    bool TokenIssuanceAllowed,
    IReadOnlyCollection<string> Flow,
    IReadOnlyCollection<string> VerifierContracts,
    IReadOnlyCollection<string> ResultStatuses,
    IReadOnlyCollection<string> FailureReasons,
    IReadOnlyCollection<string> RiskFlags,
    bool SecretValuesExposed);

public sealed record AuthenticationEligibilityReport(
    bool LifecycleGateRequired,
    bool ActiveMayProceed,
    IReadOnlyCollection<string> DeniedStates,
    IReadOnlyCollection<AuthenticationEligibilityResult> StructuredOutcomes,
    DateTimeOffset GeneratedAt);

public sealed record CredentialVerifierCatalog(
    IReadOnlyCollection<CredentialVerifierDescriptor> Verifiers,
    bool ProductionVerificationImplemented,
    CredentialVerificationStatus DefaultUnsupportedResult,
    bool SecretValuesExposed,
    DateTimeOffset GeneratedAt);

public sealed record CredentialVerifierDescriptor(
    string CredentialType,
    string InterfaceName,
    bool ProductionVerifierImplemented,
    bool PlaceholderOnly);
