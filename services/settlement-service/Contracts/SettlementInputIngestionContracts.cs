using System.Text.Json.Serialization;

namespace SettlementService.Contracts;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SettlementIngestionMode
{
    DryRun,
    ProductionDisabled
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SettlementIngestionStatus
{
    Accepted,
    Rejected,
    Conflict
}

public sealed record CreditReservationReferenceDto(
    string ReservationId,
    string PlayerAccountReference,
    string TicketId,
    string TicketLineId);

public sealed record AcceptedWagerFinancialContextDto(
    string ContextReference,
    string TicketId,
    string TicketLineId,
    string PlayerAccountReference,
    long AcceptedStakeAmountMinor,
    string Currency,
    int MinorUnitPrecision,
    string RoundingPolicyReference,
    CreditReservationReferenceDto? CreditReservationReference,
    DateTimeOffset AcceptedAt);

public sealed record SettlementPolicyReferenceDto(
    string Version);

public sealed record SettlementInputIngestionRequest(
    Guid? SettlementRequestId,
    string IdempotencyKey,
    Guid SettlementInputId,
    string SettlementInputHash,
    Guid MathEvaluationCertificateId,
    string MathEvaluationCertificateHash,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    string TicketId,
    string TicketLineId,
    string PlayerAccountReference,
    string AcceptedWagerFinancialContextReference,
    long AcceptedStakeAmountMinor,
    string Currency,
    int MinorUnitPrecision,
    string RoundingPolicyReference,
    string? CreditReservationReference,
    string SettlementPolicyVersion,
    DateTimeOffset AcceptedAt,
    IReadOnlyDictionary<string, object?>? RequestProvenance,
    SettlementIngestionMode Mode,
    AcceptedWagerFinancialContextDto AcceptedWagerFinancialContext,
    SettlementPolicyReferenceDto SettlementPolicy);

public sealed record SettlementIngestionValidationResult(
    bool IsValid,
    IReadOnlyList<string> Errors);

public sealed record SettlementIngestionResult(
    Guid SettlementRequestId,
    string IdempotencyKey,
    string CanonicalRequestHash,
    Guid SettlementInputId,
    string SettlementInputHash,
    SettlementIngestionStatus Status,
    bool Duplicate,
    Guid AttemptId,
    string AttemptEvidenceHash,
    string CorrelationId);

public sealed record StoredSettlementInputDto(
    Guid SettlementInputId,
    string SettlementInputHash,
    Guid MathEvaluationCertificateId,
    string MathEvaluationCertificateHash,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    string TicketReference,
    string GameManifestId,
    string GameManifestVersion,
    string GameManifestHash,
    string MathModelId,
    string MathModelVersion,
    string MathModelHash,
    string PaytableId,
    string PaytableVersion,
    string PaytableHash,
    string EvaluatorVersion,
    string EvaluationOutcome,
    string PrizeTier,
    string PrizeFactsHash,
    decimal PayoutUnits,
    decimal Multiplier,
    string CanonicalPayloadHash);

public sealed record SettlementIngestionReadiness(
    bool Configured,
    bool RepositoryReachable,
    bool SettlementInputValidationReady,
    bool FinancialContextValidationReady,
    bool IdempotencyReady,
    bool ProductionSettlementExecutionDisabled,
    IReadOnlyList<string> Blockers);
