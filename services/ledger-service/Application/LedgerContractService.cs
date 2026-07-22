using LedgerService.Contracts;

namespace LedgerService.Application;

public sealed class LedgerContractService
{
    public const string CurrentReversalPolicyVersion = "ledger-reversal-v1";

    private static readonly IReadOnlySet<string> SupportedReversalReasonCodes =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "CORRECTION",
            "DUPLICATE_POSTING",
            "OPERATOR_CORRECTION",
            "SETTLEMENT_REVERSAL",
            "VOID"
        };

    private static readonly IReadOnlyDictionary<string, int> CurrencyMinorUnitPrecision =
        new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["CRC"] = 2,
            ["EUR"] = 2,
            ["GBP"] = 2,
            ["JPY"] = 0,
            ["USD"] = 2
        };

    public ErrorResponse CreateNotImplementedError(string correlationId)
    {
        return new ErrorResponse(
            new ErrorDto(
                LedgerErrorCodes.NotImplemented,
                "Ledger Service contract surface is available, but production ledger posting is not implemented here yet."),
            correlationId);
    }

    public ErrorResponse CreateMissingIdempotencyKeyError(string correlationId)
    {
        return new ErrorResponse(
            new ErrorDto(
                LedgerErrorCodes.ValidationFailed,
                "Idempotency-Key header is required for ledger command endpoints.",
                new Dictionary<string, object?>
                {
                    ["header"] = LedgerHeaders.IdempotencyKey
                }),
            correlationId);
    }

    public ErrorResponse CreateValidationError(
        string correlationId,
        string message,
        string field)
    {
        return new ErrorResponse(
            new ErrorDto(
                LedgerErrorCodes.ValidationFailed,
                message,
                new Dictionary<string, object?>
                {
                    ["field"] = field
                }),
            correlationId);
    }

    public bool HasValidMoney(MoneyDto? money)
    {
        return money is not null
            && money.Amount > 0
            && IsIso4217Currency(money.Currency);
    }

    public bool IsIso4217Currency(string? currency)
    {
        return !string.IsNullOrWhiteSpace(currency)
            && currency.Length == 3
            && currency.All(static character => character is >= 'A' and <= 'Z');
    }

    public IReadOnlyList<string> ValidateCanonicalPostingRequest(
        CreateLedgerEntryRequest request,
        string idempotencyKey)
    {
        var errors = new List<string>();

        AddRequired(errors, request.InstructionId, "instructionId");
        AddRequired(errors, request.InstructionType, "instructionType");
        AddRequired(errors, request.InstructionHash, "instructionHash");
        AddRequired(errors, request.OriginatingAuthority, "originatingAuthority");

        if (!CanonicalLedgerRequestHasher.IsSha256Hash(request.InstructionHash))
        {
            errors.Add("instructionHash must be a sha256 hash.");
        }

        if (!CanonicalLedgerRequestHasher.IsSha256Hash(request.CanonicalRequestHash))
        {
            errors.Add("canonicalRequestHash must be a sha256 hash.");
        }

        if (!IsMinorUnitPrecisionValid(request.Money.Currency, request.MinorUnitPrecision))
        {
            errors.Add("minorUnitPrecision does not match the currency policy.");
        }

        if (!IsDirectionCompatible(request.TransactionType, request.Direction))
        {
            errors.Add("Ledger direction is incompatible with transaction type.");
        }

        if (request.ReversalOfLedgerEntryId.HasValue)
        {
            errors.Add("Ledger corrections must use the reversal endpoint.");
        }

        if (request.TransactionType == LedgerTransactionType.REVERSAL
            && !IsSettlementReversalInstruction(request.OriginatingAuthority, request.InstructionType))
        {
            errors.Add(
                "Arbitrary reversal postings are not allowed; corrections must use the reversal endpoint.");
        }

        var expectedHash = CanonicalLedgerRequestHasher.ComputePostingHash(request, idempotencyKey);
        if (!string.Equals(expectedHash, request.CanonicalRequestHash, StringComparison.Ordinal))
        {
            errors.Add("canonicalRequestHash does not match the canonical posting request.");
        }

        return errors;
    }

    private static bool IsSettlementReversalInstruction(
        string? originatingAuthority,
        string? instructionType)
    {
        return string.Equals(originatingAuthority, "settlement-service", StringComparison.Ordinal)
            && (
                string.Equals(instructionType, "LEDGER_REVERSAL", StringComparison.Ordinal)
                || string.Equals(instructionType, "SETTLEMENT_REVERSAL", StringComparison.Ordinal)
            );
    }

    public IReadOnlyList<string> ValidateCanonicalReversalRequest(
        Guid ledgerEntryId,
        ReverseLedgerEntryRequest request,
        string idempotencyKey)
    {
        var errors = new List<string>();

        if (request.OriginalLedgerEntryId == Guid.Empty)
        {
            errors.Add("originalLedgerEntryId is required.");
        }
        else if (request.OriginalLedgerEntryId != ledgerEntryId)
        {
            errors.Add("originalLedgerEntryId must match the route ledger entry id.");
        }

        if (request.WalletId == Guid.Empty)
        {
            errors.Add("walletId is required.");
        }

        if (request.LedgerAccountId == Guid.Empty)
        {
            errors.Add("ledgerAccountId is required.");
        }

        if (!HasValidMoney(request.Money))
        {
            errors.Add("money must contain a positive integer minor currency value with ISO-4217 currency.");
        }

        AddRequired(errors, request.OriginalLedgerEntryHash, "originalLedgerEntryHash");
        AddRequired(errors, request.InstructionId, "instructionId");
        AddRequired(errors, request.InstructionType, "instructionType");
        AddRequired(errors, request.InstructionHash, "instructionHash");
        AddRequired(errors, request.OriginatingAuthority, "originatingAuthority");
        AddRequired(errors, request.ReasonCode, "reasonCode");
        AddRequired(errors, request.ReversalPolicyVersion, "reversalPolicyVersion");

        if (!CanonicalLedgerRequestHasher.IsSha256Hash(request.InstructionHash))
        {
            errors.Add("instructionHash must be a sha256 hash.");
        }

        if (!CanonicalLedgerRequestHasher.IsSha256Hash(request.OriginalLedgerEntryHash))
        {
            errors.Add("originalLedgerEntryHash must be a sha256 hash.");
        }

        if (!CanonicalLedgerRequestHasher.IsSha256Hash(request.CanonicalReversalHash))
        {
            errors.Add("canonicalReversalHash must be a sha256 hash.");
        }

        if (!SupportedReversalReasonCodes.Contains(request.ReasonCode))
        {
            errors.Add("reasonCode is not supported.");
        }

        if (!string.Equals(
            request.ReversalPolicyVersion,
            CurrentReversalPolicyVersion,
            StringComparison.Ordinal))
        {
            errors.Add($"reversalPolicyVersion must be {CurrentReversalPolicyVersion}.");
        }

        if (!IsMinorUnitPrecisionValid(request.Money.Currency, request.MinorUnitPrecision))
        {
            errors.Add("minorUnitPrecision does not match the currency policy.");
        }

        var expectedHash = CanonicalLedgerRequestHasher.ComputeReversalHash(request, idempotencyKey);
        if (!string.Equals(expectedHash, request.CanonicalReversalHash, StringComparison.Ordinal))
        {
            errors.Add("canonicalReversalHash does not match the canonical reversal request.");
        }

        return errors;
    }

    public bool IsMinorUnitPrecisionValid(string currency, int minorUnitPrecision)
    {
        return CurrencyMinorUnitPrecision.TryGetValue(currency, out var expected)
            ? minorUnitPrecision == expected
            : minorUnitPrecision is >= 0 and <= 4;
    }

    private static bool IsDirectionCompatible(
        LedgerTransactionType transactionType,
        LedgerDirection direction)
    {
        return transactionType switch
        {
            LedgerTransactionType.DEPOSIT => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.WITHDRAWAL => direction == LedgerDirection.DEBIT,
            LedgerTransactionType.TICKET_STAKE => direction == LedgerDirection.DEBIT,
            LedgerTransactionType.TICKET_WIN => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.TICKET_REFUND => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.TICKET_VOID => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.FREE_PLAY_CREDIT => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.FREE_PLAY_STAKE => direction == LedgerDirection.DEBIT,
            LedgerTransactionType.FREE_PLAY_WIN => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.MANUAL_CREDIT_ADJUSTMENT => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.MANUAL_DEBIT_ADJUSTMENT => direction == LedgerDirection.DEBIT,
            LedgerTransactionType.SETTLEMENT_CREDIT => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.SETTLEMENT_DEBIT => direction == LedgerDirection.DEBIT,
            LedgerTransactionType.AGENT_COMMISSION_ACCRUAL => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.PLAYER_REBATE_CREDIT => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.PROMOTIONAL_CREDIT => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.ZERO_BALANCE_CREDIT => direction == LedgerDirection.CREDIT,
            LedgerTransactionType.ZERO_BALANCE_DEBIT => direction == LedgerDirection.DEBIT,
            LedgerTransactionType.REVERSAL => true,
            _ => false
        };
    }

    private static void AddRequired(List<string> errors, string? value, string field)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            errors.Add($"{field} is required.");
        }
    }
}
