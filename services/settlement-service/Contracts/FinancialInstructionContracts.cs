using System.Text.Json.Serialization;

namespace SettlementService.Contracts;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum FinancialInstructionType
{
    LEDGER_PAYOUT,
    LEDGER_REFUND,
    LEDGER_REVERSAL,
    LEDGER_NOOP,
    CREDIT_APPLY,
    CREDIT_RELEASE,
    CREDIT_REFUND,
    CREDIT_NOOP
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum FinancialInstructionStatus
{
    Pending,
    Ready,
    Skipped,
    Failed,
    Compensated,
    Posted
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum FinancialInstructionAttemptStatus
{
    Generated,
    Reused,
    Conflict,
    ReplayVerified,
    ReplayMismatch
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum FinancialInstructionExecutionAttemptStatus
{
    Posted,
    Skipped,
    Failed,
    Reused,
    RecoveryVerified,
    Conflict
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SettlementRecoveryState
{
    InstructionPending,
    InstructionReady,
    InstructionFailed,
    InstructionUnknownResult,
    SettlementPartiallyExecuted,
    SettlementAwaitingRecovery,
    SettlementAwaitingVerification,
    SettlementCompleted,
    SettlementFailed
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TargetVerificationOutcome
{
    Committed,
    NotCommitted,
    Unknown
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum InstructionReconciliationStatus
{
    Reconciled,
    MissingTargetRecord,
    Mismatch,
    AwaitingVerification
}

public sealed record FinancialInstructionGenerationRequest(
    Guid SettlementId);

public sealed record FinancialInstructionReplayRequest(
    Guid SettlementId);

public sealed record FinancialInstructionExecutionRequest(
    Guid InstructionId);

public sealed record FinancialInstructionSettlementExecutionRequest(
    Guid SettlementId);

public sealed record FinancialInstructionRetryRequest(
    Guid InstructionId,
    string Reason);

public sealed record SettlementRecoveryRequest(
    Guid SettlementId,
    bool RetryApproved = false,
    string? Reason = null);

public sealed record InstructionRecoveryRequest(
    Guid InstructionId,
    bool RetryApproved = false,
    string? Reason = null);

public sealed record UnknownInstructionVerificationRequest(
    Guid InstructionId,
    TargetVerificationOutcome Outcome,
    string? ExternalReferenceType = null,
    string? ExternalReferenceId = null,
    string? TargetResponseHash = null,
    string? Reason = null);

public sealed record InstructionReconciliationRequest(
    Guid InstructionId,
    string? ExternalReferenceType = null,
    string? ExternalReferenceId = null,
    string? TargetIdempotencyKey = null,
    string? TargetResponseHash = null);

public sealed record FinancialInstructionDto(
    Guid InstructionId,
    Guid SettlementId,
    FinancialInstructionType InstructionType,
    FinancialInstructionStatus InstructionStatus,
    string CanonicalPayloadHash,
    string IdempotencyKey,
    string TargetService,
    int InstructionSequence,
    int AttemptCount,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt,
    string? FailureReason,
    IReadOnlyDictionary<string, object?> Provenance);

public sealed record FinancialInstructionResult(
    string Status,
    bool Duplicate,
    IReadOnlyList<FinancialInstructionDto> Instructions,
    Guid AttemptId,
    string AttemptEvidenceHash,
    string CorrelationId);

public sealed record FinancialInstructionExecutionAttemptDto(
    Guid AttemptId,
    Guid InstructionId,
    Guid SettlementId,
    int AttemptNumber,
    FinancialInstructionExecutionAttemptStatus Status,
    string TargetService,
    string TargetIdempotencyKey,
    string? ExternalReferenceType,
    string? ExternalReferenceId,
    string? TargetResponseHash,
    string? ErrorClassification,
    string? ErrorMessage,
    string EvidenceHash,
    DateTimeOffset CreatedAt);

public sealed record FinancialInstructionExecutionResult(
    string Status,
    bool Duplicate,
    FinancialInstructionDto Instruction,
    FinancialInstructionExecutionAttemptDto Attempt,
    string CorrelationId);

public sealed record FinancialInstructionSettlementExecutionResult(
    Guid SettlementId,
    IReadOnlyList<FinancialInstructionExecutionResult> Results,
    string CorrelationId);

public sealed record RecoveryEventDto(
    Guid EventId,
    Guid? SettlementId,
    Guid? InstructionId,
    Guid? ExecutionAttemptId,
    SettlementRecoveryState RecoveryState,
    string Decision,
    string VerificationResult,
    string? Reason,
    string EvidenceHash,
    DateTimeOffset CreatedAt);

public sealed record ReconciliationEventDto(
    Guid EventId,
    Guid SettlementId,
    Guid InstructionId,
    Guid? ExecutionAttemptId,
    InstructionReconciliationStatus Status,
    string LocalPayloadHash,
    string TargetIdempotencyKey,
    string? ExternalReferenceType,
    string? ExternalReferenceId,
    string? TargetResponseHash,
    string EvidenceHash,
    DateTimeOffset CreatedAt);

public sealed record InstructionRecoveryStatusDto(
    Guid InstructionId,
    Guid SettlementId,
    FinancialInstructionType InstructionType,
    FinancialInstructionStatus InstructionStatus,
    SettlementRecoveryState RecoveryState,
    bool CanResume,
    bool RequiresApproval,
    bool RequiresVerification,
    FinancialInstructionExecutionAttemptDto? LatestAttempt,
    RecoveryEventDto? LatestRecoveryEvent,
    ReconciliationEventDto? LatestReconciliationEvent);

public sealed record SettlementRecoveryStatusDto(
    Guid SettlementId,
    SettlementRecoveryState RecoveryState,
    IReadOnlyList<InstructionRecoveryStatusDto> Instructions,
    string CorrelationId);

public sealed record InstructionRecoveryResult(
    Guid InstructionId,
    SettlementRecoveryState RecoveryState,
    string Decision,
    FinancialInstructionExecutionResult? ExecutionResult,
    RecoveryEventDto RecoveryEvent,
    string CorrelationId);

public sealed record SettlementRecoveryResult(
    Guid SettlementId,
    SettlementRecoveryState RecoveryState,
    IReadOnlyList<InstructionRecoveryResult> Instructions,
    string CorrelationId);

public sealed record InstructionReconciliationResult(
    Guid InstructionId,
    InstructionReconciliationStatus Status,
    bool Matched,
    bool FailClosed,
    ReconciliationEventDto ReconciliationEvent,
    string CorrelationId);

public sealed record SettlementRecoveryReadiness(
    bool Configured,
    bool RepositoryReachable,
    bool RecoveryReady,
    bool ResumeReady,
    bool VerificationReady,
    bool InstructionReconciliationReady,
    bool ReplayReady,
    bool ProductionSettlementAuthorityDisabled,
    IReadOnlyList<string> Blockers);

public sealed record FinancialInstructionReadiness(
    bool Configured,
    bool RepositoryReachable,
    bool FinancialInstructionGenerationReady,
    bool InstructionPersistenceReady,
    bool InstructionReplayReady,
    bool LedgerInstructionExecutionConfigured,
    bool CreditInstructionExecutionConfigured,
    bool TargetClientsReachable,
    bool IdempotencyExecutionReady,
    bool PartialFailureRecoveryReady,
    bool DryRunPostingEnabled,
    bool ProductionSettlementAuthorityDisabled,
    bool PostingDisabled,
    bool LedgerExecutionDisabled,
    bool CreditWalletExecutionDisabled,
    IReadOnlyList<string> Blockers);
