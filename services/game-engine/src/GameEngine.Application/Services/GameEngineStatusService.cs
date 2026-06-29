using GameEngine.Domain.Model;

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
        return
        [
            new GameModuleManifest(
                "HOT_SPOT",
                "0.0.0-skeleton",
                "0.1.0",
                ["STRAIGHT"],
                GameModuleLifecycleStatus.Development),
            new GameModuleManifest(
                "TEST_MODULE",
                "0.0.0-skeleton",
                "0.1.0",
                ["TEST_WAGER"],
                GameModuleLifecycleStatus.InternalTesting)
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
}

public sealed record GameEngineStatus(
    string Service,
    string Phase,
    bool ProductionGameLogicEnabled,
    bool ProductionRngEnabled,
    bool SettlementIntegrationEnabled,
    DateTimeOffset GeneratedAt);
