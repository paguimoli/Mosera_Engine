using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgerService.Contracts;
using LedgerService.Infrastructure;

namespace LedgerService.Application;

public static class CanonicalLedgerRequestHasher
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    public static string ComputePostingHash(CreateLedgerEntryRequest request, string idempotencyKey)
    {
        var material = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["amountMinor"] = request.Money.Amount,
            ["currency"] = Normalize(request.Money.Currency),
            ["direction"] = request.Direction.ToString(),
            ["effectiveAt"] = request.EffectiveAt.ToUniversalTime().ToString("O"),
            ["idempotencyKey"] = Normalize(idempotencyKey),
            ["instructionHash"] = Normalize(request.InstructionHash),
            ["instructionId"] = Normalize(request.InstructionId),
            ["instructionType"] = Normalize(request.InstructionType),
            ["ledgerAccountId"] = request.LedgerAccountId?.ToString("D"),
            ["ledgerWalletId"] = request.WalletId.ToString("D"),
            ["minorUnitPrecision"] = request.MinorUnitPrecision,
            ["originatingAuthority"] = Normalize(request.OriginatingAuthority),
            ["referenceId"] = NormalizeNullable(request.Reference?.Id),
            ["referenceType"] = NormalizeNullable(request.Reference?.Type),
            ["reversalOfLedgerEntryId"] = request.ReversalOfLedgerEntryId?.ToString("D"),
            ["settlementRecordId"] = request.SettlementRecordId?.ToString("D"),
            ["transactionType"] = request.TransactionType.ToString()
        };

        if (!string.IsNullOrWhiteSpace(request.PostingRuleId)
            || !string.IsNullOrWhiteSpace(request.PostingRuleVersion))
        {
            material["postingRuleId"] = NormalizeNullable(request.PostingRuleId);
            material["postingRuleVersion"] = NormalizeNullable(request.PostingRuleVersion);
        }

        return Hash(material);
    }

    public static string ComputeReversalHash(
        ReverseLedgerEntryRequest request,
        string idempotencyKey)
    {
        var material = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["amountMinor"] = request.Money.Amount,
            ["currency"] = Normalize(request.Money.Currency),
            ["direction"] = request.Direction.ToString(),
            ["effectiveAt"] = request.EffectiveAt.ToUniversalTime().ToString("O"),
            ["idempotencyKey"] = Normalize(idempotencyKey),
            ["instructionHash"] = Normalize(request.InstructionHash),
            ["instructionId"] = Normalize(request.InstructionId),
            ["instructionType"] = Normalize(request.InstructionType),
            ["ledgerAccountId"] = request.LedgerAccountId.ToString("D"),
            ["ledgerWalletId"] = request.WalletId.ToString("D"),
            ["minorUnitPrecision"] = request.MinorUnitPrecision,
            ["originalLedgerEntryHash"] = Normalize(request.OriginalLedgerEntryHash),
            ["originalLedgerEntryId"] = request.OriginalLedgerEntryId.ToString("D"),
            ["originatingAuthority"] = Normalize(request.OriginatingAuthority),
            ["reasonCode"] = Normalize(request.ReasonCode),
            ["referenceId"] = request.OriginalLedgerEntryId.ToString("D"),
            ["referenceType"] = "ledger_entry",
            ["reversalOfLedgerEntryId"] = request.OriginalLedgerEntryId.ToString("D"),
            ["reversalPolicyVersion"] = Normalize(request.ReversalPolicyVersion),
            ["settlementRecordId"] = null,
            ["transactionType"] = LedgerTransactionType.REVERSAL.ToString()
        };

        return Hash(material);
    }

    public static bool IsSha256Hash(string? value)
    {
        return !string.IsNullOrWhiteSpace(value)
            && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.Length == 71
            && value[7..].All(static character =>
                character is >= '0' and <= '9' or >= 'a' and <= 'f');
    }

    public static string ComputeEvidenceHash(SortedDictionary<string, object?> material)
    {
        return Hash(material);
    }

    private static string Hash(SortedDictionary<string, object?> material)
    {
        var canonical = JsonSerializer.Serialize(material, JsonOptions);
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant()}";
    }

    private static string Normalize(string value)
    {
        return value.Trim();
    }

    private static string? NormalizeNullable(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }
}
