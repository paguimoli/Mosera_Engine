using System.Text.Json.Serialization;

namespace CreditWalletService.Contracts;

public static class CanonicalWalletOperationHeaders
{
    public const string InternalServiceName = "x-internal-service-name";
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WalletInstrumentType
{
    CASH,
    CREDIT,
    FREE_PLAY
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WalletOperationType
{
    ISSUE,
    RESERVE,
    RELEASE,
    CANCEL,
    SETTLE,
    REVERSE,
    EXPIRE
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WalletOperationTerminalStatus
{
    COMMITTED,
    FAILED
}

public sealed record CanonicalWalletOperationRequest(
    Guid RequestId,
    Guid TenantId,
    Guid BrandId,
    Guid PlayerId,
    Guid WalletId,
    WalletInstrumentType Instrument,
    WalletOperationType Operation,
    MoneyDto Money,
    MoneyDto? BalanceImpact,
    string Authority,
    DateTimeOffset EffectiveAt,
    Guid? TicketId,
    Guid? ReservationId,
    Guid? SettlementId,
    Guid? SettlementBatchId,
    Guid? SettlementInstructionId,
    long? SettlementInstructionSequence,
    string? SettlementInstructionHash,
    string? SettlementVersion,
    string? SettlementHash,
    SettlementOutcome? SettlementOutcome,
    Guid? LedgerInstructionId,
    bool? LedgerPostingRequired,
    Guid? OriginalOperationId,
    Guid? CorrectsOperationId,
    string? ReasonCode,
    string? SourceService,
    IReadOnlyDictionary<string, object?>? AuditMetadata);

public sealed record WalletInstrumentDefinitionDto(
    WalletInstrumentType Instrument,
    string Version,
    bool Reservable,
    bool Withdrawable,
    bool Expires,
    bool AllowsNegative,
    bool SettlementSupported,
    string ContentHash);

public sealed record CanonicalWalletOperationResponse(
    Guid OperationId,
    Guid RequestId,
    string IdempotencyKey,
    string CanonicalRequestHash,
    WalletOperationType Operation,
    WalletInstrumentType Instrument,
    WalletOperationTerminalStatus Status,
    bool Reused,
    string? EffectReferenceType,
    string? EffectReferenceId,
    string ResultHash,
    IReadOnlyDictionary<string, object?> Result,
    string CorrelationId,
    DateTimeOffset CompletedAt);

public sealed record CanonicalWalletOperationReadiness(
    bool WalletInstrumentsReady,
    bool CanonicalOperationsReady,
    bool CanonicalHashingReady,
    bool DurableRequestsReady,
    bool DurableEvidenceReady,
    bool ScopeValidationReady,
    bool DatabaseInvariantsReady,
    bool ConflictSafeIdempotencyReady,
    bool InternalAuthorizationHookReady,
    IReadOnlyList<string> ExecutableOperations,
    IReadOnlyList<string> DisabledOperations,
    ReservationLifecycleReadiness ReservationLifecycle,
    SettlementIntegrationReadiness SettlementIntegration,
    WalletRecoveryReadiness Recovery);

public sealed record ReservationLifecycleReadiness(
    bool LifecycleModelReady,
    bool TransitionEnforcementReady,
    bool CanonicalCancellationReady,
    bool PartialFullReleaseReady,
    bool PartialFullCaptureReady,
    bool DuplicateSettlementProtectionReady,
    bool WalletStatusEnforcementReady,
    bool PlayerExposureReady,
    bool InstrumentExposureReady,
    bool ReservationInvariantsReady,
    string ExpiryDecision,
    bool LegacyCancellationIsolated,
    bool ProductionReady);

public sealed record SettlementIntegrationReadiness(
    bool AuthenticatedSettlementReady,
    bool InstructionProvenanceReady,
    bool LedgerCoordinationReady,
    bool CrossAuthorityReferencesReady,
    bool ReversalChainsReady,
    bool CorrectionSupportReady,
    bool ConsistencyValidationReady,
    bool ImmutableSettlementEvidenceReady,
    bool ProductionReady);

public sealed record ReservationSettlementContextDto(
    Guid ReservationId,
    Guid TenantId,
    Guid BrandId,
    Guid PlayerId,
    Guid WalletId,
    WalletInstrumentType Instrument,
    string Currency,
    Guid TicketId,
    string Status,
    long RemainingExposure,
    long CapturedAmount);

public sealed record WalletSettlementOperationTraceDto(
    Guid OriginalSettlementId,
    Guid OriginalOperationId,
    Guid OriginalApplicationId,
    Guid? ReversalOperationId,
    Guid? ReversalApplicationId);

public sealed record WalletExposureLineDto(
    Guid WalletId,
    WalletInstrumentType Instrument,
    string Currency,
    string WalletStatus,
    long Balance,
    long AvailableBalance,
    long ReservedAmount,
    long ReleasedAmount,
    long CapturedAmount,
    long RemainingExposure,
    int ActiveReservationCount);

public sealed record PlayerWalletExposureDto(
    Guid PlayerId,
    IReadOnlyList<WalletExposureLineDto> ByWallet,
    IReadOnlyList<WalletExposureLineDto> ByInstrument,
    DateTimeOffset CalculatedAt,
    string CorrelationId);

public sealed class CanonicalWalletOperationValidationException : Exception
{
    public CanonicalWalletOperationValidationException(string message) : base(message)
    {
    }
}

public sealed class CanonicalWalletOperationConflictException : Exception
{
    public CanonicalWalletOperationConflictException(string message) : base(message)
    {
    }
}

public sealed class CanonicalWalletOperationDisabledException : Exception
{
    public CanonicalWalletOperationDisabledException(string message) : base(message)
    {
    }
}
