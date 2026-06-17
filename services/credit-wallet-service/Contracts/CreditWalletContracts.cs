using System.Text.Json.Serialization;

namespace CreditWalletService.Contracts;

public static class CreditWalletHeaders
{
    public const string CorrelationId = "x-correlation-id";
    public const string IdempotencyKey = "Idempotency-Key";
}

public static class CreditWalletErrorCodes
{
    public const string LimitExceeded = "CREDIT_LIMIT_EXCEEDED";
    public const string InsufficientAvailable = "CREDIT_INSUFFICIENT_AVAILABLE";
    public const string ReservationNotFound = "CREDIT_RESERVATION_NOT_FOUND";
    public const string InvalidRelease = "CREDIT_INVALID_RELEASE";
    public const string InvalidSettlement = "CREDIT_INVALID_SETTLEMENT";
    public const string InvalidAdjustment = "CREDIT_INVALID_ADJUSTMENT";
    public const string HierarchyViolation = "CREDIT_HIERARCHY_VIOLATION";
    public const string AllocationExceeded = "CREDIT_ALLOCATION_EXCEEDED";
    public const string DuplicateIdempotencyKey = "CREDIT_DUPLICATE_IDEMPOTENCY_KEY";
    public const string ValidationFailed = "CREDIT_VALIDATION_FAILED";
    public const string InternalError = "CREDIT_INTERNAL_ERROR";
    public const string NotImplemented = "CREDIT_NOT_IMPLEMENTED";
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum HierarchyModel
{
    NORTH_AMERICAN,
    ASIAN_CREDIT
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CreditWalletStatus
{
    ACTIVE,
    SUSPENDED,
    CLOSED
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AllocationTargetType
{
    PLAYER,
    AGENT,
    MASTER
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CreditAdjustmentType
{
    MANUAL_CREDIT,
    MANUAL_DEBIT
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SettlementOutcome
{
    WIN,
    LOSS,
    PUSH,
    VOID,
    REFUND
}

public sealed record MoneyDto(long Amount, string Currency);

public sealed record ReferenceDto(string? Type, string? Id);

public sealed record SetCreditLimitRequest(
    MoneyDto Limit,
    string ReasonCode,
    Guid ActorId,
    string? SourceService,
    string? AuditNotes,
    IReadOnlyDictionary<string, object?>? Metadata);

public sealed record AllocateCreditRequest(
    AllocationTargetType TargetType,
    Guid TargetId,
    MoneyDto Allocation,
    string ReasonCode,
    Guid ActorId,
    string? SourceService,
    string? AuditNotes,
    IReadOnlyDictionary<string, object?>? Metadata);

public sealed record ReallocateCreditRequest(
    MoneyDto NewAllocation,
    string ReasonCode,
    Guid ActorId,
    string? SourceService,
    string? AuditNotes,
    IReadOnlyDictionary<string, object?>? Metadata);

public sealed record ReserveExposureRequest(
    Guid TicketId,
    Guid? ReservationId,
    MoneyDto Amount,
    Guid? MarketId,
    Guid? DrawId,
    string? SourceService,
    IReadOnlyDictionary<string, object?>? Metadata);

public sealed record ReleaseExposureRequest(
    Guid ReservationId,
    Guid TicketId,
    MoneyDto ReleaseAmount,
    string ReasonCode,
    string? SourceService,
    IReadOnlyDictionary<string, object?>? Metadata);

public sealed record SettleCreditRequest(
    Guid SettlementId,
    Guid SettlementBatchId,
    Guid ReservationId,
    Guid TicketId,
    MoneyDto ReleaseAmount,
    MoneyDto BalanceImpact,
    SettlementOutcome Outcome,
    string? SourceService,
    IReadOnlyDictionary<string, object?>? Metadata);

public sealed record AdjustCreditRequest(
    CreditAdjustmentType AdjustmentType,
    MoneyDto Amount,
    string ReasonCode,
    Guid ActorId,
    string? SourceService,
    string? AuditNotes,
    ReferenceDto? Reference,
    IReadOnlyDictionary<string, object?>? Metadata);

public sealed record CreditWalletDto(
    Guid PlayerId,
    Guid CreditWalletId,
    MoneyDto CreditLimit,
    MoneyDto Balance,
    MoneyDto PendingExposure,
    MoneyDto AvailableCredit,
    CreditWalletStatus Status,
    HierarchyModel HierarchyModel,
    string CorrelationId);

public sealed record PaginationDto(int Limit, string? NextCursor);

public sealed record CreditWalletHealthResponse(
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
