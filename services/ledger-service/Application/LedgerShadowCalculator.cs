using LedgerService.Contracts;

namespace LedgerService.Application;

public sealed class LedgerShadowCalculator
{
    private static readonly HashSet<string> KnownEntryTypes = new(StringComparer.Ordinal)
    {
        "DEPOSIT",
        "WITHDRAWAL",
        "TICKET_STAKE",
        "TICKET_WIN",
        "TICKET_REFUND",
        "TICKET_VOID",
        "FREE_PLAY_CREDIT",
        "FREE_PLAY_STAKE",
        "FREE_PLAY_WIN",
        "MANUAL_CREDIT_ADJUSTMENT",
        "MANUAL_DEBIT_ADJUSTMENT",
        "SETTLEMENT_CREDIT",
        "SETTLEMENT_DEBIT",
        "ZERO_BALANCE_CREDIT",
        "ZERO_BALANCE_DEBIT",
        "REVERSAL"
    };

    private static readonly HashSet<string> KnownDirections = new(StringComparer.Ordinal)
    {
        "CREDIT",
        "DEBIT"
    };

    public LedgerShadowEvaluation Evaluate(LedgerShadowExecuteRequest request)
    {
        var validationMessages = ValidateRequest(request);

        if (validationMessages.Count > 0)
        {
            throw new ArgumentException(string.Join(" ", validationMessages));
        }

        var calculated = new LedgerShadowCalculatedResult(
            request.TransactionId.Trim(),
            request.AccountId.Trim(),
            string.IsNullOrWhiteSpace(request.WalletId) ? null : request.WalletId.Trim(),
            request.EntryType.Trim(),
            string.IsNullOrWhiteSpace(request.Direction) ? null : request.Direction.Trim(),
            request.AmountMinor,
            request.Currency.Trim(),
            string.IsNullOrWhiteSpace(request.IdempotencyKey) ? null : request.IdempotencyKey.Trim(),
            true,
            Array.Empty<string>());

        var mismatches = Compare(calculated, request.ExpectedMonolithResult);
        var comparisonStatus = request.ExpectedMonolithResult is null
            ? LedgerShadowComparisonStatus.NOT_COMPARED
            : mismatches.Count == 0
                ? LedgerShadowComparisonStatus.MATCH
                : LedgerShadowComparisonStatus.MISMATCH;

        return new LedgerShadowEvaluation(calculated, comparisonStatus, mismatches);
    }

    private static List<string> ValidateRequest(LedgerShadowExecuteRequest request)
    {
        var messages = new List<string>();

        if (string.IsNullOrWhiteSpace(request.TransactionId))
        {
            messages.Add("transactionId is required.");
        }

        if (string.IsNullOrWhiteSpace(request.AccountId))
        {
            messages.Add("accountId is required.");
        }

        if (string.IsNullOrWhiteSpace(request.EntryType))
        {
            messages.Add("entryType is required.");
        }
        else if (!KnownEntryTypes.Contains(request.EntryType.Trim()))
        {
            messages.Add("entryType is not supported by the ledger contract.");
        }

        if (request.AmountMinor <= 0)
        {
            messages.Add("amountMinor must be a positive integer minor-unit value.");
        }

        if (!IsIso4217Currency(request.Currency))
        {
            messages.Add("currency must be an ISO-4217 uppercase code.");
        }

        if (!string.IsNullOrWhiteSpace(request.Direction) &&
            !KnownDirections.Contains(request.Direction.Trim()))
        {
            messages.Add("direction must be CREDIT or DEBIT when provided.");
        }

        return messages;
    }

    private static IReadOnlyList<LedgerShadowMismatchDto> Compare(
        LedgerShadowCalculatedResult calculated,
        LedgerShadowExpectedResult? expected)
    {
        if (expected is null)
        {
            return Array.Empty<LedgerShadowMismatchDto>();
        }

        var mismatches = new List<LedgerShadowMismatchDto>();

        AddIfMismatch(
            mismatches,
            "accountId",
            expected.AccountId,
            calculated.AccountId,
            "ACCOUNT_MISMATCH");
        AddIfMismatch(
            mismatches,
            "entryType",
            expected.EntryType,
            calculated.EntryType,
            "ENTRY_TYPE_MISMATCH");
        AddIfMismatch(
            mismatches,
            "amountMinor",
            expected.AmountMinor?.ToString(),
            calculated.AmountMinor.ToString(),
            "AMOUNT_MISMATCH");
        AddIfMismatch(
            mismatches,
            "currency",
            expected.Currency,
            calculated.Currency,
            "CURRENCY_MISMATCH");
        AddIfMismatch(
            mismatches,
            "idempotencyKey",
            expected.IdempotencyKey,
            calculated.IdempotencyKey,
            "IDEMPOTENCY_MISMATCH");

        if (!string.IsNullOrWhiteSpace(expected.Direction) ||
            !string.IsNullOrWhiteSpace(calculated.Direction))
        {
            AddIfMismatch(
                mismatches,
                "direction",
                expected.Direction,
                calculated.Direction,
                "ENTRY_TYPE_MISMATCH");
        }

        return mismatches;
    }

    private static void AddIfMismatch(
        List<LedgerShadowMismatchDto> mismatches,
        string field,
        string? expected,
        string? actual,
        string mismatchType)
    {
        var normalizedExpected = expected ?? string.Empty;
        var normalizedActual = actual ?? string.Empty;

        if (normalizedExpected == normalizedActual)
        {
            return;
        }

        mismatches.Add(new LedgerShadowMismatchDto(
            field,
            normalizedExpected,
            normalizedActual,
            mismatchType,
            GetSeverity(mismatchType)));
    }

    private static string GetSeverity(string mismatchType)
    {
        return mismatchType switch
        {
            "AMOUNT_MISMATCH" => "CRITICAL",
            "CURRENCY_MISMATCH" => "CRITICAL",
            "ENTRY_TYPE_MISMATCH" => "CRITICAL",
            "ACCOUNT_MISMATCH" => "CRITICAL",
            "IDEMPOTENCY_MISMATCH" => "WARNING",
            _ => "WARNING"
        };
    }

    private static bool IsIso4217Currency(string? currency)
    {
        return !string.IsNullOrWhiteSpace(currency)
            && currency.Length == 3
            && currency.All(static character => character is >= 'A' and <= 'Z');
    }
}

public sealed record LedgerShadowEvaluation(
    LedgerShadowCalculatedResult CalculatedResult,
    LedgerShadowComparisonStatus ComparisonStatus,
    IReadOnlyList<LedgerShadowMismatchDto> Mismatches);
