using SettlementService.Contracts;

namespace SettlementService.Application;

public sealed class ShadowSettlementCalculator
{
    public ShadowSettlementExecuteResponse Execute(
        ShadowSettlementExecuteRequest request,
        string correlationId)
    {
        var selected = request.SelectedNumbers.ToHashSet();
        var winning = request.WinningNumbers.ToHashSet();
        var matchedCount = selected.Count(number => winning.Contains(number));
        var isWin = selected.Count > 0 && matchedCount == selected.Count;
        var outcome = isWin ? SettlementOutcome.WIN : SettlementOutcome.LOSS;
        var grossPayout = isWin ? request.StakeAmount * 2 : 0;
        var netAmount = grossPayout - request.StakeAmount;
        var mismatches = CompareExpected(
            request.ExpectedMonolithResult,
            outcome,
            grossPayout,
            netAmount,
            request.StakeAmount,
            request.Currency);
        var comparisonStatus = request.ExpectedMonolithResult is null
            ? ShadowComparisonStatus.NOT_COMPARED
            : mismatches.Count == 0
                ? ShadowComparisonStatus.MATCH
                : ShadowComparisonStatus.MISMATCH;

        return new ShadowSettlementExecuteResponse(
            true,
            $"shadow-{request.SettlementRunId}-{request.TicketId}-{Guid.NewGuid():N}",
            outcome,
            grossPayout,
            netAmount,
            request.StakeAmount,
            request.Currency,
            comparisonStatus,
            mismatches,
            correlationId);
    }

    private static IReadOnlyList<ShadowSettlementMismatchDto> CompareExpected(
        ExpectedSettlementResultDto? expected,
        SettlementOutcome outcome,
        long grossPayout,
        long netAmount,
        long stakeAmount,
        string currency)
    {
        if (expected is null)
        {
            return [];
        }

        var mismatches = new List<ShadowSettlementMismatchDto>();

        AddMismatch(mismatches, "calculatedOutcome", expected.CalculatedOutcome.ToString(), outcome.ToString());
        AddMismatch(mismatches, "grossPayout", expected.GrossPayout.ToString(), grossPayout.ToString());
        AddMismatch(mismatches, "netAmount", expected.NetAmount.ToString(), netAmount.ToString());
        AddMismatch(mismatches, "stakeAmount", expected.StakeAmount.ToString(), stakeAmount.ToString());
        AddMismatch(mismatches, "currency", expected.Currency, currency);

        return mismatches;
    }

    private static void AddMismatch(
        List<ShadowSettlementMismatchDto> mismatches,
        string field,
        string expected,
        string actual)
    {
        if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
        {
            mismatches.Add(new ShadowSettlementMismatchDto(field, expected, actual));
        }
    }
}
