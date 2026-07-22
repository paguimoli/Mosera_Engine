using System.Text.Json.Serialization;

namespace LedgerService.Contracts;

public static class LedgerHeaders
{
    public const string CorrelationId = "x-correlation-id";
    public const string IdempotencyKey = "Idempotency-Key";
}

public static class LedgerErrorCodes
{
    public const string AccountNotFound = "LEDGER_ACCOUNT_NOT_FOUND";
    public const string EntryNotFound = "LEDGER_ENTRY_NOT_FOUND";
    public const string InvalidAmount = "LEDGER_INVALID_AMOUNT";
    public const string DuplicateIdempotencyKey = "LEDGER_DUPLICATE_IDEMPOTENCY_KEY";
    public const string IdempotencyConflict = "LEDGER_IDEMPOTENCY_CONFLICT";
    public const string ReversalNotAllowed = "LEDGER_REVERSAL_NOT_ALLOWED";
    public const string ReplayMismatch = "LEDGER_REPLAY_MISMATCH";
    public const string PostingRequestNotFound = "LEDGER_POSTING_REQUEST_NOT_FOUND";
    public const string UnknownResult = "LEDGER_UNKNOWN_RESULT";
    public const string UnsupportedCurrency = "LEDGER_UNSUPPORTED_CURRENCY";
    public const string ValidationFailed = "LEDGER_VALIDATION_FAILED";
    public const string InternalError = "LEDGER_INTERNAL_ERROR";
    public const string NotImplemented = "LEDGER_NOT_IMPLEMENTED";
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LedgerDirection
{
    CREDIT,
    DEBIT
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LedgerTransactionType
{
    DEPOSIT,
    WITHDRAWAL,
    TICKET_STAKE,
    TICKET_WIN,
    TICKET_REFUND,
    TICKET_VOID,
    FREE_PLAY_CREDIT,
    FREE_PLAY_STAKE,
    FREE_PLAY_WIN,
    MANUAL_CREDIT_ADJUSTMENT,
    MANUAL_DEBIT_ADJUSTMENT,
    SETTLEMENT_CREDIT,
    SETTLEMENT_DEBIT,
    AGENT_COMMISSION_ACCRUAL,
    PLAYER_REBATE_CREDIT,
    PROMOTIONAL_CREDIT,
    ZERO_BALANCE_CREDIT,
    ZERO_BALANCE_DEBIT,
    REVERSAL
}

public sealed record MoneyDto(long Amount, string Currency);

public sealed record LedgerReferenceDto(string? Type, string? Id);

public sealed record CreateLedgerEntryRequest(
    Guid WalletId,
    Guid? LedgerAccountId,
    string InstructionId,
    string InstructionType,
    string InstructionHash,
    string OriginatingAuthority,
    Guid? SettlementRecordId,
    LedgerTransactionType TransactionType,
    LedgerDirection Direction,
    MoneyDto Money,
    int MinorUnitPrecision,
    string CanonicalRequestHash,
    DateTimeOffset EffectiveAt,
    LedgerReferenceDto? Reference,
    Guid? ReversalOfLedgerEntryId,
    IReadOnlyDictionary<string, object?>? Metadata,
    string? PostingRuleId = null,
    string? PostingRuleVersion = null,
    DateTimeOffset? AccountingPostedAt = null,
    Guid? AccountingMarketId = null);

public sealed record ReverseLedgerEntryRequest(
    Guid OriginalLedgerEntryId,
    string OriginalLedgerEntryHash,
    Guid WalletId,
    Guid LedgerAccountId,
    LedgerDirection Direction,
    MoneyDto Money,
    string InstructionId,
    string InstructionType,
    string InstructionHash,
    string OriginatingAuthority,
    string ReasonCode,
    string ReversalPolicyVersion,
    string CanonicalReversalHash,
    DateTimeOffset EffectiveAt,
    int MinorUnitPrecision,
    Guid? ActorUserId,
    IReadOnlyDictionary<string, object?>? Metadata,
    DateTimeOffset? AccountingPostedAt = null,
    Guid? AccountingMarketId = null);

public sealed record LedgerEntryDto(
    Guid Id,
    Guid WalletId,
    Guid AccountId,
    LedgerTransactionType TransactionType,
    LedgerDirection Direction,
    MoneyDto Money,
    MoneyDto BalanceAfter,
    LedgerReferenceDto? Reference,
    string? IdempotencyKey,
    string? CanonicalRequestHash,
    Guid? ReversalOfLedgerEntryId,
    string? OriginalLedgerEntryHash,
    string? ReversalReasonCode,
    string? ReversalPolicyVersion,
    string? CanonicalReversalHash,
    IReadOnlyDictionary<string, object?> Metadata,
    DateTimeOffset CreatedAt);

public sealed record LedgerEntryResponse(
    LedgerEntryDto LedgerEntry,
    string CorrelationId,
    Guid? PostingRequestId = null,
    Guid? JournalTransactionId = null);

public sealed record LedgerEntriesResponse(
    IReadOnlyList<LedgerEntryDto> Entries,
    PaginationDto Pagination,
    string CorrelationId);

public sealed record PaginationDto(int Limit, string? NextCursor);

public sealed record LedgerHealthResponse(
    string Status,
    string Service,
    string Version,
    DateTimeOffset Timestamp,
    IReadOnlyDictionary<string, string> Dependencies,
    LedgerCapabilityMarkers Capabilities,
    string CorrelationId);

public sealed record LedgerCapabilityMarkers(
    bool MutationCapabilityEnabled,
    bool DurablePersistenceConfigured,
    bool IdempotencySupportConfigured,
    bool CanonicalPostingContractReady,
    bool CanonicalHashValidationReady,
    bool ConflictSafeIdempotencyReady,
    bool CurrencyAccountValidationReady,
    bool ImmutableEntryStorageReady,
    bool ReversalOnlyCorrectionReady,
    bool OriginalEntryValidationReady,
    bool ReversalConflictProtectionReady,
    bool SettlementReversalInstructionCompatible,
    bool DurablePostingRequestsReady,
    bool PostingAttemptsReady,
    bool UnknownResultRecoveryReady,
    bool ReplayVerificationReady,
    bool BalancedJournalReady,
    bool JournalPersistenceReady,
    bool JournalRecoveryReady,
    bool ReversalJournalReady,
    bool PostingRecoveryReady,
    bool JournalIntegrityRecoveryReady,
    bool MinimalReconciliationReady,
    bool UnknownResultHandlingReady,
    int UnresolvedReconciliationMismatches,
    int UnresolvedReconciliationInconclusive,
    bool PostingCatalogLoaded,
    bool RequiredLaunchMappingsPresent,
    bool ExactRuleResolutionReady,
    bool AccountRoleResolutionReady,
    bool SettlementMappingsReady,
    bool CommissionAccrualMappingReady,
    bool RebateMappingReady,
    bool PromotionMappingReady,
    bool ManualAdjustmentMappingReady,
    bool StakeRecognitionReady,
    bool FreePlayReady,
    bool CashierMappingsDisabled,
    bool ServiceAuthorityEnabled,
    string? QaCapabilityMarker);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LedgerPostingRequestStatus
{
    CLAIMED,
    COMPLETED,
    FAILED,
    UNKNOWN
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LedgerPostingAttemptResult
{
    SUCCEEDED,
    FAILED,
    REUSED,
    CONFLICT,
    UNKNOWN
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LedgerReplayResult
{
    MATCH,
    MISMATCH,
    INCONCLUSIVE
}

public sealed record LedgerPostingRequestDto(
    Guid Id,
    string RequestKind,
    string InstructionId,
    string InstructionType,
    string InstructionHash,
    string OriginatingAuthority,
    Guid? SettlementRecordId,
    Guid WalletId,
    Guid? LedgerAccountId,
    LedgerDirection Direction,
    MoneyDto Money,
    int MinorUnitPrecision,
    LedgerTransactionType TransactionType,
    string IdempotencyKey,
    string CanonicalRequestHash,
    DateTimeOffset EffectiveAt,
    DateTimeOffset AccountingPostedAt,
    Guid? AccountingBrandId,
    Guid? AccountingMarketId,
    Guid? OriginalAccountingPeriodId,
    Guid? PostingAccountingPeriodId,
    Guid? OriginalLedgerEntryId,
    string? OriginalLedgerEntryHash,
    LedgerPostingRequestStatus Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt,
    string? FailureCode,
    string? FailureReason,
    Guid? LedgerEntryId,
    string? LedgerEntryHash,
    Guid? JournalTransactionId,
    IReadOnlyDictionary<string, object?> Metadata);

public sealed record LedgerPostingAttemptDto(
    Guid Id,
    Guid PostingRequestId,
    int AttemptNumber,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    LedgerPostingAttemptResult Result,
    string? FailureClassification,
    string? TargetResponseReference,
    string? ResponseHash,
    string RuntimeProvenance,
    string BuildProvenance,
    string CanonicalEvidenceHash,
    DateTimeOffset CreatedAt);

public sealed record LedgerReplayEvidenceDto(
    Guid Id,
    Guid PostingRequestId,
    Guid LedgerEntryId,
    LedgerReplayResult Result,
    IReadOnlyList<string> Mismatches,
    string RequestHash,
    string EntryHash,
    string CanonicalEvidenceHash,
    DateTimeOffset VerifiedAt);

public sealed record LedgerPostingRequestResponse(
    LedgerPostingRequestDto PostingRequest,
    string CorrelationId);

public sealed record LedgerPostingAttemptsResponse(
    IReadOnlyList<LedgerPostingAttemptDto> Attempts,
    string CorrelationId);

public sealed record LedgerReplayResponse(
    LedgerReplayEvidenceDto Evidence,
    string CorrelationId);

public sealed record LedgerShadowExecuteRequest(
    string? CorrelationId,
    string TransactionId,
    string AccountId,
    string? WalletId,
    string EntryType,
    long AmountMinor,
    string Currency,
    string? ActorId,
    IReadOnlyDictionary<string, object?>? Metadata,
    LedgerShadowExpectedResult? ExpectedMonolithResult,
    string? Direction = null,
    string? IdempotencyKey = null);

public sealed record LedgerShadowExpectedResult(
    string? TransactionId,
    string? AccountId,
    string? WalletId,
    string? EntryType,
    string? Direction,
    long? AmountMinor,
    string? Currency,
    string? IdempotencyKey);

public sealed record LedgerShadowCalculatedResult(
    string TransactionId,
    string AccountId,
    string? WalletId,
    string EntryType,
    string? Direction,
    long AmountMinor,
    string Currency,
    string? IdempotencyKey,
    bool IsValid,
    IReadOnlyList<string> ValidationMessages);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LedgerShadowComparisonStatus
{
    MATCH,
    MISMATCH,
    NOT_COMPARED
}

public sealed record LedgerShadowMismatchDto(
    string Field,
    string Expected,
    string Actual,
    string MismatchType,
    string Severity);

public sealed record LedgerShadowExecuteResponse(
    bool Success,
    string? ShadowLedgerRunId,
    LedgerShadowCalculatedResult CalculatedResult,
    LedgerShadowComparisonStatus ComparisonStatus,
    IReadOnlyList<LedgerShadowMismatchDto> Mismatches,
    string CorrelationId);

public sealed record ErrorResponse(
    ErrorDto Error,
    string CorrelationId);

public sealed record ErrorDto(
    string Code,
    string Message,
    IReadOnlyDictionary<string, object?>? Details = null);
