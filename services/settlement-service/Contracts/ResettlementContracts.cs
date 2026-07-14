using System.Text.Json.Serialization;

namespace SettlementService.Contracts;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ResettlementMode
{
    DryRun,
    ProductionDisabled
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ResettlementLifecycleState
{
    Requested,
    Validated,
    ReversalPrepared,
    ReversalExecuting,
    ReversalCompleted,
    CorrectionPrepared,
    CorrectionExecuting,
    Completed,
    Failed,
    AwaitingVerification,
    CancelledBeforeExecution
}

public sealed record ResettlementCreateRequest(
    Guid? ResettlementRequestId,
    string IdempotencyKey,
    Guid OriginalSettlementId,
    string OriginalSettlementHash,
    Guid OriginalSettlementInputId,
    string OriginalSettlementInputHash,
    Guid CorrectedSettlementInputId,
    string CorrectedSettlementInputHash,
    Guid OriginalMathEvaluationCertificateId,
    string OriginalMathEvaluationCertificateHash,
    Guid CorrectedMathEvaluationCertificateId,
    string CorrectedMathEvaluationCertificateHash,
    string ReasonCode,
    string RequestorReference,
    IReadOnlyDictionary<string, object?>? ApprovalMetadata,
    DateTimeOffset RequestedAt,
    IReadOnlyDictionary<string, object?>? Provenance,
    ResettlementMode Mode);

public sealed record ResettlementExecuteRequest(
    Guid ResettlementRequestId,
    bool ExecuteFinancialInstructions = false);

public sealed record ResettlementRetryRequest(
    Guid ResettlementRequestId,
    string Reason);

public sealed record ResettlementCancelRequest(
    Guid ResettlementRequestId,
    string Reason);

public sealed record ResettlementRequestDto(
    Guid ResettlementRequestId,
    string IdempotencyKey,
    string CanonicalRequestHash,
    Guid OriginalSettlementId,
    string OriginalSettlementHash,
    Guid OriginalSettlementInputId,
    string OriginalSettlementInputHash,
    Guid CorrectedSettlementInputId,
    string CorrectedSettlementInputHash,
    Guid OriginalMathEvaluationCertificateId,
    string OriginalMathEvaluationCertificateHash,
    Guid CorrectedMathEvaluationCertificateId,
    string CorrectedMathEvaluationCertificateHash,
    string ReasonCode,
    string RequestorReference,
    ResettlementMode Mode,
    DateTimeOffset RequestedAt,
    IReadOnlyDictionary<string, object?> ApprovalMetadata,
    IReadOnlyDictionary<string, object?> Provenance);

public sealed record ResettlementChainDto(
    Guid ResettlementRecordId,
    Guid ResettlementRequestId,
    ResettlementLifecycleState LifecycleState,
    Guid OriginalSettlementId,
    string OriginalSettlementHash,
    Guid OriginalSettlementInputId,
    Guid ReversalSettlementId,
    string ReversalSettlementHash,
    Guid CorrectedSettlementInputId,
    Guid CorrectedSettlementId,
    string CorrectedSettlementHash,
    string ChainHash,
    DateTimeOffset CreatedAt);

public sealed record ResettlementEventDto(
    Guid EventId,
    Guid ResettlementRequestId,
    Guid? ResettlementRecordId,
    ResettlementLifecycleState LifecycleState,
    string EventType,
    string EvidenceHash,
    IReadOnlyList<string> Errors,
    DateTimeOffset CreatedAt);

public sealed record ResettlementValidationResult(
    bool IsValid,
    IReadOnlyList<string> Errors);

public sealed record ResettlementResult(
    ResettlementRequestDto Request,
    ResettlementChainDto? Chain,
    ResettlementEventDto Event,
    bool Duplicate,
    string CorrelationId);

public sealed record ResettlementReadiness(
    bool Configured,
    bool RepositoryReachable,
    bool ResettlementValidationReady,
    bool ReversalCalculationReady,
    bool ReversalInstructionGenerationReady,
    bool CorrectedSettlementCreationReady,
    bool ResettlementRecoveryReady,
    bool ProductionResettlementDisabled,
    IReadOnlyList<string> Blockers);
