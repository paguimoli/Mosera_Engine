using GameEngine.Domain.Model;
using GameEngine.Domain.Modules;
using GameEngine.Modules.HotSpot;
using GameEngine.Modules.TestModule;

namespace GameEngine.Application.Services;

public sealed class GameEngineStatusService
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
        return ListModuleStatuses().Select(status => status.Manifest).ToArray();
    }

    public IReadOnlyCollection<GameModuleStatus> ListModuleStatuses()
    {
        return
        [
            BuildModuleStatus(new HotSpotModule()),
            BuildModuleStatus(new TestGameModule())
        ];
    }

    public IReadOnlyCollection<DrawAuthority> ListDrawAuthorities()
    {
        return [];
    }

    public IReadOnlyCollection<GameEvaluationRun> ListEvaluationRuns()
    {
        return [];
    }

    private static GameModuleStatus BuildModuleStatus<TModule>(TModule module)
        where TModule :
            IGameModule,
            IGameConfigurationValidator,
            IGameTicketValidator,
            IGameEvaluator,
            IGameModuleHealthCheck,
            IGameModuleFixtureProvider
    {
        var gate = GameModuleLifecycleGate.Evaluate(module, module, module, module, module, module);
        var health = module.HealthCheck();

        return new GameModuleStatus(
            module.GetManifest(),
            health.Status,
            gate.ProductionReady,
            gate.Blockers,
            gate.Warnings,
            DateTimeOffset.UtcNow);
    }
}

public sealed record GameEngineStatus(
    string Service,
    string Phase,
    bool ProductionGameLogicEnabled,
    bool ProductionRngEnabled,
    bool SettlementIntegrationEnabled,
    DateTimeOffset GeneratedAt);
