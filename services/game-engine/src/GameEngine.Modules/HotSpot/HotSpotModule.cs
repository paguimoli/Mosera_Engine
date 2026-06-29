using GameEngine.Domain.Model;
using GameEngine.Domain.Modules;

namespace GameEngine.Modules.HotSpot;

public sealed class HotSpotModule : IGameModule, IGameModuleManifestProvider, IGameModuleHealthCheck
{
    public string ModuleCode => "HOT_SPOT";

    public string GetVersion() => "0.0.0-skeleton";

    public GameModuleManifest GetMetadata()
    {
        return new GameModuleManifest(
            ModuleCode,
            GetVersion(),
            "0.1.0",
            SupportedWagers(),
            GameModuleLifecycleStatus.Development);
    }

    public IReadOnlyCollection<string> SupportedWagers()
    {
        return ["STRAIGHT"];
    }

    public GameModuleHealthCheckResult HealthCheck()
    {
        return new GameModuleHealthCheckResult(
            GameModuleHealthStatus.Healthy,
            ModuleCode,
            GetVersion(),
            [],
            DateTimeOffset.UtcNow);
    }
}
