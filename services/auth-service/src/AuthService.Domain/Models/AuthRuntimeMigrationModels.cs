namespace AuthService.Domain.Models;

public enum AuthMigrationPhaseStatus
{
    NotStarted,
    ShadowOnly,
    DualRun,
    ReadyForApproval,
    Blocked,
    Complete
}

public enum AuthCoexistenceMode
{
    LegacyAuthoritative,
    ShadowValidation,
    DualAuthentication,
    AuthServiceAuthoritative,
    LegacyRetired
}

public sealed record AuthMigrationPhase(
    int Order,
    string Name,
    AuthMigrationPhaseStatus Status,
    IReadOnlyCollection<string> SuccessCriteria,
    IReadOnlyCollection<string> RollbackCriteria,
    string ApprovalGate);

public sealed record IdentityMigrationMapping(
    string LegacySource,
    string TargetModel,
    string MappingRule,
    bool DuplicatePreventionRequired,
    bool AuditHistoryPreserved);

public sealed record CredentialMigrationMapping(
    string CredentialSource,
    string TargetCredential,
    string MigrationRule,
    bool TransparentUpgradeSupported,
    bool ForcedResetRequiredByDefault);

public sealed record SessionMigrationPlan(
    bool LegacySessionsRemainAuthoritative,
    bool ParallelValidationModeled,
    bool ControlledCutoverModeled,
    bool ForcedLogoutStrategyModeled,
    bool RollbackModeled);

public sealed record TokenMigrationPlan(
    bool LegacyTokensValidDuringCoexistence,
    bool JwtModeled,
    bool OpaqueTokensModeled,
    bool RefreshTokensModeled,
    bool ServiceTokensModeled,
    bool ExpirationStrategyModeled,
    bool RevocationStrategyModeled);

public sealed record OAuthMigrationPlan(
    IReadOnlyCollection<string> ActivationOrder,
    bool AuthorizationServerModeled,
    bool OidcModeled,
    bool ServiceAuthenticationModeled,
    bool ExternalClientMigrationModeled);

public sealed record CompatibilityLayerModel(
    bool LegacySessionValidator,
    bool LegacyTokenValidator,
    bool LegacyUserLookup,
    bool MigrationBridge,
    bool FeatureFlags,
    bool CompatibilityDiagnostics,
    bool RuntimeImplemented);

public sealed record AuthRuntimeMigrationPlan(
    AuthCoexistenceMode CurrentMode,
    IReadOnlyCollection<AuthMigrationPhase> Phases,
    IReadOnlyCollection<IdentityMigrationMapping> IdentityMappings,
    IReadOnlyCollection<CredentialMigrationMapping> CredentialMappings,
    SessionMigrationPlan SessionMigration,
    TokenMigrationPlan TokenMigration,
    OAuthMigrationPlan OAuthMigration,
    CompatibilityLayerModel CompatibilityLayer,
    bool LegacyAuthUnchanged,
    bool MigrationExecutionEnabled);
