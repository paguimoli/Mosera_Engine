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
    public const string ReversalNotAllowed = "LEDGER_REVERSAL_NOT_ALLOWED";
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
    ZERO_BALANCE_CREDIT,
    ZERO_BALANCE_DEBIT,
    REVERSAL
}

public sealed record MoneyDto(long Amount, string Currency);

public sealed record LedgerReferenceDto(string? Type, string? Id);

public sealed record CreateLedgerEntryRequest(
    Guid WalletId,
    LedgerTransactionType TransactionType,
    LedgerDirection Direction,
    MoneyDto Money,
    LedgerReferenceDto? Reference,
    IReadOnlyDictionary<string, object?>? Metadata);

public sealed record ReverseLedgerEntryRequest(
    string Reason,
    Guid? ActorUserId,
    IReadOnlyDictionary<string, object?>? Metadata);

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
    Guid? ReversalOfLedgerEntryId,
    IReadOnlyDictionary<string, object?> Metadata,
    DateTimeOffset CreatedAt);

public sealed record LedgerEntryResponse(
    LedgerEntryDto LedgerEntry,
    string CorrelationId);

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
    string CorrelationId);

public sealed record ErrorResponse(
    ErrorDto Error,
    string CorrelationId);

public sealed record ErrorDto(
    string Code,
    string Message,
    IReadOnlyDictionary<string, object?>? Details = null);
