using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SettlementService.Contracts;
using SettlementService.Infrastructure;

namespace SettlementService.Application;

public sealed record FinancialInstructionDefinition(
    Guid InstructionId,
    FinancialInstructionType InstructionType,
    FinancialInstructionStatus InstructionStatus,
    string TargetService,
    int InstructionSequence,
    long AmountMinor,
    string CanonicalPayloadHash,
    string IdempotencyKey,
    IReadOnlyDictionary<string, object?> Provenance);

public sealed class FinancialInstructionService(FinancialInstructionRepository repository)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    public async Task<FinancialInstructionResult> GenerateAsync(
        FinancialInstructionGenerationRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var settlementRecord = await repository.GetSettlementRecordAsync(request.SettlementId, cancellationToken)
            ?? throw new FinancialInstructionValidationException(["SettlementRecord was not found."]);
        var definitions = BuildInstructions(settlementRecord);
        return await repository.GenerateAsync(settlementRecord, definitions, correlationId, cancellationToken);
    }

    public async Task<FinancialInstructionResult> ReplayAsync(
        FinancialInstructionReplayRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var settlementRecord = await repository.GetSettlementRecordAsync(request.SettlementId, cancellationToken)
            ?? throw new FinancialInstructionValidationException(["SettlementRecord was not found."]);
        var definitions = BuildInstructions(settlementRecord);
        return await repository.ReplayAsync(settlementRecord, definitions, correlationId, cancellationToken);
    }

    public Task<FinancialInstructionReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        return repository.CheckReadinessAsync(cancellationToken);
    }

    public static IReadOnlyList<FinancialInstructionDefinition> BuildInstructions(SettlementRecordResponse settlementRecord)
    {
        return settlementRecord.SettlementOutcome switch
        {
            "WIN" =>
            [
                BuildInstruction(settlementRecord, FinancialInstructionType.LEDGER_PAYOUT, "ledger-service", 1, settlementRecord.GrossPayoutAmountMinor),
                BuildInstruction(settlementRecord, FinancialInstructionType.CREDIT_APPLY, "credit-wallet-service", 2, settlementRecord.GrossPayoutAmountMinor)
            ],
            "LOSS" =>
            [
                BuildInstruction(settlementRecord, FinancialInstructionType.LEDGER_NOOP, "ledger-service", 1, 0),
                BuildInstruction(settlementRecord, FinancialInstructionType.CREDIT_NOOP, "credit-wallet-service", 2, 0)
            ],
            "PUSH" =>
            [
                BuildInstruction(settlementRecord, FinancialInstructionType.LEDGER_REFUND, "ledger-service", 1, settlementRecord.StakeAmountMinor),
                BuildInstruction(settlementRecord, FinancialInstructionType.CREDIT_REFUND, "credit-wallet-service", 2, settlementRecord.StakeAmountMinor)
            ],
            "VOID" =>
            [
                BuildInstruction(settlementRecord, FinancialInstructionType.LEDGER_REFUND, "ledger-service", 1, settlementRecord.StakeAmountMinor),
                BuildInstruction(settlementRecord, FinancialInstructionType.CREDIT_REFUND, "credit-wallet-service", 2, settlementRecord.StakeAmountMinor)
            ],
            "REJECTED" =>
            [
                BuildInstruction(settlementRecord, FinancialInstructionType.LEDGER_NOOP, "ledger-service", 1, 0),
                BuildInstruction(settlementRecord, FinancialInstructionType.CREDIT_NOOP, "credit-wallet-service", 2, 0)
            ],
            _ => throw new FinancialInstructionValidationException([$"Unsupported settlement outcome {settlementRecord.SettlementOutcome}."])
        };
    }

    private static FinancialInstructionDefinition BuildInstruction(
        SettlementRecordResponse settlementRecord,
        FinancialInstructionType instructionType,
        string targetService,
        int sequence,
        long amountMinor)
    {
        var status = instructionType is FinancialInstructionType.LEDGER_NOOP or FinancialInstructionType.CREDIT_NOOP
            ? FinancialInstructionStatus.Skipped
            : FinancialInstructionStatus.Ready;
        var idempotencyKey = $"settlement-financial-instruction:{settlementRecord.SettlementId:N}:{instructionType}";
        var instructionId = CreateDeterministicGuid(idempotencyKey);
        var provenance = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["amountMinor"] = amountMinor,
            ["balanceImpactMinor"] = instructionType switch
            {
                FinancialInstructionType.CREDIT_APPLY or FinancialInstructionType.CREDIT_REFUND =>
                    ComputeBalanceImpact(settlementRecord),
                _ => null
            },
            ["captureAmountMinor"] = instructionType.ToString().StartsWith("CREDIT_", StringComparison.Ordinal)
                ? settlementRecord.StakeAmountMinor
                : null,
            ["creditWalletPosting"] = "disabled",
            ["initialStatus"] = "Pending",
            ["ledgerPosting"] = "disabled",
            ["postingDisabled"] = true,
            ["settlementHash"] = settlementRecord.CanonicalSettlementHash,
            ["stateTransition"] = status == FinancialInstructionStatus.Ready ? "Pending->Ready" : "Pending->Skipped"
        };
        CopyProvenance(settlementRecord.Provenance, provenance, "resettlementRequestId");
        CopyProvenance(settlementRecord.Provenance, provenance, "resettlementRole");
        CopyProvenance(settlementRecord.Provenance, provenance, "originalSettlementId");
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["amountMinor"] = amountMinor,
            ["canonicalSettlementHash"] = settlementRecord.CanonicalSettlementHash,
            ["currency"] = settlementRecord.Currency,
            ["idempotencyKey"] = idempotencyKey,
            ["instructionId"] = instructionId,
            ["instructionSequence"] = sequence,
            ["instructionStatus"] = status.ToString(),
            ["instructionType"] = instructionType.ToString(),
            ["minorUnitPrecision"] = settlementRecord.MinorUnitPrecision,
            ["playerAccountReference"] = settlementRecord.PlayerAccountReference,
            ["settlementId"] = settlementRecord.SettlementId,
            ["settlementOutcome"] = settlementRecord.SettlementOutcome,
            ["settlementRequestId"] = settlementRecord.SettlementRequestId,
            ["targetService"] = targetService,
            ["ticketId"] = settlementRecord.TicketId,
            ["ticketLineId"] = settlementRecord.TicketLineId
        };

        return new FinancialInstructionDefinition(
            instructionId,
            instructionType,
            status,
            targetService,
            sequence,
            amountMinor,
            HashCanonical(JsonSerializer.Serialize(payload, JsonOptions)),
            idempotencyKey,
            provenance);
    }

    private static long ComputeBalanceImpact(SettlementRecordResponse settlementRecord)
    {
        if (settlementRecord.NetResultAmountMinor != 0) return settlementRecord.NetResultAmountMinor;
        return settlementRecord.GrossPayoutAmountMinor;
    }

    private static void CopyProvenance(
        IReadOnlyDictionary<string, object?> source,
        IDictionary<string, object?> target,
        string key)
    {
        if (source.TryGetValue(key, out var value)) target[key] = value;
    }

    public static string HashCanonical(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private static Guid CreateDeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes[..16]);
    }
}

public sealed class FinancialInstructionValidationException(IReadOnlyList<string> errors)
    : Exception(string.Join(" ", errors))
{
    public IReadOnlyList<string> Errors { get; } = errors;
}

public sealed class FinancialInstructionConflictException(string message)
    : Exception(message);
