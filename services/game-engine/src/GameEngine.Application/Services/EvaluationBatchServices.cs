using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class BatchPlanner
{
    public const int GlobalDefaultBatchSize = 100;

    public IReadOnlyCollection<EvaluationBatchDefinition> Plan(EvaluationRunDefinition run)
    {
        var planned = new List<EvaluationBatchDefinition>();
        for (var sequence = 0; sequence < run.PlannedBatchCount; sequence += 1)
        {
            var start = sequence * run.BatchSize;
            var end = Math.Min(start + run.BatchSize, run.EligibleTicketCount);
            planned.Add(new EvaluationBatchDefinition(
                EvaluationIds.Batch(run.Id, sequence, start, end),
                run.Id,
                sequence,
                start,
                end,
                EvaluationBatchStatus.Pending,
                $"ticket-offset:{start}",
                RetryCount: 0,
                DateTimeOffset.UtcNow,
                ClaimedAt: null,
                CompletedAt: null));
        }

        return planned;
    }
}

public sealed class BatchCheckpointService
{
    public EvaluationCheckpoint Create(
        EvaluationBatchDefinition batch,
        EvaluationCheckpointStatus status,
        int processedCount,
        int failedCount)
    {
        return new EvaluationCheckpoint(
            batch.EvaluationRunId,
            batch.Id,
            $"{batch.StartInclusive}:{batch.EndExclusive}",
            status,
            processedCount,
            failedCount,
            batch.RetryCount,
            batch.CheckpointCursor,
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow);
    }
}

public sealed class EvaluationProgressService
{
    public EvaluationProgress GetProgress(
        EvaluationRunDefinition run,
        IReadOnlyCollection<EvaluationBatchDefinition> batches,
        int evaluationRecordCount)
    {
        var completed = batches.Count(batch => batch.Status == EvaluationBatchStatus.Completed);
        var failed = batches.Count(batch => batch.Status == EvaluationBatchStatus.Failed);
        var retryPending = batches.Count(batch => batch.Status == EvaluationBatchStatus.RetryPending);
        var percent = run.PlannedBatchCount == 0 ? 100 : decimal.Round(completed / (decimal)run.PlannedBatchCount * 100, 2);
        return new EvaluationProgress(
            run.Id,
            run.Status,
            run.PlannedBatchCount,
            completed,
            failed,
            retryPending,
            evaluationRecordCount,
            percent,
            DateTimeOffset.UtcNow);
    }
}

public static class EvaluationIds
{
    public static Guid Run(EvaluationPlanRequest request)
    {
        return StableGuid($"evaluation-run:{request.DrawId}:{request.GameBindingId}:{request.OfficialCertifiedResultId}:{request.EvaluationVersion}");
    }

    public static Guid Batch(Guid runId, int sequence, int startInclusive, int endExclusive)
    {
        return StableGuid($"evaluation-batch:{runId}:{sequence}:{startInclusive}:{endExclusive}");
    }

    public static Guid Record(EvaluationRecordIdempotencyKey key)
    {
        return StableGuid($"evaluation-record:{key.DrawId}:{key.TicketId}:{key.GameId}:{key.GameModuleId}:{key.GameModuleVersion}:{key.EvaluationVersion}");
    }

    public static Guid PlaceholderOfficialResult(Guid drawId)
    {
        return StableGuid($"official-certified-result:{drawId}");
    }

    public static Guid StableGuid(string input)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(input));
        return new Guid(bytes[..16]);
    }
}
