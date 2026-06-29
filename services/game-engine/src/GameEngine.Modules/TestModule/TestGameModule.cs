using GameEngine.Domain.Model;
using GameEngine.Domain.Modules;

namespace GameEngine.Modules.TestModule;

public sealed class TestGameModule : IGameModule, IGameModuleManifestProvider, IGameModuleHealthCheck
{
    public string ModuleCode => "TEST_MODULE";

    public string GetVersion() => "0.0.0-skeleton";

    public GameModuleManifest GetMetadata()
    {
        return new GameModuleManifest(
            ModuleCode,
            GetVersion(),
            "0.1.0",
            SupportedWagers(),
            GameModuleLifecycleStatus.InternalTesting);
    }

    public IReadOnlyCollection<string> SupportedWagers()
    {
        return ["TEST_WAGER"];
    }

    public GameModuleHealthCheckResult HealthCheck()
    {
        return new GameModuleHealthCheckResult(
            GameModuleHealthStatus.Healthy,
            ModuleCode,
            GetVersion(),
            ["Skeleton module only; no production game logic is implemented."],
            DateTimeOffset.UtcNow);
    }
}
