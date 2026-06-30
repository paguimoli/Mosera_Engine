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

public sealed record EvaluationRecordAttemptResult(
    EvaluationDuplicateStatus Status,
    EvaluationRecordDefinition Record);

public sealed record EvaluationBatchWorkItem(
    Guid RunId,
    Guid BatchId,
    int Sequence,
    string CheckpointCursor,
    string QueueName,
    DateTimeOffset CreatedAt);

public sealed record EvaluationBatchCompletedEvent(
    Guid RunId,
    Guid BatchId,
    int ProcessedCount,
    string LastProcessedMarker,
    DateTimeOffset CompletedAt);

public sealed record EvaluationBatchFailedEvent(
    Guid RunId,
    Guid BatchId,
    string Reason,
    int RetryCount,
    DateTimeOffset FailedAt);

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
