using GameEngine.Api.Configuration;
using GameEngine.Application.Services;

namespace GameEngine.Api.Infrastructure;

public sealed class CanonicalOutcomeRecoveryHostedService(
    ServiceConfiguration configuration,
    CanonicalDrawOrchestrator orchestrator,
    ILogger<CanonicalOutcomeRecoveryHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!configuration.CanonicalOutcomePipelineEnabled ||
            !configuration.CanonicalOutcomeRecoveryEnabled)
        {
            logger.LogInformation("Canonical Outcome missing-request recovery is disabled.");
            return;
        }

        await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        do
        {
            try
            {
                var result = await orchestrator.RecoverAsync(25, stoppingToken);
                if (result.RequestsCreated > 0 || result.EventsRequeued > 0 || result.BlockedCount > 0)
                {
                    logger.LogInformation(
                        "Canonical Outcome recovery scanned {MissingCount} missing requests, created {CreatedCount}, requeued {RequeuedCount}, blocked {BlockedCount}.",
                        result.MissingRequestCount,
                        result.RequestsCreated,
                        result.EventsRequeued,
                        result.BlockedCount);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                logger.LogError(error, "Canonical Outcome missing-request recovery failed closed.");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
