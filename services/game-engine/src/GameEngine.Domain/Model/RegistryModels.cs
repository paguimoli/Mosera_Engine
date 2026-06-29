using System.Reflection;

namespace GameEngine.Domain.Model;

public enum GameModuleRegistrationStatus
{
    Registered,
    Rejected
}

public enum GameModuleApprovalStatus
{
    NotApproved,
    Approved,
    ProductionApproved
}

public enum GameModuleRegistryHealth
{
    Healthy,
    Warning,
    Error
}

public enum GameModuleVersionSelectionMode
{
    LatestApproved,
    SpecificVersion,
    StagedRolloutPending
}

public enum GameBindingStatus
{
    Draft,
    Validated,
    Rejected,
    Active,
    Retired
}

public sealed record GameModuleRegistryEntry(
    string ModuleId,
    string ModuleName,
    string ModuleVersion,
    GameModuleLifecycleStatus LifecycleStatus,
    IReadOnlyCollection<GameType> SupportedGameTypes,
    IReadOnlyCollection<WagerType> SupportedWagerTypes,
    IReadOnlyCollection<DrawProviderType> SupportedDrawAuthorities,
    bool DrawGenerationCapability,
    string ConfigurationSchemaVersion,
    GameModuleHealthStatus HealthStatus,
    GameModuleApprovalStatus ApprovalStatus,
    bool ProductionReady,
    string LoadedAssembly,
    DateTimeOffset LoadTimestamp,
    GameModuleRegistrationStatus RegistrationStatus,
    ValidationResult Validation,
    IReadOnlyCollection<string> LifecycleGateBlockers,
    IReadOnlyCollection<string> LifecycleGateWarnings);

public sealed record GameModuleRegistryStatus(
    GameModuleRegistryHealth Health,
    int RegisteredModuleCount,
    int RejectedModuleCount,
    int ActiveModuleCount,
    int InactiveModuleCount,
    int ProductionReadyModuleCount,
    IReadOnlyCollection<string> Reasons,
    DateTimeOffset GeneratedAt);

public sealed record GameBindingVersion(
    Guid Id,
    Guid BindingId,
    string ModuleId,
    string ModuleVersion,
    DrawProviderType DrawAuthority,
    string DrawSchedule,
    SettlementTriggerPolicy SettlementTriggerPolicy,
    GameModuleVersionSelectionMode VersionSelectionMode,
    IReadOnlyDictionary<string, object?> DefaultConfiguration,
    IReadOnlyDictionary<string, object?> GameConfigurationOverrides,
    string ConfigurationHash,
    GameBindingStatus Status,
    ValidationResult Validation,
    DateTimeOffset EffectiveFrom,
    DateTimeOffset? EffectiveTo,
    DateTimeOffset CreatedAt);

public sealed record GameBinding(
    Guid Id,
    string GameCode,
    string DisplayName,
    GameType GameType,
    WagerType WagerType,
    Guid ActiveVersionId,
    IReadOnlyCollection<GameBindingVersion> Versions,
    DateTimeOffset CreatedAt);

public sealed record GameBindingRequest(
    string GameCode,
    string DisplayName,
    GameType GameType,
    WagerType WagerType,
    string ModuleId,
    GameModuleVersionSelectionMode VersionSelectionMode,
    string? SpecificModuleVersion,
    DrawProviderType DrawAuthority,
    string DrawSchedule,
    SettlementTriggerPolicy SettlementTriggerPolicy,
    IReadOnlyDictionary<string, object?> DefaultConfiguration,
    IReadOnlyDictionary<string, object?> GameConfigurationOverrides);

public sealed record GameModuleDiscoveryResult(
    IReadOnlyCollection<GameModuleRegistryEntry> RegisteredModules,
    IReadOnlyCollection<GameModuleRegistryEntry> RejectedModules,
    DateTimeOffset DiscoveredAt);
