namespace GameEngine.Domain.Model;

public enum EvaluationCheckpointStatus
{
    Pending,
    InProgress,
    Completed,
    Failed,
    RetryPending,
    Skipped
}

public enum EvaluationDuplicateStatus
{
    Created,
    DuplicateReturnedExisting
}

public enum EvaluationOrchestratorHealth
{
    Healthy,
    Warning,
    Error
}

public enum EvaluationWorkerStatus
{
    Starting,
    Idle,
    Processing,
    Degraded,
    Stopping,
    Failed
}

public enum EvaluationMessageDisposition
{
    Ack,
    NackRetry,
    DeadLetter,
    DuplicateAck,
    Rejected
}

public sealed record EvaluationPlanRequest(
    Guid DrawId,
    Guid GameBindingId,
    Guid OfficialCertifiedResultId,
    int EligibleTicketCount,
    int? GameSpecificBatchSize,
    string GameModuleId,
    string GameModuleVersion,
    string EvaluationVersion);

public sealed record EvaluationRunDefinition(
    Guid Id,
    Guid DrawId,
    Guid GameBindingId,
    Guid OfficialCertifiedResultId,
    string GameModuleId,
    string GameModuleVersion,
    string EvaluationVersion,
    EvaluationRunStatus Status,
    int BatchSize,
    int EligibleTicketCount,
    int PlannedBatchCount,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt,
    IReadOnlyCollection<string> Preconditions);

public sealed record EvaluationBatchDefinition(
    Guid Id,
    Guid EvaluationRunId,
    int Sequence,
    int StartInclusive,
    int EndExclusive,
    EvaluationBatchStatus Status,
    string CheckpointCursor,
    int RetryCount,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ClaimedAt,
    DateTimeOffset? CompletedAt);

public sealed record EvaluationCheckpoint(
    Guid RunId,
    Guid BatchId,
    string TicketRangeOrCursor,
    EvaluationCheckpointStatus Status,
    int ProcessedCount,
    int FailedCount,
    int RetryCount,
    string LastProcessedMarker,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

public sealed record EvaluationRecordIdempotencyKey(
    Guid DrawId,
    Guid TicketId,
    Guid GameId,
    string GameModuleId,
    string GameModuleVersion,
    string EvaluationVersion);

public sealed record EvaluationRecordDefinition(
    Guid Id,
    Guid EvaluationRunId,
    Guid EvaluationBatchId,
    EvaluationRecordIdempotencyKey IdempotencyKey,
    GameEvaluationOutcome Outcome,
    string EvaluationHash,
    IReadOnlyDictionary<string, object?> SettlementFacts,
    DateTimeOffset EvaluatedAt);

public sealed record EvaluationExecutionContext(
    Guid DrawId,
    Guid GameId,
    Guid GameBindingId,
    string ModuleId,
    string ModuleVersion,
    string EvaluatorVersion,
    Guid DrawAuthorityId,
    string PaytableVersion,
    IReadOnlyDictionary<string, object?> CertifiedResult,
    IReadOnlyDictionary<string, object?> Configuration,
    Guid RunId,
    Guid BatchId,
    int BatchSequence,
    int StartInclusive,
    int EndExclusive,
    Guid CorrelationId);

public sealed record TicketReadRequest(
    Guid DrawId,
    Guid GameId,
    Guid BatchId,
    int StartInclusive,
    int EndExclusive,
    IReadOnlyDictionary<string, object?> Configuration);

public sealed record TicketReadModel(
    Guid TicketId,
    Guid PlayerId,
    GameType GameType,
    WagerType WagerType,
    IReadOnlyDictionary<string, object?> Payload,
    GameEvaluationAmount Stake);

public sealed record ImmutableEvaluationRecord(
    Guid Id,
    Guid RunId,
    Guid BatchId,
    Guid TicketId,
    Guid DrawId,
    Guid GameId,
    string ModuleId,
    string ModuleVersion,
    string EvaluatorVersion,
    string PaytableVersion,
    GameEvaluationOutcome Outcome,
    GameEvaluationReason ReasonCode,
    GameEvaluationAmount Amount,
    IReadOnlyDictionary<string, object?> EvaluationMetadata,
    DateTimeOffset EvaluatedAt);

public sealed record ModuleResolutionResult(
    bool Resolved,
    string ModuleId,
    string ModuleVersion,
    string? Reason,
    GameModuleLifecycleStatus? LifecycleStatus,
    bool ProductionReady,
    DateTimeOffset ResolvedAt);

public sealed record EvaluationExecutionTicketResult(
    Guid TicketId,
    bool ValidationAccepted,
    GameEvaluationOutcome Outcome,
    GameEvaluationReason ReasonCode,
    Guid? EvaluationRecordId,
    IReadOnlyCollection<ValidationError> Errors);

public sealed record EvaluationExecutionResult(
    Guid RunId,
    Guid BatchId,
    Guid CorrelationId,
    string ModuleId,
    string ModuleVersion,
    int TicketsRead,
    int RecordsCreated,
    int TicketFailures,
    EvaluationBatchStatus BatchStatus,
    EvaluationRunStatus RunStatus,
    IReadOnlyCollection<ImmutableEvaluationRecord> EvaluationRecords,
    IReadOnlyCollection<EvaluationExecutionTicketResult> TicketResults,
    bool SettlementIntegrationTriggered,
    bool FinancialMutationPerformed,
    DateTimeOffset ExecutedAt);

public sealed record ModuleExecutionDiagnostics(
    int ExecutionCount,
    int EvaluationRecordCount,
    bool TicketDatabaseReadsEnabled,
    bool SettlementIntegrationEnabled,
    bool FinancialPostingEnabled,
    IReadOnlyCollection<EvaluationExecutionResult> RecentExecutions,
    DateTimeOffset GeneratedAt);

public sealed record EvaluationRecordAttemptResult(
    EvaluationDuplicateStatus Status,
    EvaluationRecordDefinition Record);

public sealed record EvaluationBatchWorkItem(
    Guid RunId,
    Guid BatchId,
    Guid DrawId,
    Guid GameId,
    string GameModuleId,
    string GameModuleVersion,
    string EvaluationVersion,
    int AttemptNumber,
    Guid CorrelationId,
    Guid CausationId,
    string IdempotencyKey,
    string RoutingKey,
    DateTimeOffset CreatedAt);

public sealed record EvaluationBatchStartedEvent(
    Guid RunId,
    Guid BatchId,
    Guid DrawId,
    Guid GameId,
    string GameModuleId,
    string GameModuleVersion,
    string EvaluationVersion,
    int AttemptNumber,
    Guid CorrelationId,
    Guid CausationId,
    string IdempotencyKey,
    DateTimeOffset CreatedAt);

public sealed record EvaluationBatchCompletedEvent(
    Guid RunId,
    Guid BatchId,
    Guid DrawId,
    Guid GameId,
    string GameModuleId,
    string GameModuleVersion,
    string EvaluationVersion,
    int AttemptNumber,
    Guid CorrelationId,
    Guid CausationId,
    string IdempotencyKey,
    int ProcessedCount,
    string LastProcessedMarker,
    DateTimeOffset CreatedAt);

public sealed record EvaluationBatchFailedEvent(
    Guid RunId,
    Guid BatchId,
    Guid DrawId,
    Guid GameId,
    string GameModuleId,
    string GameModuleVersion,
    string EvaluationVersion,
    int AttemptNumber,
    Guid CorrelationId,
    Guid CausationId,
    string IdempotencyKey,
    string Reason,
    int RetryCount,
    DateTimeOffset CreatedAt);

public sealed record EvaluationBatchRetryScheduledEvent(
    Guid RunId,
    Guid BatchId,
    Guid DrawId,
    Guid GameId,
    string GameModuleId,
    string GameModuleVersion,
    string EvaluationVersion,
    int AttemptNumber,
    Guid CorrelationId,
    Guid CausationId,
    string IdempotencyKey,
    string FailureReason,
    DateTimeOffset CreatedAt);

public sealed record EvaluationBatchDeadLetteredEvent(
    Guid Id,
    Guid RunId,
    Guid BatchId,
    Guid DrawId,
    Guid GameId,
    string GameModuleId,
    string GameModuleVersion,
    string EvaluationVersion,
    int AttemptNumber,
    Guid CorrelationId,
    Guid CausationId,
    string IdempotencyKey,
    string DeadLetterReason,
    bool PoisonMessageDetected,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ReviewedAt);

public sealed record EvaluationWorkerHeartbeatEvent(
    string WorkerId,
    Guid InstanceId,
    string ServiceVersion,
    int ProcessedBatchCount,
    int FailedBatchCount,
    DateTimeOffset LastHeartbeatAt,
    EvaluationWorkerStatus Status,
    Guid CorrelationId,
    Guid CausationId,
    string IdempotencyKey,
    DateTimeOffset CreatedAt);

public sealed record EvaluationRunCompletedEvent(
    Guid RunId,
    int BatchCount,
    int RecordCount,
    DateTimeOffset CompletedAt);

public sealed record EvaluationRunFailedEvent(
    Guid RunId,
    string Reason,
    DateTimeOffset FailedAt);

public sealed record EvaluationProgress(
    Guid RunId,
    EvaluationRunStatus Status,
    int PlannedBatchCount,
    int CompletedBatchCount,
    int FailedBatchCount,
    int RetryPendingBatchCount,
    int EvaluationRecordCount,
    decimal PercentComplete,
    DateTimeOffset GeneratedAt);

public sealed record EvaluationOrchestratorStatus(
    EvaluationOrchestratorHealth Health,
    int RunCount,
    int BatchCount,
    int EvaluationRecordCount,
    int CheckpointCount,
    bool ProductionRabbitMqWiringEnabled,
    bool SettlementIntegrationEnabled,
    IReadOnlyCollection<string> Reasons,
    DateTimeOffset GeneratedAt);

public sealed record EvaluationQueueDiagnostic(
    string QueueName,
    string RoutingKey,
    int InMemoryMessageCount,
    int DeadLetterCount,
    bool ProductionRabbitMqPublishingEnabled,
    bool ExternalBrokerMutationPerformed);

public sealed record EvaluationPublishResult(
    Guid RunId,
    int PlannedBatchCount,
    int WorkItemCount,
    bool PublishingEnabled,
    bool ExternalPublishAttempted,
    bool FinancialMutationPerformed,
    IReadOnlyCollection<EvaluationBatchWorkItem> WorkItems);

public sealed record EvaluationProcessingResult(
    Guid BatchId,
    EvaluationMessageDisposition Disposition,
    string Reason,
    bool ExternalBrokerMutationPerformed,
    bool SettlementIntegrationTriggered);

public sealed record EvaluationProcessingStatus(
    int RequestedCount,
    int StartedCount,
    int CompletedCount,
    int FailedCount,
    int RetryScheduledCount,
    int DeadLetterCount,
    int WorkerHeartbeatCount,
    bool ProductionGameLogicEnabled,
    bool TicketDbIntegrationEnabled,
    bool SettlementIntegrationEnabled,
    DateTimeOffset GeneratedAt);
