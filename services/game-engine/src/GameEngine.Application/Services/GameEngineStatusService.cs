using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class GameEngineStatusService(GameModuleRegistry registry)
{
    public GameEngineStatus GetStatus()
    {
        return new GameEngineStatus(
            "game-engine",
            "SKELETON",
            ProductionGameLogicEnabled: false,
            ProductionRngEnabled: false,
            SettlementIntegrationEnabled: false,
            DateTimeOffset.UtcNow);
    }

    public IReadOnlyCollection<GameModuleManifest> ListModules()
    {
        return registry.GetRegisteredModules()
            .Select(entry => new GameModuleManifest(
                entry.ModuleId,
                entry.ModuleName,
                entry.ModuleVersion,
                entry.SupportedGameTypes,
                entry.SupportedWagerTypes,
                entry.SupportedDrawAuthorities,
                entry.DrawGenerationCapability,
                SupportsExternalResultEvaluation: true,
                SupportsManualResultEvaluation: entry.SupportedDrawAuthorities.Contains(DrawProviderType.ManualCertifiedEntry),
                entry.ConfigurationSchemaVersion,
                EvaluatorVersion: "registered",
                DrawGeneratorVersion: entry.DrawGenerationCapability ? "registered" : "not-supported",
                MinimumGameEngineVersion: "0.1.0",
                entry.LifecycleStatus,
                Checksum: entry.Validation.IsValid ? "registered" : "invalid",
                entry.LoadTimestamp,
                entry.LoadedAssembly))
            .ToArray();
    }

    public IReadOnlyCollection<GameModuleStatus> ListModuleStatuses()
    {
        return registry.GetRegisteredModules()
            .Select(entry => new GameModuleStatus(
                new GameModuleManifest(
                    entry.ModuleId,
                    entry.ModuleName,
                    entry.ModuleVersion,
                    entry.SupportedGameTypes,
                    entry.SupportedWagerTypes,
                    entry.SupportedDrawAuthorities,
                    entry.DrawGenerationCapability,
                    SupportsExternalResultEvaluation: true,
                    SupportsManualResultEvaluation: entry.SupportedDrawAuthorities.Contains(DrawProviderType.ManualCertifiedEntry),
                    entry.ConfigurationSchemaVersion,
                    EvaluatorVersion: "registered",
                    DrawGeneratorVersion: entry.DrawGenerationCapability ? "registered" : "not-supported",
                    MinimumGameEngineVersion: "0.1.0",
                    entry.LifecycleStatus,
                    Checksum: entry.Validation.IsValid ? "registered" : "invalid",
                    entry.LoadTimestamp,
                    entry.LoadedAssembly),
                entry.HealthStatus,
                entry.ProductionReady,
                entry.LifecycleGateBlockers,
                entry.LifecycleGateWarnings,
                entry.LoadTimestamp))
            .ToArray();
    }

    public IReadOnlyCollection<DrawAuthority> ListDrawAuthorities()
    {
        return [];
    }

    public IReadOnlyCollection<GameEvaluationRun> ListEvaluationRuns()
    {
        return [];
    }

}

public sealed record GameEngineStatus(
    string Service,
    string Phase,
    bool ProductionGameLogicEnabled,
    bool ProductionRngEnabled,
    bool SettlementIntegrationEnabled,
    DateTimeOffset GeneratedAt);
