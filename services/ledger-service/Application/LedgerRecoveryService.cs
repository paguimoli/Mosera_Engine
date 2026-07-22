using LedgerService.Contracts;
using LedgerService.Infrastructure;

namespace LedgerService.Application;

public sealed class LedgerRecoveryService(
    LedgerRecoveryRepository recoveryRepository,
    LedgerPostingEvidenceRepository postingEvidenceRepository,
    DurableLedgerRepository durableLedgerRepository,
    LedgerPostingService postingService)
{
    public Task<IReadOnlyList<Guid>> DiscoverIncompleteAsync(CancellationToken cancellationToken) =>
        recoveryRepository.ListIncompleteRequestIdsAsync(cancellationToken);

    public Task<LedgerRecoveryReadiness> CheckReadinessAsync(CancellationToken cancellationToken) =>
        recoveryRepository.CheckReadinessAsync(cancellationToken);

    public async Task<(LedgerRecoveryEventDto Evidence, LedgerPostingRequestDto Request, LedgerEntryDto? Entry)> RecoverPostingAsync(
        Guid requestId,
        CancellationToken cancellationToken)
    {
        var request = await postingEvidenceRepository.FindByIdAsync(requestId, cancellationToken)
            ?? throw new LedgerPostingRequestNotFoundException();
        var existingEntry = await durableLedgerRepository.FindByIdempotencyKeyAsync(request.IdempotencyKey, cancellationToken);

        if (request.Status == LedgerPostingRequestStatus.COMPLETED)
        {
            var completed = await postingService.RecoverAsync(requestId, cancellationToken);
            var evidence = await AppendRecoveryAsync(
                request,
                completed.PostingRequest.JournalTransactionId,
                request.RequestKind == "REVERSAL" ? "REVERSAL" : "POSTING_REQUEST",
                LedgerRecoveryClassification.COMPLETED_REUSED,
                null,
                cancellationToken);
            return (evidence, completed.PostingRequest, completed.LedgerEntry);
        }

        var initialClassification = existingEntry is null
            ? LedgerRecoveryClassification.NOT_COMMITTED
            : LedgerRecoveryClassification.MATCHED_COMMIT;
        await AppendRecoveryAsync(
            request,
            request.JournalTransactionId,
            request.RequestKind == "REVERSAL" ? "REVERSAL" : "POSTING_REQUEST",
            initialClassification,
            null,
            cancellationToken);

        try
        {
            var recovered = await postingService.RecoverAsync(requestId, cancellationToken);
            var finalClassification = existingEntry is null
                ? LedgerRecoveryClassification.RETRY_COMPLETED
                : LedgerRecoveryClassification.MATCHED_COMMIT;
            var evidence = await AppendRecoveryAsync(
                request,
                recovered.PostingRequest.JournalTransactionId,
                request.RequestKind == "REVERSAL" ? "REVERSAL" : "POSTING_REQUEST",
                finalClassification,
                null,
                cancellationToken);
            return (evidence, recovered.PostingRequest, recovered.LedgerEntry);
        }
        catch (Exception error) when (error is LedgerUnknownResultException or LedgerJournalException)
        {
            await AppendRecoveryAsync(
                request,
                request.JournalTransactionId,
                request.RequestKind == "REVERSAL" ? "REVERSAL" : "POSTING_REQUEST",
                LedgerRecoveryClassification.INCONCLUSIVE,
                error.Message,
                cancellationToken);
            throw;
        }
    }

    public async Task<LedgerRecoveryEventDto> VerifyJournalAsync(Guid requestId, CancellationToken cancellationToken)
    {
        var request = await postingEvidenceRepository.FindByIdAsync(requestId, cancellationToken)
            ?? throw new LedgerPostingRequestNotFoundException();
        try
        {
            var replay = await postingService.ReplayAsync(requestId, cancellationToken);
            return await AppendRecoveryAsync(
                request,
                request.JournalTransactionId,
                request.RequestKind == "REVERSAL" ? "REVERSAL" : "JOURNAL_TRANSACTION",
                replay.Result == LedgerReplayResult.MATCH
                    ? LedgerRecoveryClassification.JOURNAL_MATCH
                    : LedgerRecoveryClassification.JOURNAL_MISMATCH,
                replay.Mismatches.Count == 0 ? null : string.Join(" ", replay.Mismatches),
                cancellationToken);
        }
        catch (Exception error) when (error is LedgerUnknownResultException or LedgerJournalException)
        {
            return await AppendRecoveryAsync(
                request,
                request.JournalTransactionId,
                request.RequestKind == "REVERSAL" ? "REVERSAL" : "JOURNAL_TRANSACTION",
                LedgerRecoveryClassification.INCONCLUSIVE,
                error.Message,
                cancellationToken);
        }
    }

    public async Task<LedgerReconciliationEventDto> ReconcileSettlementInstructionAsync(
        Guid instructionId,
        CancellationToken cancellationToken)
    {
        var context = await recoveryRepository.LoadReconciliationContextAsync(instructionId, cancellationToken)
            ?? throw new LedgerReconciliationNotFoundException();
        var failures = new List<string>();
        var result = Classify(context, failures);
        var provenance = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["creditApplicationExists"] = context.CreditApplicationExists,
            ["creditInstructionId"] = context.CreditInstructionId,
            ["creditReference"] = context.CreditReference,
            ["expectedAmountMinor"] = context.ExpectedAmount,
            ["instructionHash"] = context.InstructionHash,
            ["instructionId"] = context.InstructionId,
            ["instructionType"] = context.InstructionType,
            ["ledgerTransactionId"] = context.LedgerTransactionId,
            ["postingRequestId"] = context.PostingRequestId,
            ["postingInstructionHash"] = context.PostingInstructionHash,
            ["postedAmountMinor"] = context.PostedAmount,
            ["postedCurrency"] = context.PostedCurrency,
            ["postingIdempotencyKey"] = context.PostingIdempotencyKey,
            ["settlementTargetIdempotencyKey"] = context.SettlementTargetIdempotencyKey,
            ["creditCanonicalOperationId"] = context.CreditCanonicalOperationId,
            ["creditCanonicalOperationIdempotencyKey"] = context.CreditCanonicalOperationIdempotencyKey,
            ["creditOperationSettlementTargetIdempotencyKey"] = context.CreditOperationSettlementTargetIdempotencyKey,
            ["creditCanonicalRequestHash"] = context.CreditCanonicalRequestHash,
            ["result"] = result.ToString(),
            ["settlementId"] = context.SettlementId
        };
        var evidenceHash = CanonicalLedgerRequestHasher.ComputeEvidenceHash(provenance);
        var record = await recoveryRepository.AppendReconciliationAsync(
            context,
            result,
            evidenceHash,
            failures.Count == 0 ? null : string.Join(" ", failures),
            provenance,
            cancellationToken);
        return ToDto(record);
    }

    public async Task<LedgerReconciliationEventDto?> FindReconciliationAsync(Guid instructionId, CancellationToken cancellationToken)
    {
        var record = await recoveryRepository.FindLatestReconciliationAsync(instructionId, cancellationToken);
        return record is null ? null : ToDto(record);
    }

    private async Task<LedgerRecoveryEventDto> AppendRecoveryAsync(
        LedgerPostingRequestRecord request,
        Guid? transactionId,
        string scope,
        LedgerRecoveryClassification classification,
        string? failureReason,
        CancellationToken cancellationToken)
    {
        var provenance = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["canonicalRequestHash"] = request.CanonicalRequestHash,
            ["classification"] = classification.ToString(),
            ["idempotencyKey"] = request.IdempotencyKey,
            ["postingRequestId"] = request.Id,
            ["requestKind"] = request.RequestKind,
            ["transactionId"] = transactionId
        };
        var evidenceHash = CanonicalLedgerRequestHasher.ComputeEvidenceHash(provenance);
        var record = await recoveryRepository.AppendRecoveryAsync(
            request.Id, transactionId, scope, classification, evidenceHash, failureReason, provenance, cancellationToken);
        return ToDto(record);
    }

    private static LedgerReconciliationResult Classify(
        SettlementInstructionReconciliationContext context,
        List<string> failures)
    {
        if (context.TargetService != "ledger-service")
        {
            failures.Add("Instruction is not a Ledger-targeted Settlement instruction.");
            return LedgerReconciliationResult.INCONCLUSIVE;
        }
        if (!context.PostingRequestId.HasValue || !context.LedgerTransactionId.HasValue)
        {
            failures.Add("Authoritative Ledger posting or balanced journal is missing.");
            return LedgerReconciliationResult.LEDGER_MISSING;
        }
        if (context.PostingStatus != LedgerPostingRequestStatus.COMPLETED)
        {
            failures.Add("Ledger posting request is not completed.");
            return LedgerReconciliationResult.STATUS_MISMATCH;
        }
        if (!string.Equals(context.InstructionHash, context.PostingInstructionHash, StringComparison.Ordinal)
            || context.PostingSettlementId != context.SettlementId
            || context.PostedAmount != context.ExpectedAmount
            || !string.Equals(context.PostedCurrency, context.Currency, StringComparison.Ordinal))
        {
            failures.Add("Settlement instruction and Ledger posting payloads differ.");
            return LedgerReconciliationResult.PAYLOAD_MISMATCH;
        }
        if (context.CreditInstructionId.HasValue)
        {
            if (string.IsNullOrWhiteSpace(context.CreditReference) || !context.CreditApplicationExists)
            {
                failures.Add("Paired Credit Wallet settlement application is missing.");
                return LedgerReconciliationResult.CREDIT_MISSING;
            }
            if (!context.CreditCanonicalOperationId.HasValue
                || string.IsNullOrWhiteSpace(context.CreditCanonicalOperationIdempotencyKey)
                || string.IsNullOrWhiteSpace(context.CreditCanonicalRequestHash)
                || !string.Equals(context.CreditApplicationSettlementId, context.SettlementId.ToString(), StringComparison.OrdinalIgnoreCase)
                || !string.Equals(
                    context.CreditOperationSettlementTargetIdempotencyKey,
                    context.SettlementTargetIdempotencyKey,
                    StringComparison.Ordinal))
            {
                failures.Add(
                    "Credit Wallet canonical operation does not preserve the Settlement target instruction scope.");
                return LedgerReconciliationResult.PAYLOAD_MISMATCH;
            }
        }
        return LedgerReconciliationResult.RECONCILED;
    }

    private static LedgerRecoveryEventDto ToDto(LedgerRecoveryEventRecord record) => new(
        record.EventId, record.PostingRequestId, record.LedgerTransactionId, record.RecoveryScope,
        record.Classification, record.EvidenceHash, record.FailureReason, record.Provenance, record.CreatedAt);

    private static LedgerReconciliationEventDto ToDto(LedgerReconciliationEventRecord record) => new(
        record.EventId, record.SettlementInstructionId, record.PostingRequestId, record.LedgerTransactionId,
        record.CreditInstructionId, record.CreditReference, record.Result, record.EvidenceHash,
        record.FailureReason, record.Provenance, record.CreatedAt);
}
