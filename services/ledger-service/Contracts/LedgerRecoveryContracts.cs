using System.Text.Json.Serialization;

namespace LedgerService.Contracts;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LedgerRecoveryClassification
{
    MATCHED_COMMIT,
    NOT_COMMITTED,
    INCONCLUSIVE,
    JOURNAL_MATCH,
    JOURNAL_MISMATCH,
    RETRY_COMPLETED,
    COMPLETED_REUSED
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LedgerReconciliationResult
{
    RECONCILED,
    LEDGER_MISSING,
    CREDIT_MISSING,
    PAYLOAD_MISMATCH,
    STATUS_MISMATCH,
    INCONCLUSIVE
}

public sealed record LedgerRecoveryEventDto(
    Guid EventId,
    Guid PostingRequestId,
    Guid? LedgerTransactionId,
    string RecoveryScope,
    LedgerRecoveryClassification Classification,
    string EvidenceHash,
    string? FailureReason,
    IReadOnlyDictionary<string, object?> Provenance,
    DateTimeOffset CreatedAt);

public sealed record LedgerRecoveryResponse(
    LedgerRecoveryEventDto Evidence,
    LedgerPostingRequestDto PostingRequest,
    LedgerEntryDto? LedgerEntry,
    string CorrelationId);

public sealed record LedgerReconciliationEventDto(
    Guid EventId,
    Guid SettlementInstructionId,
    Guid? PostingRequestId,
    Guid? LedgerTransactionId,
    Guid? CreditInstructionId,
    string? CreditReference,
    LedgerReconciliationResult Result,
    string EvidenceHash,
    string? FailureReason,
    IReadOnlyDictionary<string, object?> Provenance,
    DateTimeOffset CreatedAt);

public sealed record LedgerReconciliationResponse(
    LedgerReconciliationEventDto Evidence,
    string CorrelationId);

public sealed record LedgerRecoveryReadiness(
    bool Configured,
    bool Reachable,
    bool PostingRecoveryReady,
    bool JournalIntegrityRecoveryReady,
    bool ReplayReady,
    bool MinimalReconciliationReady,
    bool UnknownResultHandlingReady,
    int UnresolvedMismatches,
    int UnresolvedInconclusive,
    IReadOnlyList<string> Blockers);

public sealed class LedgerRecoveryException(string message) : Exception(message);

public sealed class LedgerReconciliationNotFoundException : Exception;
