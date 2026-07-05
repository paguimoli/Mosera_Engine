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

public sealed record CreditWalletSummaryDto(
    Guid PlayerId,
    Guid CreditWalletId,
    MoneyDto CreditLimit,
    MoneyDto Balance,
    MoneyDto PendingExposure,
    MoneyDto AvailableCredit,
    CreditWalletStatus Status,
    HierarchyModel HierarchyModel,
    string CorrelationId);

public sealed record CreditExposureReservationDto(
    Guid ReservationId,
    string TicketId,
    MoneyDto Amount,
    MoneyDto RemainingExposure,
    string Status,
    string? CorrelationId,
    DateTimeOffset CreatedAt);

public sealed record CreditReservationDto(
    Guid ReservationId,
    Guid PlayerId,
    string TicketId,
    MoneyDto Amount,
    MoneyDto ReservedAmount,
    MoneyDto ReleasedAmount,
    MoneyDto SettledAmount,
    MoneyDto RemainingExposure,
    string Status,
    string IdempotencyKey,
    string? CorrelationId,
    DateTimeOffset CreatedAt,
    DateTimeOffset? UpdatedAt,
    DateTimeOffset? ReleasedAt,
    DateTimeOffset? SettledAt,
    DateTimeOffset? CancelledAt);

public sealed record CreditSettlementApplicationDto(
    Guid SettlementApplicationId,
    Guid ReservationId,
    Guid PlayerId,
    string TicketId,
    string SettlementId,
    MoneyDto ReleaseAmount,
    MoneyDto BalanceImpact,
    MoneyDto BalanceBefore,
    MoneyDto BalanceAfter,
    string OperationType,
    string IdempotencyKey,
    string? CorrelationId,
    DateTimeOffset CreatedAt);

public sealed record CreditExposureDto(
    Guid PlayerId,
    MoneyDto PendingExposure,
    IReadOnlyList<CreditExposureReservationDto> Reservations,
    string CorrelationId);

public sealed record CreditWalletTransactionDto(
    string Id,
    string TransactionType,
    string TicketId,
    MoneyDto Amount,
    string Status,
    string? ReferenceId,
    string? CorrelationId,
    DateTimeOffset CreatedAt);

public sealed record CreditWalletTransactionsDto(
    Guid PlayerId,
    IReadOnlyList<CreditWalletTransactionDto> Transactions,
    PaginationDto Pagination,
    string CorrelationId);

public sealed record CreditReconciliationReservationDto(
    Guid ReservationId,
    string TicketId,
    MoneyDto ReservedAmount,
    MoneyDto ReleasedAmount,
    MoneyDto SettledAmount,
    MoneyDto RemainingExposure,
    string Status,
    DateTimeOffset CreatedAt);

public sealed record CreditReconciliationSettlementApplicationDto(
    Guid SettlementApplicationId,
    Guid ReservationId,
    string TicketId,
    string SettlementId,
    MoneyDto ReleaseAmount,
    MoneyDto BalanceImpact,
    MoneyDto BalanceBefore,
    MoneyDto BalanceAfter,
    string OperationType,
    DateTimeOffset CreatedAt);

public sealed record CreditReconciliationDiscrepancyDto(
    string Code,
    string Severity,
    string Message,
    IReadOnlyDictionary<string, object?> Details);

public sealed record CreditWalletReconciliationDto(
    Guid PlayerId,
    Guid CreditWalletId,
    MoneyDto Balance,
    MoneyDto PendingExposure,
    MoneyDto AvailableCredit,
    IReadOnlyList<CreditReconciliationReservationDto> Reservations,
    IReadOnlyList<CreditReconciliationSettlementApplicationDto> SettlementApplications,
    IReadOnlyList<CreditReconciliationDiscrepancyDto> DetectedDiscrepancies,
    string CorrelationId,
    DateTimeOffset GeneratedAtUtc);

public sealed record PaginationDto(int Limit, string? NextCursor);

public sealed record CreditWalletHealthResponse(
    string Status,
    string Service,
    string Version,
    DateTimeOffset Timestamp,
    IReadOnlyDictionary<string, string> Dependencies,
    CreditWalletCapabilityDto Capabilities,
    string CorrelationId);

public sealed record CreditWalletCapabilityDto(
    bool DurablePersistenceConfigured,
    bool ReadCapabilityEnabled,
    bool MutationCapabilityEnabled,
    string MutationCapabilityScope,
    bool IdempotencySupportConfigured,
    string IdempotencySupportScope,
    string? QaCapabilityMarker,
    bool QaCapabilityMarkerPresent);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CreditShadowOperationType
{
    RESERVE,
    RELEASE,
    SETTLEMENT
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CreditShadowComparisonStatus
{
    MATCH,
    MISMATCH,
    NOT_COMPARED
}

public sealed record CreditShadowExpectedResult(
    long? AmountMinor,
    long? AvailableCreditAfter,
    long? ReservedAmount,
    long? ReleasedAmount,
    long? RemainingExposure,
    long? BalanceImpact,
    string? Currency);

public sealed record CreditShadowExecuteRequest(
    string? CorrelationId,
    string AccountId,
    string? WalletId,
    string? TicketId,
    string? ReservationId,
    long AmountMinor,
    string Currency,
    long? AvailableCreditBefore,
    long? PendingExposureBefore,
    long? RemainingExposureBefore,
    long? ReleasedAmountBefore,
    long? BalanceBefore,
    long? BalanceImpactMinor,
    IReadOnlyDictionary<string, object?>? Metadata,
    CreditShadowExpectedResult? ExpectedMonolithResult);

public sealed record CreditShadowCalculatedResult(
    CreditShadowOperationType OperationType,
    string AccountId,
    string? WalletId,
    string? TicketId,
    string? ReservationId,
    long AmountMinor,
    string Currency,
    long? AvailableCreditAfter,
    long? ReservedAmount,
    long? ReleasedAmount,
    long? RemainingExposure,
    long? BalanceImpact,
    bool IsValid,
    IReadOnlyList<string> ValidationMessages);

public sealed record CreditShadowMismatchDto(
    string Field,
    string Expected,
    string Actual,
    string MismatchType,
    string Severity);

public sealed record CreditShadowExecuteResponse(
    bool Success,
    string? ShadowCreditRunId,
    CreditShadowCalculatedResult CalculatedResult,
    CreditShadowComparisonStatus ComparisonStatus,
    IReadOnlyList<CreditShadowMismatchDto> Mismatches,
    string CorrelationId);

public sealed record ErrorResponse(
    ErrorDto Error,
    string CorrelationId);

public sealed record ErrorDto(
    string Code,
    string Message,
    IReadOnlyDictionary<string, object?>? Details = null);
