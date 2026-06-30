using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class EvaluationOrchestrator
{
    private readonly GameModuleRegistry gameModuleRegistry;
    private readonly DrawSchedulerService drawSchedulerService;
    private readonly BatchPlanner batchPlanner = new();
    private readonly BatchCheckpointService checkpointService = new();
    private readonly EvaluationProgressService progressService = new();
    private readonly List<EvaluationRunDefinition> runs = [];
    private readonly List<EvaluationBatchDefinition> batches = [];
    private readonly List<EvaluationCheckpoint> checkpoints = [];
    private readonly List<EvaluationRecordDefinition> records = [];

    public EvaluationOrchestrator(GameModuleRegistry gameModuleRegistry, DrawSchedulerService drawSchedulerService)
    {
        this.gameModuleRegistry = gameModuleRegistry;
        this.drawSchedulerService = drawSchedulerService;
        SeedRun();
    }

    public IReadOnlyCollection<EvaluationRunDefinition> GetRuns() => runs.ToArray();

    public EvaluationRunDefinition? GetRun(Guid id) => runs.FirstOrDefault(run => run.Id == id);

    public IReadOnlyCollection<EvaluationBatchDefinition> GetBatches(Guid runId)
    {
        return batches.Where(batch => batch.EvaluationRunId == runId).OrderBy(batch => batch.Sequence).ToArray();
    }

    public EvaluationBatchDefinition? GetBatch(Guid id) => batches.FirstOrDefault(batch => batch.Id == id);

    public IReadOnlyCollection<EvaluationCheckpoint> GetCheckpoints(Guid runId)
    {
        return checkpoints.Where(checkpoint => checkpoint.RunId == runId).ToArray();
    }

    public IReadOnlyCollection<EvaluationRecordDefinition> GetRecords(Guid runId)
    {
        return records.Where(record => record.EvaluationRunId == runId).ToArray();
    }

    public EvaluationRunDefinition PlanRun(EvaluationPlanRequest request)
    {
        var preconditions = ValidatePreconditions(request);
        var batchSize = request.GameSpecificBatchSize is > 0 ? request.GameSpecificBatchSize.Value : BatchPlanner.GlobalDefaultBatchSize;
        var batchCount = request.EligibleTicketCount == 0
            ? 0
            : (int)Math.Ceiling(request.EligibleTicketCount / (decimal)batchSize);
        var status = preconditions.Count == 0 ? EvaluationRunStatus.Planned : EvaluationRunStatus.ManualReviewRequired;
        var runId = EvaluationIds.Run(request);
        var run = new EvaluationRunDefinition(
            runId,
            request.DrawId,
            request.GameBindingId,
            request.OfficialCertifiedResultId,
            request.GameModuleId,
            request.GameModuleVersion,
            request.EvaluationVersion,
            status,
            batchSize,
            request.EligibleTicketCount,
            batchCount,
            DateTimeOffset.UtcNow,
            StartedAt: null,
            CompletedAt: null,
            preconditions);

        runs.RemoveAll(existing => existing.Id == run.Id);
        batches.RemoveAll(batch => batch.EvaluationRunId == run.Id);
        checkpoints.RemoveAll(checkpoint => checkpoint.RunId == run.Id);
        runs.Add(run);
        PlanBatches(run);
        return run;
    }

    public EvaluationRunDefinition StartRun(Guid runId)
    {
        var run = GetRun(runId) ?? throw new InvalidOperationException("Evaluation run not found.");
        if (run.Status is not EvaluationRunStatus.Planned and not EvaluationRunStatus.RetryPending)
        {
            return run;
        }

        var updated = run with
        {
            Status = EvaluationRunStatus.InProgress,
            StartedAt = DateTimeOffset.UtcNow
        };
        ReplaceRun(updated);
        return updated;
    }

    public EvaluationRunDefinition RetryRun(Guid runId)
    {
        var run = GetRun(runId) ?? throw new InvalidOperationException("Evaluation run not found.");
        var updated = run with
        {
            Status = EvaluationRunStatus.RetryPending
        };
        ReplaceRun(updated);

        foreach (var batch in GetBatches(runId).Where(batch => batch.Status is EvaluationBatchStatus.Failed or EvaluationBatchStatus.RetryPending))
        {
            RetryBatch(batch.Id);
        }

        return updated;
    }

    public EvaluationBatchDefinition RetryBatch(Guid batchId)
    {
        var batch = GetBatch(batchId) ?? throw new InvalidOperationException("Evaluation batch not found.");
        var updated = batch with
        {
            Status = EvaluationBatchStatus.RetryPending,
            RetryCount = batch.RetryCount + 1
        };
        ReplaceBatch(updated);
        UpsertCheckpoint(updated, EvaluationCheckpointStatus.RetryPending, processedCount: 0, failedCount: 0);
        return updated;
    }

    public EvaluationBatchDefinition ClaimBatch(Guid batchId)
    {
        var batch = GetBatch(batchId) ?? throw new InvalidOperationException("Evaluation batch not found.");
        if (batch.Status == EvaluationBatchStatus.Completed)
        {
            return batch;
        }

        var updated = batch with
        {
            Status = EvaluationBatchStatus.InProgress,
            ClaimedAt = DateTimeOffset.UtcNow
        };
        ReplaceBatch(updated);
        UpsertCheckpoint(updated, EvaluationCheckpointStatus.InProgress, processedCount: 0, failedCount: 0);
        return updated;
    }

    public EvaluationRecordAttemptResult RecordEvaluation(
        Guid runId,
        Guid batchId,
        EvaluationRecordIdempotencyKey key,
        GameEvaluationOutcome outcome)
    {
        var existing = records.FirstOrDefault(record => record.IdempotencyKey == key);
        if (existing is not null)
        {
            return new EvaluationRecordAttemptResult(EvaluationDuplicateStatus.DuplicateReturnedExisting, existing);
        }

        var record = new EvaluationRecordDefinition(
            EvaluationIds.Record(key),
            runId,
            batchId,
            key,
            outcome,
            $"hash:{key.TicketId:N}:{key.EvaluationVersion}",
            new Dictionary<string, object?> { ["financiallyApplied"] = false },
            DateTimeOffset.UtcNow);
        records.Add(record);
        return new EvaluationRecordAttemptResult(EvaluationDuplicateStatus.Created, record);
    }

    public EvaluationProgress GetProgress(Guid runId)
    {
        var run = GetRun(runId) ?? throw new InvalidOperationException("Evaluation run not found.");
        var runBatches = GetBatches(runId);
        return progressService.GetProgress(run, runBatches, GetRecords(runId).Count);
    }

    public EvaluationBatchDefinition CompleteBatch(Guid batchId, int processedCount, string lastProcessedMarker)
    {
        var batch = GetBatch(batchId) ?? throw new InvalidOperationException("Evaluation batch not found.");
        var updated = batch with
        {
            Status = EvaluationBatchStatus.Completed,
            CompletedAt = DateTimeOffset.UtcNow
        };
        ReplaceBatch(updated);
        checkpoints.RemoveAll(checkpoint => checkpoint.BatchId == updated.Id);
        checkpoints.Add(checkpointService.Create(updated with { CheckpointCursor = lastProcessedMarker }, EvaluationCheckpointStatus.Completed, processedCount, failedCount: 0));
        RefreshRunTerminalStatus(updated.EvaluationRunId);
        return updated;
    }

    public EvaluationBatchDefinition FailBatch(Guid batchId, string reason)
    {
        var batch = GetBatch(batchId) ?? throw new InvalidOperationException("Evaluation batch not found.");
        var updated = batch with
        {
            Status = EvaluationBatchStatus.Failed
        };
        ReplaceBatch(updated);
        UpsertCheckpoint(updated, EvaluationCheckpointStatus.Failed, processedCount: 0, failedCount: 1);
        RefreshRunTerminalStatus(updated.EvaluationRunId, reason);
        return updated;
    }

    public IReadOnlyCollection<EvaluationBatchWorkItem> GetWorkItems(Guid runId)
    {
        var run = GetRun(runId) ?? throw new InvalidOperationException("Evaluation run not found.");
        return GetBatches(runId).Select(batch => CreateWorkItem(run, batch, Guid.NewGuid(), Guid.NewGuid())).ToArray();
    }

    public EvaluationBatchWorkItem CreateWorkItem(EvaluationRunDefinition run, EvaluationBatchDefinition batch, Guid correlationId, Guid causationId)
    {
        return new EvaluationBatchWorkItem(
            run.Id,
            batch.Id,
            run.DrawId,
            run.GameBindingId,
            run.GameModuleId,
            run.GameModuleVersion,
            run.EvaluationVersion,
            batch.RetryCount + 1,
            correlationId,
            causationId,
            $"evaluation:{run.Id:N}:{batch.Id:N}:{batch.RetryCount + 1}",
            EvaluationQueueNames.BatchRequested,
            DateTimeOffset.UtcNow);
    }

    public EvaluationOrchestratorStatus GetStatus()
    {
        return new EvaluationOrchestratorStatus(
            EvaluationOrchestratorHealth.Warning,
            runs.Count,
            batches.Count,
            records.Count,
            checkpoints.Count,
            ProductionRabbitMqWiringEnabled: false,
            SettlementIntegrationEnabled: false,
            [
                "Evaluation execution state is in-memory only.",
                "Production RabbitMQ batch processing is deferred.",
                "Settlement consumption integration is disabled."
            ],
            DateTimeOffset.UtcNow);
    }

    private void PlanBatches(EvaluationRunDefinition run)
    {
        foreach (var batch in batchPlanner.Plan(run))
        {
            batches.Add(batch);
            UpsertCheckpoint(batch, EvaluationCheckpointStatus.Pending, processedCount: 0, failedCount: 0);
        }
    }

    private IReadOnlyCollection<string> ValidatePreconditions(EvaluationPlanRequest request)
    {
        var blockers = new List<string>();
        if (request.OfficialCertifiedResultId == Guid.Empty)
        {
            blockers.Add("Official Certified Result is required before evaluation planning.");
        }

        if (gameModuleRegistry.GetGameBinding(request.GameBindingId) is null)
        {
            blockers.Add("Game binding was not found.");
        }

        var module = gameModuleRegistry.GetModule(request.GameModuleId);
        if (module is null)
        {
            blockers.Add("Game Module was not found.");
        }
        else if (!string.Equals(module.ModuleVersion, request.GameModuleVersion, StringComparison.OrdinalIgnoreCase))
        {
            blockers.Add("Game Module version is not valid for the request.");
        }

        var lifecycle = drawSchedulerService.GetLifecycle(request.DrawId);
        if (lifecycle is null)
        {
            blockers.Add("Draw lifecycle record was not found.");
        }
        else if (lifecycle.Status is DrawLifecycleStatus.Scheduled or DrawLifecycleStatus.SalesOpen or DrawLifecycleStatus.SalesClosed)
        {
            blockers.Add("Draw lifecycle does not permit evaluation yet.");
        }

        if (request.EligibleTicketCount < 0)
        {
            blockers.Add("Eligible ticket count cannot be negative.");
        }

        return blockers;
    }

    private void UpsertCheckpoint(EvaluationBatchDefinition batch, EvaluationCheckpointStatus status, int processedCount, int failedCount)
    {
        checkpoints.RemoveAll(checkpoint => checkpoint.BatchId == batch.Id);
        checkpoints.Add(checkpointService.Create(batch, status, processedCount, failedCount));
    }

    private void ReplaceRun(EvaluationRunDefinition run)
    {
        runs.RemoveAll(existing => existing.Id == run.Id);
        runs.Add(run);
    }

    private void ReplaceBatch(EvaluationBatchDefinition batch)
    {
        batches.RemoveAll(existing => existing.Id == batch.Id);
        batches.Add(batch);
    }

    private void SeedRun()
    {
        var binding = gameModuleRegistry.GetGameBindings().First();
        var module = gameModuleRegistry.GetRegisteredModules().First();
        var draw = drawSchedulerService.GetLifecycle()
            .Where(lifecycle => lifecycle.Status is DrawLifecycleStatus.AwaitingResult or DrawLifecycleStatus.ManualReviewRequired)
            .OrderBy(lifecycle => lifecycle.DrawAt)
            .First();
        var run = PlanRun(new EvaluationPlanRequest(
            draw.DrawId,
            binding.Id,
            EvaluationIds.PlaceholderOfficialResult(draw.DrawId),
            EligibleTicketCount: 250,
            GameSpecificBatchSize: 75,
            module.ModuleId,
            module.ModuleVersion,
            "evaluation-v0"));
        var started = StartRun(run.Id);
        var firstBatch = GetBatches(started.Id).First();
        RecordEvaluation(
            started.Id,
            firstBatch.Id,
            new EvaluationRecordIdempotencyKey(
                draw.DrawId,
                EvaluationIds.StableGuid("placeholder-ticket-1"),
                binding.Id,
                module.ModuleId,
                module.ModuleVersion,
                "evaluation-v0"),
            GameEvaluationOutcome.Pending);
    }

    private void RefreshRunTerminalStatus(Guid runId, string? failureReason = null)
    {
        var run = GetRun(runId) ?? throw new InvalidOperationException("Evaluation run not found.");
        var runBatches = GetBatches(runId);
        if (runBatches.Count == 0)
        {
            return;
        }

        var nextStatus = run.Status;
        if (runBatches.All(batch => batch.Status == EvaluationBatchStatus.Completed))
        {
            nextStatus = EvaluationRunStatus.Completed;
        }
        else if (runBatches.Any(batch => batch.Status == EvaluationBatchStatus.Failed))
        {
            nextStatus = runBatches.Any(batch => batch.Status == EvaluationBatchStatus.Completed)
                ? EvaluationRunStatus.PartiallyCompleted
                : EvaluationRunStatus.Failed;
        }

        if (nextStatus != run.Status || failureReason is not null)
        {
            ReplaceRun(run with
            {
                Status = nextStatus,
                CompletedAt = nextStatus == EvaluationRunStatus.Completed ? DateTimeOffset.UtcNow : run.CompletedAt,
                Preconditions = failureReason is null ? run.Preconditions : run.Preconditions.Concat([failureReason]).ToArray()
            });
        }
    }
}
