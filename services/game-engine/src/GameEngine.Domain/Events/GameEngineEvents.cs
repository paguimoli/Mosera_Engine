namespace GameEngine.Domain.Events;

public abstract record GameEngineEvent(
    string EventType,
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt);

public sealed record DrawCertifiedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid DrawScheduleId,
    Guid OfficialCertifiedDrawResultId)
    : GameEngineEvent("draw.certified", EventId, CorrelationId, OccurredAt);

public sealed record TicketSalesClosedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid DrawScheduleId)
    : GameEngineEvent("ticket.sales.closed", EventId, CorrelationId, OccurredAt);

public sealed record GameDefinitionUpdatedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid GameDefinitionId,
    Guid GameDefinitionVersionId)
    : GameEngineEvent("game.definition.updated", EventId, CorrelationId, OccurredAt);

public sealed record DrawAuthorityAssignmentChangedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid GameDefinitionId,
    Guid DrawAuthorityAssignmentId)
    : GameEngineEvent("draw.authority.assignment.changed", EventId, CorrelationId, OccurredAt);

public sealed record GameDrawScheduledEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid DrawScheduleId)
    : GameEngineEvent("game.draw.scheduled", EventId, CorrelationId, OccurredAt);

public sealed record GameDrawGeneratedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid DrawScheduleId,
    string ResultHash)
    : GameEngineEvent("game.draw.generated", EventId, CorrelationId, OccurredAt);

public sealed record GameDrawResultSubmittedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid DrawScheduleId,
    Guid DrawResultSubmissionId)
    : GameEngineEvent("game.draw.result.submitted", EventId, CorrelationId, OccurredAt);

public sealed record GameDrawCertifiedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid DrawScheduleId,
    Guid OfficialCertifiedDrawResultId)
    : GameEngineEvent("game.draw.certified", EventId, CorrelationId, OccurredAt);

public sealed record GameEvaluationStartedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid EvaluationRunId)
    : GameEngineEvent("game.evaluation.started", EventId, CorrelationId, OccurredAt);

public sealed record GameEvaluationBatchCompletedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid EvaluationRunId,
    Guid EvaluationBatchId)
    : GameEngineEvent("game.evaluation.batch.completed", EventId, CorrelationId, OccurredAt);

public sealed record GameEvaluationCompletedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid EvaluationRunId)
    : GameEngineEvent("game.evaluation.completed", EventId, CorrelationId, OccurredAt);

public sealed record GameEvaluationFailedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid EvaluationRunId,
    string Reason)
    : GameEngineEvent("game.evaluation.failed", EventId, CorrelationId, OccurredAt);

public sealed record GameTicketEvaluatedEvent(
    Guid EventId,
    string CorrelationId,
    DateTimeOffset OccurredAt,
    Guid EvaluationRecordId,
    Guid TicketId)
    : GameEngineEvent("game.ticket.evaluated", EventId, CorrelationId, OccurredAt);
