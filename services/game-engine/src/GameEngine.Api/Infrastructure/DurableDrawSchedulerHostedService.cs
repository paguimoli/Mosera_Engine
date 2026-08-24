using GameEngine.Api.Configuration;
using GameEngine.Application.Services;

namespace GameEngine.Api.Infrastructure;

public sealed class DurableDrawSchedulerHostedService(
    DurableSchedulerRuntime runtime,
    DurableSchedulerConfiguration configuration,
    ILogger<DurableDrawSchedulerHostedService> logger) : BackgroundService
{
    private readonly string ownerId = $"{Environment.MachineName}:{Environment.ProcessId}:{Guid.NewGuid():N}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!configuration.HostedRuntimeEnabled)
        {
            logger.LogInformation(
                "Durable scheduler registered but disabled; pilot products remain inactive and unassigned.");
            return;
        }

        logger.LogInformation(
            "Durable scheduler started with owner {OwnerId}; production execution enabled={ProductionExecutionEnabled}",
            ownerId,
            configuration.ProductionExecutionEnabled);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var result = await runtime.RunCycleAsync(ownerId, stoppingToken);
                logger.LogInformation(
                    "Durable scheduler cycle completed: eligible={Eligible}, materialized={Materialized}, due={Due}, claimed={Claimed}, recovery={Recovery}",
                    result.EligibleScheduleCount,
                    result.MaterializedDrawCount,
                    result.DueDrawCount,
                    result.ClaimedDrawCount,
                    result.RecoveryRequiredCount);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                logger.LogError(error, "Durable scheduler cycle failed closed; the next bounded retry will re-read durable state.");
            }

            await Task.Delay(TimeSpan.FromMilliseconds(configuration.PollIntervalMilliseconds), stoppingToken);
        }
    }
}
