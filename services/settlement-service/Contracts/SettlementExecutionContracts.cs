using System.Text.Json.Serialization;

namespace SettlementService.Contracts;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SettlementExecutionMode
{
    DryRun,
    ProductionDisabled
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SettlementExecutionStatus
{
    Completed,
    Failed,
    Conflict,
    ReplayVerified,
    ReplayMismatch
}

public sealed record SettlementExecutionRequest(
    Guid SettlementRequestId,
    string IdempotencyKey,
    SettlementExecutionMode Mode);

public sealed record SettlementReplayRequest(
    Guid SettlementRequestId);

public sealed record SettlementRecordResponse(
    Guid SettlementId,
    Guid SettlementRequestId,
    Guid SettlementInputId,
    string SettlementInputHash,
    Guid MathEvaluationCertificateId,
    string MathEvaluationCertificateHash,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    string TicketId,
    string TicketLineId,
    string PlayerAccountReference,
    string Currency,
    int MinorUnitPrecision,
    long StakeAmountMinor,
    long GrossPayoutAmountMinor,
    long NetResultAmountMinor,
    string SettlementOutcome,
    string PolicyVersion,
    string CanonicalSettlementHash,
    string IdempotencyKey,
    DateTimeOffset IssuedAt,
    IReadOnlyDictionary<string, object?> Provenance);

public sealed record SettlementExecutionResult(
    SettlementExecutionStatus Status,
    bool Duplicate,
    SettlementRecordResponse SettlementRecord,
    Guid AttemptId,
    string AttemptEvidenceHash,
    string CorrelationId);

public sealed record SettlementExecutionReadiness(
    bool Configured,
    bool RepositoryReachable,
    bool SettlementExecutionReady,
    bool SettlementPolicyReady,
    bool SettlementPersistenceReady,
    bool SettlementReplayReady,
    bool ProductionFinancialPostingDisabled,
    IReadOnlyList<string> Blockers);
