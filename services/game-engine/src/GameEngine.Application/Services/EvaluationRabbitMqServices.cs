using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public static class EvaluationQueueNames
{
    public const string BatchRequested = "game.evaluation.batch.requested";
    public const string BatchStarted = "game.evaluation.batch.started";
    public const string BatchCompleted = "game.evaluation.batch.completed";
    public const string BatchFailed = "game.evaluation.batch.failed";
    public const string BatchRetryScheduled = "game.evaluation.batch.retry_scheduled";
    public const string BatchDeadLettered = "game.evaluation.batch.dead_lettered";
    public const string WorkerHeartbeat = "game.evaluation.worker.heartbeat";
}

public sealed class EvaluationBatchPublisher
{
    private readonly EvaluationOrchestrator orchestrator;
    private readonly bool publishingEnabled;

    public EvaluationBatchPublisher(EvaluationOrchestrator orchestrator)
    {
        this.orchestrator = orchestrator;
        publishingEnabled = string.Equals(
            Environment.GetEnvironmentVariable("GAME_ENGINE_EVALUATION_RABBITMQ_PUBLISHING_ENABLED"),
            "true",
            StringComparison.OrdinalIgnoreCase);
    }

    public bool PublishingEnabled => publishingEnabled;

    public EvaluationPublishResult PublishBatches(Guid runId, Guid correlationId)
    {
        var run = orchestrator.GetRun(runId) ?? throw new InvalidOperationException("Evaluation run not found.");
        var workItems = orchestrator.GetBatches(runId)
            .Where(batch => batch.Status is EvaluationBatchStatus.Pending or EvaluationBatchStatus.RetryPending)
            .Select(batch => orchestrator.CreateWorkItem(run, batch, correlationId, causationId: run.Id))
            .ToArray();

        return new EvaluationPublishResult(
            runId,
            run.PlannedBatchCount,
            workItems.Length,
            publishingEnabled,
            ExternalPublishAttempted: publishingEnabled,
            FinancialMutationPerformed: false,
            workItems);
    }
}

public sealed class EvaluationBatchConsumer
{
    public const int MaxAttempts = 3;
    private readonly EvaluationOrchestrator orchestrator;

    public EvaluationBatchConsumer(EvaluationOrchestrator orchestrator)
    {
        this.orchestrator = orchestrator;
    }

    public bool IsPoisonMessage(EvaluationBatchWorkItem workItem)
    {
        return workItem.RunId == Guid.Empty ||
            workItem.BatchId == Guid.Empty ||
            workItem.DrawId == Guid.Empty ||
            workItem.GameId == Guid.Empty ||
            string.IsNullOrWhiteSpace(workItem.GameModuleId) ||
            string.IsNullOrWhiteSpace(workItem.GameModuleVersion) ||
            string.IsNullOrWhiteSpace(workItem.EvaluationVersion) ||
            string.IsNullOrWhiteSpace(workItem.IdempotencyKey) ||
            workItem.AttemptNumber <= 0;
    }

    public bool IsRetryEligible(EvaluationBatchWorkItem workItem)
    {
        return !IsPoisonMessage(workItem) && workItem.AttemptNumber < MaxAttempts;
    }

    public EvaluationBatchStartedEvent CreateStartedEvent(EvaluationBatchWorkItem workItem)
    {
        return new EvaluationBatchStartedEvent(
            workItem.RunId,
            workItem.BatchId,
            workItem.DrawId,
            workItem.GameId,
            workItem.GameModuleId,
            workItem.GameModuleVersion,
            workItem.EvaluationVersion,
            workItem.AttemptNumber,
            workItem.CorrelationId,
            workItem.CausationId,
            workItem.IdempotencyKey,
            DateTimeOffset.UtcNow);
    }

    public EvaluationBatchCompletedEvent Process(EvaluationBatchWorkItem workItem)
    {
        if (IsPoisonMessage(workItem))
        {
            throw new InvalidOperationException("Poison evaluation batch work item rejected.");
        }

        orchestrator.ClaimBatch(workItem.BatchId);
        var completed = orchestrator.CompleteBatch(
            workItem.BatchId,
            processedCount: Math.Max(0, (orchestrator.GetBatch(workItem.BatchId)?.EndExclusive ?? 0) - (orchestrator.GetBatch(workItem.BatchId)?.StartInclusive ?? 0)),
            lastProcessedMarker: $"completed:{workItem.BatchId:N}:{workItem.AttemptNumber}");

        return new EvaluationBatchCompletedEvent(
            workItem.RunId,
            workItem.BatchId,
            workItem.DrawId,
            workItem.GameId,
            workItem.GameModuleId,
            workItem.GameModuleVersion,
            workItem.EvaluationVersion,
            workItem.AttemptNumber,
            workItem.CorrelationId,
            workItem.CausationId,
            workItem.IdempotencyKey,
            Math.Max(0, completed.EndExclusive - completed.StartInclusive),
            completed.CheckpointCursor,
            DateTimeOffset.UtcNow);
    }

    public EvaluationBatchFailedEvent CreateFailedEvent(EvaluationBatchWorkItem workItem, string reason)
    {
        orchestrator.FailBatch(workItem.BatchId, reason);
        return new EvaluationBatchFailedEvent(
            workItem.RunId,
            workItem.BatchId,
            workItem.DrawId,
            workItem.GameId,
            workItem.GameModuleId,
            workItem.GameModuleVersion,
            workItem.EvaluationVersion,
            workItem.AttemptNumber,
            workItem.CorrelationId,
            workItem.CausationId,
            workItem.IdempotencyKey,
            reason,
            RetryCount: workItem.AttemptNumber,
            DateTimeOffset.UtcNow);
    }

    public EvaluationBatchRetryScheduledEvent CreateRetryScheduledEvent(EvaluationBatchWorkItem workItem, string reason)
    {
        orchestrator.RetryBatch(workItem.BatchId);
        return new EvaluationBatchRetryScheduledEvent(
            workItem.RunId,
            workItem.BatchId,
            workItem.DrawId,
            workItem.GameId,
            workItem.GameModuleId,
            workItem.GameModuleVersion,
            workItem.EvaluationVersion,
            workItem.AttemptNumber + 1,
            workItem.CorrelationId,
            workItem.CausationId,
            workItem.IdempotencyKey,
            reason,
            DateTimeOffset.UtcNow);
    }

    public EvaluationBatchDeadLetteredEvent CreateDeadLetterEvent(EvaluationBatchWorkItem workItem, string reason)
    {
        return new EvaluationBatchDeadLetteredEvent(
            EvaluationIds.StableGuid($"evaluation-dlq:{workItem.IdempotencyKey}:{workItem.AttemptNumber}:{reason}"),
            workItem.RunId,
            workItem.BatchId,
            workItem.DrawId,
            workItem.GameId,
            workItem.GameModuleId,
            workItem.GameModuleVersion,
            workItem.EvaluationVersion,
            workItem.AttemptNumber,
            workItem.CorrelationId,
            workItem.CausationId,
            workItem.IdempotencyKey,
            reason,
            IsPoisonMessage(workItem),
            DateTimeOffset.UtcNow,
            ReviewedAt: null);
    }
}

public sealed class EvaluationWorkerHeartbeatService
{
    public EvaluationWorkerHeartbeatEvent CreateHeartbeat(
        string workerId,
        Guid instanceId,
        EvaluationWorkerStatus status,
        int processedBatchCount,
        int failedBatchCount)
    {
        return new EvaluationWorkerHeartbeatEvent(
            workerId,
            instanceId,
            "game-engine-skeleton",
            processedBatchCount,
            failedBatchCount,
            DateTimeOffset.UtcNow,
            status,
            Guid.NewGuid(),
            instanceId,
            $"worker:{workerId}:{instanceId:N}",
            DateTimeOffset.UtcNow);
    }
}

public sealed class EvaluationRabbitMqDiagnostics
{
    private readonly EvaluationOrchestrator orchestrator;
    private readonly EvaluationBatchPublisher publisher;
    private readonly EvaluationBatchConsumer consumer;
    private readonly EvaluationWorkerHeartbeatService heartbeatService = new();
    private readonly List<EvaluationBatchWorkItem> requested = [];
    private readonly List<EvaluationBatchStartedEvent> started = [];
    private readonly List<EvaluationBatchCompletedEvent> completed = [];
    private readonly List<EvaluationBatchFailedEvent> failed = [];
    private readonly List<EvaluationBatchRetryScheduledEvent> retryScheduled = [];
    private readonly List<EvaluationBatchDeadLetteredEvent> deadLettered = [];
    private readonly List<EvaluationWorkerHeartbeatEvent> heartbeats = [];
    private readonly HashSet<string> processedIdempotencyKeys = [];

    public EvaluationRabbitMqDiagnostics(EvaluationOrchestrator orchestrator)
    {
        this.orchestrator = orchestrator;
        publisher = new EvaluationBatchPublisher(orchestrator);
        consumer = new EvaluationBatchConsumer(orchestrator);
        SeedHeartbeat();
    }

    public IReadOnlyCollection<EvaluationQueueDiagnostic> GetQueues()
    {
        return
        [
            Queue(EvaluationQueueNames.BatchRequested, requested.Count),
            Queue(EvaluationQueueNames.BatchStarted, started.Count),
            Queue(EvaluationQueueNames.BatchCompleted, completed.Count),
            Queue(EvaluationQueueNames.BatchFailed, failed.Count),
            Queue(EvaluationQueueNames.BatchRetryScheduled, retryScheduled.Count),
            Queue(EvaluationQueueNames.BatchDeadLettered, deadLettered.Count),
            Queue(EvaluationQueueNames.WorkerHeartbeat, heartbeats.Count)
        ];
    }

    public IReadOnlyCollection<EvaluationWorkerHeartbeatEvent> GetWorkerHeartbeats() => heartbeats.ToArray();

    public IReadOnlyCollection<EvaluationWorkerHeartbeatEvent> GetWorkers()
    {
        return heartbeats
            .GroupBy(heartbeat => heartbeat.WorkerId)
            .Select(group => group.OrderByDescending(heartbeat => heartbeat.LastHeartbeatAt).First())
            .ToArray();
    }

    public IReadOnlyCollection<EvaluationBatchDeadLetteredEvent> GetDeadLetter() => deadLettered.ToArray();

    public EvaluationProcessingStatus GetProcessingStatus()
    {
        return new EvaluationProcessingStatus(
            requested.Count,
            started.Count,
            completed.Count,
            failed.Count,
            retryScheduled.Count,
            deadLettered.Count,
            heartbeats.Count,
            ProductionGameLogicEnabled: false,
            TicketDbIntegrationEnabled: false,
            SettlementIntegrationEnabled: false,
            DateTimeOffset.UtcNow);
    }

    public EvaluationPublishResult PublishBatches(Guid runId, Guid correlationId)
    {
        var result = publisher.PublishBatches(runId, correlationId);
        requested.RemoveAll(item => item.RunId == runId);
        requested.AddRange(result.WorkItems);
        SeedHeartbeat();
        return result;
    }

    public EvaluationProcessingResult ProcessFirstRequested()
    {
        var workItem = requested.FirstOrDefault();
        if (workItem is null)
        {
            return new EvaluationProcessingResult(Guid.Empty, EvaluationMessageDisposition.Rejected, "No requested evaluation batch work item is available.", false, false);
        }

        if (!processedIdempotencyKeys.Add(workItem.IdempotencyKey))
        {
            requested.Remove(workItem);
            return new EvaluationProcessingResult(workItem.BatchId, EvaluationMessageDisposition.DuplicateAck, "Duplicate work item acknowledged without reprocessing.", false, false);
        }

        if (consumer.IsPoisonMessage(workItem))
        {
            deadLettered.Add(consumer.CreateDeadLetterEvent(workItem, "Poison message detected."));
            requested.Remove(workItem);
            return new EvaluationProcessingResult(workItem.BatchId, EvaluationMessageDisposition.DeadLetter, "Poison message dead-lettered.", false, false);
        }

        started.Add(consumer.CreateStartedEvent(workItem));
        heartbeats.Add(heartbeatService.CreateHeartbeat("evaluation-worker-placeholder", Guid.NewGuid(), EvaluationWorkerStatus.Processing, completed.Count, failed.Count));
        completed.Add(consumer.Process(workItem));
        heartbeats.Add(heartbeatService.CreateHeartbeat("evaluation-worker-placeholder", Guid.NewGuid(), EvaluationWorkerStatus.Idle, completed.Count, failed.Count));
        requested.Remove(workItem);
        return new EvaluationProcessingResult(workItem.BatchId, EvaluationMessageDisposition.Ack, "Batch processed by placeholder consumer.", false, false);
    }

    public EvaluationProcessingResult RequeueBatch(Guid batchId)
    {
        var batch = orchestrator.RetryBatch(batchId);
        var run = orchestrator.GetRun(batch.EvaluationRunId) ?? throw new InvalidOperationException("Evaluation run not found.");
        var workItem = orchestrator.CreateWorkItem(run, batch, Guid.NewGuid(), causationId: batch.Id);
        requested.Add(workItem);
        retryScheduled.Add(consumer.CreateRetryScheduledEvent(workItem, "Operator placeholder requeue."));
        return new EvaluationProcessingResult(batchId, EvaluationMessageDisposition.NackRetry, "Batch requeued in memory.", false, false);
    }

    public EvaluationBatchDeadLetteredEvent ReviewDeadLetter(Guid id)
    {
        var entry = deadLettered.FirstOrDefault(item => item.Id == id);
        if (entry is null)
        {
            entry = new EvaluationBatchDeadLetteredEvent(
                id,
                Guid.Empty,
                Guid.Empty,
                Guid.Empty,
                Guid.Empty,
                "unknown",
                "unknown",
                "unknown",
                AttemptNumber: 0,
                Guid.NewGuid(),
                Guid.NewGuid(),
                $"review:{id:N}",
                "Placeholder review created for nonexistent diagnostic entry.",
                PoisonMessageDetected: false,
                DateTimeOffset.UtcNow,
                ReviewedAt: DateTimeOffset.UtcNow);
            deadLettered.Add(entry);
            return entry;
        }

        var reviewed = entry with { ReviewedAt = DateTimeOffset.UtcNow };
        deadLettered.RemoveAll(item => item.Id == id);
        deadLettered.Add(reviewed);
        return reviewed;
    }

    public EvaluationBatchDeadLetteredEvent SimulatePoisonMessage()
    {
        var item = new EvaluationBatchWorkItem(
            Guid.Empty,
            Guid.Empty,
            Guid.Empty,
            Guid.Empty,
            "",
            "",
            "",
            AttemptNumber: 1,
            Guid.NewGuid(),
            Guid.NewGuid(),
            "",
            EvaluationQueueNames.BatchRequested,
            DateTimeOffset.UtcNow);
        var deadLetter = consumer.CreateDeadLetterEvent(item, "Poison message diagnostic simulation.");
        deadLettered.Add(deadLetter);
        return deadLetter;
    }

    public bool IsRetryEligible(EvaluationBatchWorkItem workItem) => consumer.IsRetryEligible(workItem);

    private EvaluationQueueDiagnostic Queue(string routingKey, int count)
    {
        return new EvaluationQueueDiagnostic(
            routingKey,
            routingKey,
            count,
            deadLettered.Count(item => item.DeadLetterReason.Contains(routingKey, StringComparison.OrdinalIgnoreCase)),
            publisher.PublishingEnabled,
            ExternalBrokerMutationPerformed: false);
    }

    private void SeedHeartbeat()
    {
        if (heartbeats.Count > 0)
        {
            return;
        }

        heartbeats.Add(heartbeatService.CreateHeartbeat("evaluation-worker-placeholder", Guid.NewGuid(), EvaluationWorkerStatus.Idle, processedBatchCount: 0, failedBatchCount: 0));
    }
}
