using SettlementService.Contracts;
using SettlementService.Infrastructure;

namespace SettlementService.Application;

public sealed class FinancialInstructionExecutionService(
    FinancialInstructionRepository repository,
    SettlementLedgerServiceClient ledgerClient,
    SettlementCreditWalletServiceClient creditClient)
{
    public async Task<FinancialInstructionExecutionResult> ExecuteAsync(
        FinancialInstructionExecutionRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var context = await repository.GetExecutionContextAsync(request.InstructionId, cancellationToken)
            ?? throw new FinancialInstructionValidationException(["Financial instruction was not found."]);
        return await ExecuteContextAsync(context, false, correlationId, cancellationToken);
    }

    public async Task<FinancialInstructionSettlementExecutionResult> ExecuteSettlementAsync(
        FinancialInstructionSettlementExecutionRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var contexts = await repository.ListExecutionContextsAsync(request.SettlementId, cancellationToken);
        if (contexts.Count == 0)
        {
            throw new FinancialInstructionValidationException(["Financial instructions were not found for settlement."]);
        }

        var results = new List<FinancialInstructionExecutionResult>();
        foreach (var context in contexts.OrderBy(item => item.Instruction.InstructionSequence))
        {
            results.Add(await ExecuteContextAsync(context, false, correlationId, cancellationToken));
        }

        return new FinancialInstructionSettlementExecutionResult(request.SettlementId, results, correlationId);
    }

    public async Task<FinancialInstructionExecutionResult> RetryAsync(
        FinancialInstructionRetryRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Reason))
        {
            throw new FinancialInstructionValidationException(["Governed retry reason is required."]);
        }

        var context = await repository.GetExecutionContextAsync(request.InstructionId, cancellationToken)
            ?? throw new FinancialInstructionValidationException(["Financial instruction was not found."]);
        return await ExecuteContextAsync(context, true, correlationId, cancellationToken);
    }

    public async Task<IReadOnlyList<FinancialInstructionExecutionAttemptDto>> GetStateAsync(
        Guid instructionId,
        CancellationToken cancellationToken)
    {
        return await repository.ListExecutionAttemptsAsync(instructionId, cancellationToken);
    }

    private async Task<FinancialInstructionExecutionResult> ExecuteContextAsync(
        FinancialInstructionExecutionContext context,
        bool governedRetry,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var instruction = context.Instruction;
        ValidateInstruction(context);
        var attempts = await repository.ListExecutionAttemptsAsync(instruction.InstructionId, cancellationToken);
        var terminal = attempts.LastOrDefault(attempt =>
            attempt.Status is FinancialInstructionExecutionAttemptStatus.Posted or FinancialInstructionExecutionAttemptStatus.Skipped);
        if (terminal is not null)
        {
            return new FinancialInstructionExecutionResult("Reused", true, instruction, terminal, correlationId);
        }

        var latestFailed = attempts.LastOrDefault()?.Status == FinancialInstructionExecutionAttemptStatus.Failed;
        if (latestFailed && !governedRetry)
        {
            throw new FinancialInstructionConflictException("Failed financial instruction requires governed retry.");
        }

        var targetIdempotencyKey = BuildTargetIdempotencyKey(instruction);
        if (IsNoop(instruction.InstructionType))
        {
            var skipped = await repository.AppendExecutionAttemptAsync(
                instruction,
                FinancialInstructionExecutionAttemptStatus.Skipped,
                targetIdempotencyKey,
                instruction.TargetService == "ledger-service" ? "ledger_noop" : "credit_noop",
                "SKIPPED",
                "sha256:noop",
                null,
                null,
                cancellationToken);
            return new FinancialInstructionExecutionResult("Skipped", false, instruction, skipped, correlationId);
        }

        try
        {
            var (reference, responseHash) = instruction.TargetService switch
            {
                "ledger-service" => await ExecuteLedgerAsync(context, targetIdempotencyKey, correlationId, cancellationToken),
                "credit-wallet-service" => await ExecuteCreditAsync(context, targetIdempotencyKey, correlationId, cancellationToken),
                _ => throw new SettlementIntegrationException($"Unsupported target service {instruction.TargetService}.")
            };

            var posted = await repository.AppendExecutionAttemptAsync(
                instruction,
                FinancialInstructionExecutionAttemptStatus.Posted,
                targetIdempotencyKey,
                reference.ReferenceType,
                reference.ReferenceId,
                responseHash,
                null,
                null,
                cancellationToken);
            return new FinancialInstructionExecutionResult("Posted", false, instruction, posted, correlationId);
        }
        catch (Exception error) when (error is SettlementIntegrationException or HttpRequestException or TaskCanceledException)
        {
            var failed = await repository.AppendExecutionAttemptAsync(
                instruction,
                FinancialInstructionExecutionAttemptStatus.Failed,
                targetIdempotencyKey,
                null,
                null,
                null,
                error.GetType().Name,
                error.Message,
                cancellationToken);
            return new FinancialInstructionExecutionResult("Failed", false, instruction, failed, correlationId);
        }
    }

    private async Task<(SettlementExternalReferenceDto Reference, string ResponseHash)> ExecuteLedgerAsync(
        FinancialInstructionExecutionContext context,
        string targetIdempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var walletId = ParseGuid(context.SettlementRecord.PlayerAccountReference, "playerAccountReference");
        return await ledgerClient.PostFinancialInstructionAsync(
            context,
            walletId,
            targetIdempotencyKey,
            correlationId,
            cancellationToken);
    }

    private async Task<(SettlementExternalReferenceDto Reference, string ResponseHash)> ExecuteCreditAsync(
        FinancialInstructionExecutionContext context,
        string targetIdempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var playerId = ParseGuid(context.SettlementRecord.PlayerAccountReference, "playerAccountReference");
        if (string.IsNullOrWhiteSpace(context.CreditReservationReference))
        {
            throw new SettlementIntegrationException("Credit instruction requires creditReservationReference.");
        }

        var reservationId = ParseGuid(context.CreditReservationReference, "creditReservationReference");
        return await creditClient.ExecuteFinancialInstructionAsync(
            context,
            playerId,
            reservationId,
            targetIdempotencyKey,
            correlationId,
            cancellationToken);
    }

    private static void ValidateInstruction(FinancialInstructionExecutionContext context)
    {
        var instruction = context.Instruction;
        if (instruction.InstructionStatus is not (FinancialInstructionStatus.Ready or FinancialInstructionStatus.Skipped))
        {
            throw new FinancialInstructionValidationException([$"Instruction status {instruction.InstructionStatus} is not executable."]);
        }

        if (instruction.TargetService == "ledger-service" && !instruction.InstructionType.ToString().StartsWith("LEDGER_", StringComparison.Ordinal))
        {
            throw new FinancialInstructionValidationException(["Ledger target received non-Ledger instruction."]);
        }

        if (instruction.TargetService == "credit-wallet-service" && !instruction.InstructionType.ToString().StartsWith("CREDIT_", StringComparison.Ordinal))
        {
            throw new FinancialInstructionValidationException(["Credit Wallet target received non-Credit instruction."]);
        }

        if (instruction.CanonicalPayloadHash != context.Instruction.CanonicalPayloadHash ||
            string.IsNullOrWhiteSpace(instruction.IdempotencyKey))
        {
            throw new FinancialInstructionValidationException(["Instruction idempotency metadata is invalid."]);
        }
    }

    private static bool IsNoop(FinancialInstructionType instructionType)
    {
        return instructionType is FinancialInstructionType.LEDGER_NOOP or FinancialInstructionType.CREDIT_NOOP;
    }

    public static string BuildTargetIdempotencyKey(FinancialInstructionDto instruction)
    {
        return $"settlement-target:{instruction.SettlementId:N}:{instruction.InstructionId:N}:{instruction.InstructionType}:{instruction.CanonicalPayloadHash}";
    }

    private static Guid ParseGuid(string value, string field)
    {
        return Guid.TryParse(value, out var parsed)
            ? parsed
            : throw new SettlementIntegrationException($"{field} must be a GUID for financial instruction execution.");
    }
}
