using GameEngine.Application.Services;

namespace GameEngine.Api.Configuration;

public sealed record DurableSchedulerConfiguration(
    bool HostedRuntimeEnabled,
    bool ProductionExecutionEnabled,
    int FastKenoHorizonMinutes,
    int HotSpotHorizonHours,
    int RecoveryWindowMinutes,
    int ClaimLeaseSeconds,
    int PollIntervalMilliseconds)
{
    public static DurableSchedulerConfiguration FromEnvironment() => new(
        IsTrue("GAME_ENGINE_DURABLE_SCHEDULER_ENABLED"),
        IsTrue("GAME_ENGINE_DURABLE_SCHEDULER_PRODUCTION_EXECUTION_ENABLED"),
        ReadBoundedInt("GAME_ENGINE_FAST_KENO_SCHEDULER_HORIZON_MINUTES", 15, 5, 120),
        ReadBoundedInt("GAME_ENGINE_HOT_SPOT_SCHEDULER_HORIZON_HOURS", 24, 4, 72),
        ReadBoundedInt("GAME_ENGINE_SCHEDULER_RECOVERY_WINDOW_MINUTES", 10, 1, 60),
        ReadBoundedInt("GAME_ENGINE_SCHEDULER_CLAIM_LEASE_SECONDS", 20, 5, 120),
        ReadBoundedInt("GAME_ENGINE_SCHEDULER_POLL_INTERVAL_MS", 2000, 250, 30000));

    public DurableSchedulerOptions ToOptions() => new(
        HostedRuntimeEnabled,
        ProductionExecutionEnabled,
        TimeSpan.FromMinutes(FastKenoHorizonMinutes),
        TimeSpan.FromHours(HotSpotHorizonHours),
        TimeSpan.FromMinutes(RecoveryWindowMinutes),
        TimeSpan.FromSeconds(ClaimLeaseSeconds),
        TimeSpan.FromMilliseconds(PollIntervalMilliseconds));

    private static bool IsTrue(string name) => string.Equals(
        Environment.GetEnvironmentVariable(name),
        "true",
        StringComparison.OrdinalIgnoreCase);

    private static int ReadBoundedInt(string name, int fallback, int minimum, int maximum)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }
        if (!int.TryParse(raw, out var parsed) || parsed < minimum || parsed > maximum)
        {
            throw new InvalidOperationException($"{name} must be an integer between {minimum} and {maximum}.");
        }
        return parsed;
    }
}
