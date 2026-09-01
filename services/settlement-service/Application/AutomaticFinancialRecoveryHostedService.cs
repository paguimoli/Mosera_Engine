using SettlementService.Configuration;
using SettlementService.Infrastructure;

namespace SettlementService.Application;

public sealed record AutomaticFinancialRecoverySnapshot(
    bool Enabled,
    bool Leader,
    bool Healthy,
    DateTimeOffset? LastCycleStartedAt,
    DateTimeOffset? LastCycleCompletedAt,
    int CandidateCount,
    int CompletedCount,
    int DeferredCount,
    int FailedClosedCount,
    int IncompleteSettlementBacklog,
    int IncompleteInstructionBacklog,
    string? LastError);

public sealed class AutomaticFinancialRecoveryState(ServiceConfiguration configuration)
{
    private readonly object gate = new();
    private AutomaticFinancialRecoverySnapshot snapshot = new(
        configuration.Runtime.AutomaticRecoveryEnabled,
        false,
        true,
        null,
        null,
        0,
        0,
        0,
        0,
        0,
        0,
        null);

    public AutomaticFinancialRecoverySnapshot Snapshot()
    {
        lock (gate)
        {
            return snapshot;
        }
    }

    public void Started(bool leader, DateTimeOffset startedAt)
    {
        lock (gate)
        {
            snapshot = snapshot with
            {
                Leader = leader,
                Healthy = true,
                LastCycleStartedAt = startedAt,
                LastError = null
            };
        }
    }

    public void Completed(
        DateTimeOffset completedAt,
        int candidateCount,
        int completedCount,
        int deferredCount,
        int failedClosedCount,
        AutomaticFinancialRecoveryBacklog backlog)
    {
        lock (gate)
        {
            snapshot = snapshot with
            {
                Healthy = true,
                LastCycleCompletedAt = completedAt,
                CandidateCount = candidateCount,
                CompletedCount = completedCount,
                DeferredCount = deferredCount,
                FailedClosedCount = failedClosedCount,
                IncompleteSettlementBacklog = backlog.IncompleteSettlements,
                IncompleteInstructionBacklog = backlog.IncompleteInstructions,
                LastError = null
            };
        }
    }

    public void Failed(Exception error)
    {
        lock (gate)
        {
            snapshot = snapshot with
            {
                Healthy = false,
                Leader = false,
                LastCycleCompletedAt = DateTimeOffset.UtcNow,
                LastError = error.Message
            };
        }
    }
}

public sealed class AutomaticFinancialRecoveryHostedService(
    ServiceConfiguration configuration,
    FinancialInstructionRepository repository,
    SettlementRecoveryService recoveryService,
    AutomaticFinancialRecoveryState state,
    ILogger<AutomaticFinancialRecoveryHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!configuration.Runtime.AutomaticRecoveryEnabled)
        {
            logger.LogInformation("Automatic financial recovery is disabled by configuration.");
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var startedAt = DateTimeOffset.UtcNow;
                var leader = await repository.RunWithAutomaticRecoveryLeaderLeaseAsync(
                    async cancellationToken => await RunLeaderCycleAsync(startedAt, cancellationToken),
                    stoppingToken);
                if (!leader)
                {
                    state.Started(false, startedAt);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                state.Failed(error);
                logger.LogWarning(error, "Automatic financial recovery cycle failed and will retry.");
            }

            try
            {
                await Task.Delay(
                    TimeSpan.FromMilliseconds(configuration.Runtime.AutomaticRecoveryIntervalMs),
                    stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    private async Task RunLeaderCycleAsync(
        DateTimeOffset startedAt,
        CancellationToken cancellationToken)
    {
        state.Started(true, startedAt);
        var candidates = await repository.ListAutomaticRecoveryCandidateSettlementIdsAsync(
            configuration.Runtime.AutomaticRecoveryBatchSize,
            configuration.Runtime.AutomaticRecoveryGraceMs,
            cancellationToken);
        var results = new System.Collections.Concurrent.ConcurrentBag<AutomaticSettlementRecoveryResult>();
        await Parallel.ForEachAsync(
            candidates,
            new ParallelOptions
            {
                CancellationToken = cancellationToken,
                MaxDegreeOfParallelism = configuration.Runtime.AutomaticRecoveryConcurrency
            },
            async (settlementId, itemCancellationToken) =>
            {
                var result = await recoveryService.RecoverAutomaticallyAsync(
                    settlementId,
                    configuration.Runtime.AutomaticRecoveryMaxAttempts,
                    $"automatic-financial-recovery:{settlementId:N}",
                    itemCancellationToken);
                results.Add(result);
            });
        var backlog = await repository.GetAutomaticRecoveryBacklogAsync(cancellationToken);
        state.Completed(
            DateTimeOffset.UtcNow,
            candidates.Count,
            results.Count(item => item.Status == AutomaticSettlementRecoveryStatus.Completed),
            results.Count(item => item.Status == AutomaticSettlementRecoveryStatus.Deferred),
            results.Count(item => item.Status == AutomaticSettlementRecoveryStatus.FailedClosed),
            backlog);

        if (candidates.Count > 0 || backlog.IncompleteInstructions > 0)
        {
            logger.LogInformation(
                "Automatic financial recovery cycle processed {CandidateCount} candidates; " +
                "completed={CompletedCount}, deferred={DeferredCount}, failedClosed={FailedClosedCount}, " +
                "incompleteInstructions={IncompleteInstructionBacklog}.",
                candidates.Count,
                results.Count(item => item.Status == AutomaticSettlementRecoveryStatus.Completed),
                results.Count(item => item.Status == AutomaticSettlementRecoveryStatus.Deferred),
                results.Count(item => item.Status == AutomaticSettlementRecoveryStatus.FailedClosed),
                backlog.IncompleteInstructions);
        }
    }
}
