using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CreditWalletService.Contracts;

namespace CreditWalletService.Application;

public static class CanonicalWalletRequestHasher
{
    public static string Compute(CanonicalWalletOperationRequest request, string idempotencyKey)
    {
        var material = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["amountMinor"] = request.Money.Amount,
            ["auditMetadata"] = request.AuditMetadata ?? new Dictionary<string, object?>(),
            ["authority"] = Normalize(request.Authority),
            ["balanceImpactMinor"] = request.BalanceImpact?.Amount,
            ["brandId"] = request.BrandId.ToString("D"),
            ["currency"] = Normalize(request.Money.Currency),
            ["balanceImpactCurrency"] = request.BalanceImpact is null ? null : Normalize(request.BalanceImpact.Currency),
            ["effectiveAt"] = request.EffectiveAt.ToUniversalTime().ToString("O"),
            ["idempotencyKey"] = Normalize(idempotencyKey),
            ["instrument"] = request.Instrument.ToString(),
            ["operation"] = request.Operation.ToString(),
            ["originalOperationId"] = request.OriginalOperationId?.ToString("D"),
            ["correctsOperationId"] = request.CorrectsOperationId?.ToString("D"),
            ["playerId"] = request.PlayerId.ToString("D"),
            ["reasonCode"] = NormalizeNullable(request.ReasonCode),
            ["requestId"] = request.RequestId.ToString("D"),
            ["reservationId"] = request.ReservationId?.ToString("D"),
            ["settlementBatchId"] = request.SettlementBatchId?.ToString("D"),
            ["settlementId"] = request.SettlementId?.ToString("D"),
            ["settlementInstructionId"] = request.SettlementInstructionId?.ToString("D"),
            ["settlementInstructionSequence"] = request.SettlementInstructionSequence,
            ["settlementInstructionHash"] = NormalizeNullable(request.SettlementInstructionHash),
            ["settlementVersion"] = NormalizeNullable(request.SettlementVersion),
            ["settlementHash"] = NormalizeNullable(request.SettlementHash),
            ["settlementOutcome"] = request.SettlementOutcome?.ToString(),
            ["ledgerInstructionId"] = request.LedgerInstructionId?.ToString("D"),
            ["ledgerPostingRequired"] = request.LedgerPostingRequired,
            ["sourceService"] = NormalizeNullable(request.SourceService),
            ["tenantId"] = request.TenantId.ToString("D"),
            ["ticketId"] = request.TicketId?.ToString("D"),
            ["walletId"] = request.WalletId.ToString("D")
        };

        return Hash(material);
    }

    public static Guid ComputeOperationId(string idempotencyKey)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"credit-wallet-operation:{Normalize(idempotencyKey)}"));
        bytes[6] = (byte)((bytes[6] & 0x0f) | 0x50);
        bytes[8] = (byte)((bytes[8] & 0x3f) | 0x80);
        return new Guid(bytes[..16]);
    }

    public static string ComputeSettlementInstruction(CanonicalWalletOperationRequest request)
    {
        var material = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["authority"] = Normalize(request.Authority),
            ["balanceImpactCurrency"] = request.BalanceImpact is null ? null : Normalize(request.BalanceImpact.Currency),
            ["balanceImpactMinor"] = request.BalanceImpact?.Amount,
            ["brandId"] = request.BrandId.ToString("D"),
            ["captureAmountMinor"] = request.Money.Amount,
            ["currency"] = Normalize(request.Money.Currency),
            ["instrument"] = request.Instrument.ToString(),
            ["playerId"] = request.PlayerId.ToString("D"),
            ["reservationId"] = request.ReservationId?.ToString("D"),
            ["settlementId"] = request.SettlementId?.ToString("D"),
            ["settlementInstructionId"] = request.SettlementInstructionId?.ToString("D"),
            ["settlementInstructionSequence"] = request.SettlementInstructionSequence,
            ["settlementInstructionHash"] = NormalizeNullable(request.SettlementInstructionHash),
            ["settlementVersion"] = NormalizeNullable(request.SettlementVersion),
            ["settlementHash"] = NormalizeNullable(request.SettlementHash),
            ["settlementOutcome"] = request.SettlementOutcome?.ToString(),
            ["ledgerInstructionId"] = request.LedgerInstructionId?.ToString("D"),
            ["ledgerPostingRequired"] = request.LedgerPostingRequired,
            ["originalOperationId"] = request.OriginalOperationId?.ToString("D"),
            ["correctsOperationId"] = request.CorrectsOperationId?.ToString("D"),
            ["tenantId"] = request.TenantId.ToString("D"),
            ["ticketId"] = request.TicketId?.ToString("D"),
            ["walletId"] = request.WalletId.ToString("D")
        };
        return Hash(material);
    }

    public static string ComputeEvidenceHash(SortedDictionary<string, object?> material)
    {
        return Hash(material);
    }

    private static string Hash(object material)
    {
        var canonical = Canonicalize(JsonSerializer.SerializeToElement(material));
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant()}";
    }

    private static string Canonicalize(JsonElement element)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            WriteCanonical(writer, element);
        }

        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject().OrderBy(item => item.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray()) WriteCanonical(writer, item);
                writer.WriteEndArray();
                break;
            default:
                element.WriteTo(writer);
                break;
        }
    }

    private static string Normalize(string value) => value.Trim();

    private static string? NormalizeNullable(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
