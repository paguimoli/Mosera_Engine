using GameEngine.Api.Configuration;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;

namespace GameEngine.Api.Infrastructure;

public sealed class CanonicalOutcomeRecoveryHostedService(
    ServiceConfiguration configuration,
    CanonicalOutcomeLifecycleAuthority lifecycleAuthority,
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
        string? lastBlockedSignature = null;
        var lastBlockedSummaryAt = DateTimeOffset.MinValue;
        do
        {
            try
            {
                var result = await lifecycleAuthority.RecoverAsync(
                    new CanonicalOutcomeRecoveryCommand(
                        25,
                        "system:canonical-outcome-recovery",
                        "AUTOMATED_INCOMPLETE_OPERATION_RECOVERY",
                        "canonical-outcome-recovery",
                        "hosted-service:canonical-outcome-recovery"),
                    stoppingToken);
                var blockedSignature = result.BlockedCount == 0
                    ? null
                    : string.Join("|", result.Blockers.Order(StringComparer.Ordinal));
                var blockedSummaryDue = result.BlockedCount > 0 &&
                    (blockedSignature != lastBlockedSignature ||
                     DateTimeOffset.UtcNow - lastBlockedSummaryAt >= TimeSpan.FromMinutes(15));
                if (result.RequestsCreated > 0 || result.EventsRequeued > 0 || blockedSummaryDue)
                {
                    logger.LogInformation(
                        "Canonical Outcome recovery scanned {MissingCount} missing requests, created {CreatedCount}, requeued {RequeuedCount}, blocked {BlockedCount}.",
                        result.MissingRequestCount,
                        result.RequestsCreated,
                        result.EventsRequeued,
                        result.BlockedCount);
                }
                if (blockedSummaryDue)
                {
                    lastBlockedSignature = blockedSignature;
                    lastBlockedSummaryAt = DateTimeOffset.UtcNow;
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
