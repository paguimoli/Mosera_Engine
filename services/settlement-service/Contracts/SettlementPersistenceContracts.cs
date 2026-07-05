using System.Text.Json.Serialization;

namespace SettlementService.Contracts;

public sealed record CreateSettlementRunRequest(
    string? Id,
    string DrawingId,
    string GameId,
    string Status,
    int ExpectedTicketCount,
    int ExpectedLineCount,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt,
    string? ExecutionId,
    int ProcessedTicketCount,
    int ProcessedLineCount,
    int WinCount,
    int LossCount,
    int PushCount,
    int FailedCount,
    decimal TotalStake,
    decimal TotalPayout,
    decimal TotalNet,
    int DurationMs,
    decimal TicketsPerSecond,
    decimal LinesPerSecond,
    int? DrawToSettlementMs,
    int PeakConcurrentSettlements,
    string? Notes,
    string? RecordHash,
    string? PreviousHash,
    string? HashVersion,
    DateTimeOffset? CreatedAt,
    IReadOnlyList<CreateSettlementRecordRequest>? Records,
    IReadOnlyList<CreateSettlementLedgerEffectRequest>? LedgerEffects);

public sealed record CreateSettlementRecordRequest(
    string? Id,
    string TicketId,
    string TicketLineId,
    string AccountId,
    string GameId,
    string DrawingId,
    string WagerTypeId,
    string? WagerOptionId,
    decimal Stake,
    decimal Payout,
    decimal NetAmount,
    string Outcome,
    string Status,
    int Version,
    string? PreviousSettlementRecordId,
    string? ReversalOfSettlementRecordId,
    IReadOnlyList<string>? LedgerTransactionIds,
    string? RecordHash,
    string? PreviousHash,
    string? HashVersion,
    DateTimeOffset? CreatedAt);

public sealed record CreateSettlementLedgerEffectRequest(
    string? Id,
    string SettlementRecordId,
    string TicketId,
    string TicketLineId,
    string DrawingId,
    string AccountId,
    string EffectType,
    string TransactionType,
    string Direction,
    decimal Amount,
    string IdempotencyKey,
    string PostingStatus,
    string ReferenceType,
    string ReferenceId,
    string? ReversalOfLedgerEffectId,
    IReadOnlyDictionary<string, object?>? Metadata,
    DateTimeOffset? CreatedAt);

public sealed record SettlementRunDto(
    string Id,
    string DrawingId,
    string GameId,
    string Status,
    int ExpectedTicketCount,
    int ExpectedLineCount,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt,
    string? ExecutionId,
    int ProcessedTicketCount,
    int ProcessedLineCount,
    int WinCount,
    int LossCount,
    int PushCount,
    int FailedCount,
    decimal TotalStake,
    decimal TotalPayout,
    decimal TotalNet,
    int DurationMs,
    decimal TicketsPerSecond,
    decimal LinesPerSecond,
    int? DrawToSettlementMs,
    int PeakConcurrentSettlements,
    string? Notes,
    string? RecordHash,
    string? PreviousHash,
    string? HashVersion,
    DateTimeOffset CreatedAt);

public sealed record SettlementRecordDto(
    string Id,
    string SettlementRunId,
    string TicketId,
    string TicketLineId,
    string AccountId,
    string GameId,
    string DrawingId,
    string WagerTypeId,
    string? WagerOptionId,
    decimal Stake,
    decimal Payout,
    decimal NetAmount,
    string Outcome,
    string Status,
    int Version,
    string? PreviousSettlementRecordId,
    string? ReversalOfSettlementRecordId,
    IReadOnlyList<string> LedgerTransactionIds,
    string? RecordHash,
    string? PreviousHash,
    string? HashVersion,
    DateTimeOffset CreatedAt);

public sealed record SettlementLedgerEffectDto(
    string Id,
    string SettlementRunId,
    string SettlementRecordId,
    string TicketId,
    string TicketLineId,
    string DrawingId,
    string AccountId,
    string EffectType,
    string TransactionType,
    string Direction,
    decimal Amount,
    string IdempotencyKey,
    string PostingStatus,
    string ReferenceType,
    string ReferenceId,
    string? ReversalOfLedgerEffectId,
    IReadOnlyDictionary<string, object?> Metadata,
    DateTimeOffset CreatedAt);

public sealed record SettlementRunCreateResponse(
    SettlementRunDto Run,
    IReadOnlyList<SettlementRecordDto> Records,
    IReadOnlyList<SettlementLedgerEffectDto> LedgerEffects,
    string CorrelationId);

public sealed record ExecuteSettlementRunRequest(
    string? ExecutionId,
    bool IntegrationDryRun,
    IReadOnlyList<SettlementExecutionTicketLineRequest> TicketLines);

public sealed record ResumeSettlementRunRequest(
    string? ExecutionId,
    bool IntegrationDryRun,
    IReadOnlyList<SettlementExecutionTicketLineRequest> TicketLines);

public sealed record CreateResettlementRequest(
    string? ResettlementId,
    string OriginalRunId,
    bool IntegrationDryRun,
    IReadOnlyList<SettlementResettlementLineRequest> Lines);

public sealed record SettlementResettlementLineRequest(
    string OriginalSettlementRecordId,
    Guid? LedgerWalletId,
    Guid? CreditPlayerId,
    Guid? CreditReservationId,
    Guid? CreditSettlementId,
    Guid? CreditSettlementBatchId,
    decimal CorrectedStake,
    decimal CorrectedPayout,
    string? Reason);

public sealed record SettlementExecutionTicketLineRequest(
    string TicketId,
    string TicketLineId,
    string AccountId,
    Guid? LedgerWalletId,
    Guid? CreditPlayerId,
    Guid? CreditReservationId,
    Guid? CreditSettlementId,
    Guid? CreditSettlementBatchId,
    string? GameId,
    string? DrawingId,
    string WagerTypeId,
    string? WagerOptionId,
    decimal Stake,
    decimal Payout);

public sealed record SettlementRunExecutionResponse(
    SettlementRunDto Run,
    IReadOnlyList<SettlementRecordDto> Records,
    IReadOnlyList<SettlementLedgerEffectDto> LedgerEffects,
    IReadOnlyList<SettlementExternalReferenceDto> ExternalReferences,
    bool AuthoritativeLedgerPosted,
    bool CreditSettlementApplied,
    bool IntegrationDryRunExecuted,
    string ExecutionMode,
    string CorrelationId);

public sealed record SettlementRunResumeResponse(
    SettlementRunDto Run,
    IReadOnlyList<SettlementRecordDto> Records,
    IReadOnlyList<SettlementLedgerEffectDto> LedgerEffects,
    IReadOnlyList<SettlementExternalReferenceDto> ExternalReferences,
    SettlementRecoveryDiagnosticsDto Diagnostics,
    bool AuthoritativeLedgerPosted,
    bool CreditSettlementApplied,
    bool IntegrationDryRunExecuted,
    bool ResumeNoOp,
    string ExecutionMode,
    string CorrelationId);

public sealed record SettlementResettlementResponse(
    SettlementRunDto Run,
    IReadOnlyList<SettlementRecordDto> OriginalRecords,
    IReadOnlyList<SettlementRecordDto> ReversalRecords,
    IReadOnlyList<SettlementRecordDto> CorrectionRecords,
    IReadOnlyList<SettlementLedgerEffectDto> ReversalEffects,
    IReadOnlyList<SettlementLedgerEffectDto> CorrectionEffects,
    IReadOnlyList<SettlementExternalReferenceDto> ExternalReferences,
    bool AuthoritativeLedgerPosted,
    bool CreditSettlementApplied,
    bool IntegrationDryRunExecuted,
    bool ResettlementNoOp,
    string ExecutionMode,
    string CorrelationId);

public sealed record SettlementExternalReferenceDto(
    string SettlementRecordId,
    string TicketId,
    string TicketLineId,
    string ReferenceType,
    string ReferenceId,
    string IdempotencyKey,
    string Status);

public sealed record SettlementRecoveryDiagnosticsDto(
    string RunId,
    string Status,
    bool IsIncomplete,
    bool IsFailed,
    bool IsPartiallyIntegrated,
    int ExpectedRecordCount,
    int PersistedRecordCount,
    int MissingRecordCount,
    int PersistedLedgerEffectCount,
    int MissingLedgerEffectCount,
    int ExternalReferenceCount,
    string? LastFailureReason);

public sealed record SettlementRecoveryDiagnosticsResponse(
    IReadOnlyList<SettlementRecoveryDiagnosticsDto> IncompleteRuns,
    IReadOnlyList<SettlementRecoveryDiagnosticsDto> FailedRuns,
    IReadOnlyList<SettlementRecoveryDiagnosticsDto> PartiallyIntegratedRuns,
    string CorrelationId);

public sealed record SettlementPersistenceCapabilityDto(
    bool DurablePersistenceConfigured,
    bool MutationCapabilityEnabled,
    bool IdempotencySupportConfigured,
    string IdempotencySupportScope,
    string? QaCapabilityMarker,
    bool QaCapabilityMarkerPresent,
    bool ExecutionCapabilityPresent,
    bool IntegrationDryRunCapabilityPresent,
    bool RecoveryResumeCapabilityPresent,
    bool ResettlementCapabilityPresent,
    IReadOnlyList<string> QaCapabilityMarkers);

public sealed record ErrorDto(string Code, string Message);

public sealed record ErrorResponse(ErrorDto Error, string CorrelationId);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(IReadOnlyDictionary<string, object?>))]
internal sealed partial class SettlementPersistenceJsonContext : JsonSerializerContext;
