using CreditWalletService.Contracts;
using CreditWalletService.Infrastructure;

namespace CreditWalletService.Application;

public sealed class CreditWalletRecoveryService(
    CreditWalletRecoveryRepository recoveryRepository,
    CanonicalWalletOperationRepository operationRepository,
    ILogger<CreditWalletRecoveryService> logger)
{
    public async Task<WalletStartupRecoveryReport> RunStartupRecoveryAsync(
        CancellationToken cancellationToken)
    {
        var started = DateTimeOffset.UtcNow;
        var candidates = await recoveryRepository.ListRecoveryCandidatesAsync(500, cancellationToken);
        var recovered = 0;
        var blocked = 0;
        var conflicts = 0;
        foreach (var candidate in candidates)
        {
            var correlationId = $"wallet-startup-recovery-{Guid.NewGuid():N}";
            if (candidate.Classification == WalletRecoveryClassification.UNKNOWN)
            {
                var result = await RecoverAsync(candidate.OperationId, allowRetry: false,
                    trigger: "STARTUP", correlationId, cancellationToken);
                if (result.Classification == WalletRecoveryClassification.COMMITTED) recovered++;
                else blocked++;
            }
            else
            {
                var classification = candidate.Classification == WalletRecoveryClassification.CONFLICT
                    ? WalletRecoveryClassification.CONFLICT : WalletRecoveryClassification.BLOCKED;
                if (classification == WalletRecoveryClassification.CONFLICT) conflicts++; else blocked++;
                await recoveryRepository.AppendRecoveryEvidenceAsync(null,
                    candidate with { Classification = classification },
                    classification == WalletRecoveryClassification.CONFLICT ? "CONFLICT" : "BLOCKED",
                    classification == WalletRecoveryClassification.CONFLICT
                        ? "EFFECT_CARDINALITY_CONFLICT" : "AUTOMATIC_RETRY_DISABLED",
                    candidate, candidate, correlationId, cancellationToken);
            }
        }
        var completed = DateTimeOffset.UtcNow;
        var status = conflicts > 0 ? "FAILED" : blocked > 0 ? "COMPLETED_WITH_BLOCKED" : "COMPLETED";
        var hash = CanonicalWalletRequestHasher.ComputeEvidenceHash(new(StringComparer.Ordinal)
        {
            ["blocked"] = blocked, ["completed"] = completed.ToString("O"),
            ["conflicts"] = conflicts, ["recovered"] = recovered,
            ["scanned"] = candidates.Count, ["started"] = started.ToString("O"),
            ["status"] = status, ["trigger"] = "STARTUP"
        });
        var runId = await recoveryRepository.AppendRecoveryRunAsync("STARTUP", status,
            candidates.Count, recovered, blocked, conflicts, started, completed, hash, cancellationToken);
        logger.LogInformation(
            "Credit Wallet startup recovery completed. RunId={RecoveryRunId} Scanned={Scanned} Recovered={Recovered} Blocked={Blocked} Conflicts={Conflicts}",
            runId, candidates.Count, recovered, blocked, conflicts);
        return new(runId, status, candidates.Count, recovered, blocked, conflicts, completed);
    }

    public async Task<WalletRecoveryResult> RecoverAsync(
        Guid operationId, bool allowRetry, string trigger, string correlationId,
        CancellationToken cancellationToken)
    {
        var snapshot = await recoveryRepository.GetSnapshotAsync(operationId, cancellationToken)
            ?? throw new KeyNotFoundException("Canonical wallet operation was not found.");
        if (snapshot.Classification == WalletRecoveryClassification.COMMITTED)
        {
            var hash = await recoveryRepository.AppendRecoveryEvidenceAsync(null, snapshot, "REUSED",
                "COMMITTED_RESULT_REUSED", snapshot, snapshot, correlationId, cancellationToken);
            return new(operationId, snapshot.Classification, "REUSED", "COMMITTED_RESULT_REUSED",
                await recoveryRepository.GetResultHashAsync(operationId, cancellationToken), hash, correlationId);
        }
        if (snapshot.Classification is WalletRecoveryClassification.FAILED or WalletRecoveryClassification.CONFLICT ||
            snapshot.Operation is WalletOperationType.ISSUE or WalletOperationType.EXPIRE ||
            (snapshot.Classification == WalletRecoveryClassification.INCOMPLETE && !allowRetry))
        {
            var reason = snapshot.Classification == WalletRecoveryClassification.CONFLICT
                ? "EFFECT_CARDINALITY_CONFLICT" : snapshot.Classification == WalletRecoveryClassification.FAILED
                    ? "FAILED_OPERATION_IS_TERMINAL" : "GOVERNED_RETRY_REQUIRED";
            var blockedSnapshot = snapshot with { Classification = snapshot.Classification == WalletRecoveryClassification.CONFLICT
                ? WalletRecoveryClassification.CONFLICT : WalletRecoveryClassification.BLOCKED };
            var hash = await recoveryRepository.AppendRecoveryEvidenceAsync(null, blockedSnapshot,
                blockedSnapshot.Classification == WalletRecoveryClassification.CONFLICT ? "CONFLICT" : "BLOCKED",
                reason, snapshot, snapshot, correlationId, cancellationToken);
            return new(operationId, blockedSnapshot.Classification,
                blockedSnapshot.Classification == WalletRecoveryClassification.CONFLICT ? "CONFLICT" : "BLOCKED",
                reason, null, hash, correlationId);
        }

        var request = await recoveryRepository.LoadRequestAsync(operationId, cancellationToken)
            ?? throw new KeyNotFoundException("Canonical wallet request evidence was not found.");
        var recomputed = CanonicalWalletRequestHasher.Compute(request, snapshot.IdempotencyKey);
        if (!string.Equals(recomputed, snapshot.CanonicalRequestHash, StringComparison.Ordinal))
        {
            var conflict = snapshot with { Classification = WalletRecoveryClassification.CONFLICT };
            var hash = await recoveryRepository.AppendRecoveryEvidenceAsync(null, conflict, "CONFLICT",
                "CANONICAL_REQUEST_HASH_MISMATCH", snapshot, new { recomputed }, correlationId, cancellationToken);
            return new(operationId, WalletRecoveryClassification.CONFLICT, "CONFLICT",
                "CANONICAL_REQUEST_HASH_MISMATCH", null, hash, correlationId);
        }

        var response = snapshot.Classification == WalletRecoveryClassification.UNKNOWN
            ? await operationRepository.CompleteRecoveredEffectAsync(request, snapshot.IdempotencyKey,
                snapshot.CanonicalRequestHash, operationId, correlationId, cancellationToken)
            : await operationRepository.RecoverExistingAsync(request, snapshot.IdempotencyKey,
                snapshot.CanonicalRequestHash, operationId, correlationId, cancellationToken);
        var after = await recoveryRepository.GetSnapshotAsync(operationId, cancellationToken)
            ?? throw new InvalidOperationException("Recovered operation disappeared.");
        var action = snapshot.Classification == WalletRecoveryClassification.UNKNOWN ? "RECOVERED" : "RETRIED";
        var evidence = await recoveryRepository.AppendRecoveryEvidenceAsync(null, after, action,
            trigger == "STARTUP" ? "STARTUP_TERMINAL_RECONSTRUCTED" : "GOVERNED_CANONICAL_RETRY",
            snapshot, after, correlationId, cancellationToken);
        return new(operationId, after.Classification, action,
            trigger == "STARTUP" ? "STARTUP_TERMINAL_RECONSTRUCTED" : "GOVERNED_CANONICAL_RETRY",
            response.ResultHash, evidence, correlationId);
    }

    public async Task<WalletReplayResult> ReplayAsync(
        Guid operationId, string correlationId, CancellationToken cancellationToken)
    {
        var snapshot = await recoveryRepository.GetSnapshotAsync(operationId, cancellationToken)
            ?? throw new KeyNotFoundException("Canonical wallet operation was not found.");
        var request = await recoveryRepository.LoadRequestAsync(operationId, cancellationToken)
            ?? throw new KeyNotFoundException("Canonical wallet request evidence was not found.");
        var terminal = await recoveryRepository.GetTerminalEvidenceAsync(operationId, cancellationToken);
        var mismatches = new List<string>();
        mismatches.AddRange(await recoveryRepository.GetReplayReferenceMismatchesAsync(
            operationId, cancellationToken));
        var requestHash = CanonicalWalletRequestHasher.Compute(request, snapshot.IdempotencyKey);
        if (requestHash != snapshot.CanonicalRequestHash) mismatches.Add("CANONICAL_REQUEST_HASH_MISMATCH");
        if (terminal is null) mismatches.Add("TERMINAL_RESULT_MISSING");
        if (terminal?.Status == "COMMITTED" && snapshot.EffectCount != 1) mismatches.Add("EFFECT_CARDINALITY_MISMATCH");
        if (terminal?.ReferenceType != snapshot.EffectReferenceType || terminal?.ReferenceId != snapshot.EffectReferenceId)
            mismatches.Add("EFFECT_REFERENCE_MISMATCH");
        if (terminal is not null)
        {
            var replayResultHash = CanonicalWalletRequestHasher.ComputeEvidenceHash(new(StringComparer.Ordinal)
            {
                ["effectReferenceId"] = terminal.ReferenceId,
                ["effectReferenceType"] = terminal.ReferenceType,
                ["failureCode"] = terminal.FailureCode,
                ["failureReason"] = terminal.FailureReason,
                ["operationId"] = operationId.ToString("D"),
                ["resultPayload"] = terminal.Payload,
                ["terminalStatus"] = terminal.Status
            });
            if (replayResultHash != terminal.ResultHash) mismatches.Add("TERMINAL_RESULT_HASH_MISMATCH");
        }
        var result = terminal is null ? "BLOCKED" : mismatches.Count == 0 ? "MATCH" : "MISMATCH";
        var evidenceHash = await recoveryRepository.AppendReplayEvidenceAsync(snapshot, result,
            terminal?.ResultHash, mismatches, correlationId, cancellationToken);
        return new(operationId, result, snapshot.CanonicalRequestHash, terminal?.ResultHash,
            mismatches, evidenceHash, correlationId);
    }

    public Task<WalletProjectionVerificationResult?> VerifyProjectionAsync(
        Guid walletId, string correlationId, CancellationToken cancellationToken) =>
        recoveryRepository.VerifyProjectionAsync(walletId, correlationId, cancellationToken);

    public Task<WalletReconciliationResult> ReconcileLedgerAsync(
        string correlationId, CancellationToken cancellationToken) =>
        recoveryRepository.ReconcileLedgerAsync(correlationId, cancellationToken);

    public Task<WalletReconciliationResult> ReconcileSettlementAsync(
        string correlationId, CancellationToken cancellationToken) =>
        recoveryRepository.ReconcileSettlementAsync(correlationId, cancellationToken);
}
