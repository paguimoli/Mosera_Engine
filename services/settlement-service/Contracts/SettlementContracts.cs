using System.Text.Json.Serialization;

namespace SettlementService.Contracts;

public static class SettlementHeaders
{
    public const string CorrelationId = "x-correlation-id";
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SettlementOutcome
{
    WIN,
    LOSS,
    PUSH,
    VOID
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ShadowComparisonStatus
{
    MATCH,
    MISMATCH,
    NOT_COMPARED
}

public sealed record ExpectedSettlementResultDto(
    SettlementOutcome CalculatedOutcome,
    long GrossPayout,
    long NetAmount,
    long StakeAmount,
    string Currency);

public sealed record ShadowSettlementExecuteRequest(
    string? CorrelationId,
    string SettlementRunId,
    string TicketId,
    string DrawingId,
    string GameId,
    string WagerType,
    long StakeAmount,
    string Currency,
    IReadOnlyList<int> SelectedNumbers,
    IReadOnlyList<int> WinningNumbers,
    ExpectedSettlementResultDto? ExpectedMonolithResult);

public sealed record ShadowSettlementMismatchDto(
    string Field,
    string Expected,
    string Actual);

public sealed record ShadowSettlementExecuteResponse(
    bool Success,
    string ShadowSettlementId,
    SettlementOutcome CalculatedOutcome,
    long GrossPayout,
    long NetAmount,
    long StakeAmount,
    string Currency,
    ShadowComparisonStatus ComparisonStatus,
    IReadOnlyList<ShadowSettlementMismatchDto> Mismatches,
    string CorrelationId);
