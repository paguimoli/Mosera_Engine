using SettlementService.Contracts;
using SettlementService.Infrastructure;

namespace SettlementService.Application;

public sealed class SettlementRecoveryService(
    FinancialInstructionRepository repository,
    FinancialInstructionExecutionService executionService)
{
    public async Task<SettlementRecoveryStatusDto> GetSettlementStatusAsync(
        Guid settlementId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var contexts = await repository.ListExecutionContextsAsync(settlementId, cancellationToken);
        if (contexts.Count == 0)
        {
            throw new FinancialInstructionValidationException(["Financial instructions were not found for settlement."]);
        }

        var instructionStatuses = new List<InstructionRecoveryStatusDto>();
        foreach (var context in contexts.OrderBy(item => item.Instruction.InstructionSequence))
        {
            instructionStatuses.Add(await BuildInstructionStatusAsync(context, cancellationToken));
        }

        return new SettlementRecoveryStatusDto(
            settlementId,
            ClassifySettlement(instructionStatuses),
            instructionStatuses,
            correlationId);
    }

    public async Task<IReadOnlyList<InstructionRecoveryStatusDto>> DiscoverIncompleteInstructionsAsync(
        CancellationToken cancellationToken)
    {
        var contexts = await repository.ListIncompleteExecutionContextsAsync(cancellationToken);
        var statuses = new List<InstructionRecoveryStatusDto>();
        foreach (var context in contexts)
        {
            statuses.Add(await BuildInstructionStatusAsync(context, cancellationToken));
        }

        return statuses;
    }

    public async Task<SettlementRecoveryResult> RecoverSettlementAsync(
        SettlementRecoveryRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var contexts = await repository.ListExecutionContextsAsync(request.SettlementId, cancellationToken);
        if (contexts.Count == 0)
        {
            throw new FinancialInstructionValidationException(["Financial instructions were not found for settlement recovery."]);
        }

        var results = new List<InstructionRecoveryResult>();
        foreach (var context in contexts.OrderBy(item => item.Instruction.InstructionSequence))
        {
            results.Add(await RecoverContextAsync(
                context,
                request.RetryApproved,
                request.Reason,
                correlationId,
                cancellationToken));
        }

        var state = ClassifySettlement(results.Select(item => new InstructionRecoveryStatusDto(
            item.InstructionId,
            request.SettlementId,
            FinancialInstructionType.LEDGER_NOOP,
            FinancialInstructionStatus.Ready,
            item.RecoveryState,
            false,
            false,
            false,
            item.ExecutionResult?.Attempt,
            item.RecoveryEvent,
            null)).ToList());

        return new SettlementRecoveryResult(request.SettlementId, state, results, correlationId);
    }

    public async Task<InstructionRecoveryResult> RecoverInstructionAsync(
        InstructionRecoveryRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var context = await repository.GetExecutionContextAsync(request.InstructionId, cancellationToken)
            ?? throw new FinancialInstructionValidationException(["Financial instruction was not found."]);

        return await RecoverContextAsync(
            context,
            request.RetryApproved,
            request.Reason,
            correlationId,
            cancellationToken);
    }

    public async Task<InstructionRecoveryResult> VerifyUnknownInstructionAsync(
        UnknownInstructionVerificationRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var context = await repository.GetExecutionContextAsync(request.InstructionId, cancellationToken)
            ?? throw new FinancialInstructionValidationException(["Financial instruction was not found."]);
        var instruction = context.Instruction;
        var targetKey = FinancialInstructionExecutionService.BuildTargetIdempotencyKey(instruction);
        var attempts = await repository.ListExecutionAttemptsAsync(instruction.InstructionId, cancellationToken);
        var latest = attempts.LastOrDefault();

        if (attempts.Any(IsTerminal))
        {
            var alreadyTerminal = attempts.Last(IsTerminal);
            var alreadyEvent = await repository.AppendRecoveryEventAsync(
                instruction.SettlementId,
                instruction.InstructionId,
                alreadyTerminal.AttemptId,
                SettlementRecoveryState.SettlementCompleted,
                "already-terminal",
                "Committed",
                request.Reason,
                cancellationToken);
            return new InstructionRecoveryResult(
                instruction.InstructionId,
                SettlementRecoveryState.SettlementCompleted,
                "AlreadyTerminal",
                new FinancialInstructionExecutionResult("Reused", true, instruction, alreadyTerminal, correlationId),
                alreadyEvent,
                correlationId);
        }

        if (request.Outcome == TargetVerificationOutcome.Unknown)
        {
            var awaiting = await repository.AppendRecoveryEventAsync(
                instruction.SettlementId,
                instruction.InstructionId,
                latest?.AttemptId,
                SettlementRecoveryState.SettlementAwaitingVerification,
                "preserve-awaiting-verification",
                "Unknown",
                request.Reason,
                cancellationToken);
            return new InstructionRecoveryResult(
                instruction.InstructionId,
                SettlementRecoveryState.SettlementAwaitingVerification,
                "AwaitingVerification",
                null,
                awaiting,
                correlationId);
        }

        if (request.Outcome == TargetVerificationOutcome.Committed)
        {
            var posted = await repository.AppendExecutionAttemptAsync(
                instruction,
                IsNoop(instruction.InstructionType)
                    ? FinancialInstructionExecutionAttemptStatus.Skipped
                    : FinancialInstructionExecutionAttemptStatus.Posted,
                targetKey,
                request.ExternalReferenceType ?? (IsNoop(instruction.InstructionType) ? "verified_noop" : "verified_target_commit"),
                request.ExternalReferenceId ?? "VERIFIED_COMMITTED",
                request.TargetResponseHash ?? FinancialInstructionService.HashCanonical($"verified:{instruction.InstructionId:N}:{targetKey}"),
                null,
                null,
                cancellationToken);
            var eventDto = await repository.AppendRecoveryEventAsync(
                instruction.SettlementId,
                instruction.InstructionId,
                posted.AttemptId,
                SettlementRecoveryState.SettlementCompleted,
                "verified-committed-marked-posted",
                "Committed",
                request.Reason,
                cancellationToken);
            return new InstructionRecoveryResult(
                instruction.InstructionId,
                SettlementRecoveryState.SettlementCompleted,
                "VerifiedCommitted",
                new FinancialInstructionExecutionResult(posted.Status.ToString(), false, instruction, posted, correlationId),
                eventDto,
                correlationId);
        }

        var verifiedNotCommitted = await repository.AppendRecoveryEventAsync(
            instruction.SettlementId,
            instruction.InstructionId,
            latest?.AttemptId,
            SettlementRecoveryState.InstructionReady,
            "verified-not-committed-resume-once",
            "NotCommitted",
            request.Reason,
            cancellationToken);
        var executionResult = await executionService.RetryAsync(
            new FinancialInstructionRetryRequest(instruction.InstructionId, request.Reason ?? "Verified target not committed; recovery retry approved."),
            correlationId,
            cancellationToken);
        return new InstructionRecoveryResult(
            instruction.InstructionId,
            executionResult.Status == "Failed" ? SettlementRecoveryState.InstructionFailed : SettlementRecoveryState.SettlementCompleted,
            "VerifiedNotCommitted",
            executionResult,
            verifiedNotCommitted,
            correlationId);
    }

    public async Task<InstructionReconciliationResult> ReconcileInstructionAsync(
        InstructionReconciliationRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var context = await repository.GetExecutionContextAsync(request.InstructionId, cancellationToken)
            ?? throw new FinancialInstructionValidationException(["Financial instruction was not found."]);
        var instruction = context.Instruction;
        var targetKey = FinancialInstructionExecutionService.BuildTargetIdempotencyKey(instruction);
        var attempts = await repository.ListExecutionAttemptsAsync(instruction.InstructionId, cancellationToken);
        var terminal = attempts.LastOrDefault(IsTerminal);
        var latest = attempts.LastOrDefault();

        var status = InstructionReconciliationStatus.MissingTargetRecord;
        var matched = false;
        string? externalReferenceType = request.ExternalReferenceType;
        string? externalReferenceId = request.ExternalReferenceId;
        string? targetResponseHash = request.TargetResponseHash;
        Guid? attemptId = latest?.AttemptId;

        if (terminal is not null)
        {
            attemptId = terminal.AttemptId;
            externalReferenceType ??= terminal.ExternalReferenceType;
            externalReferenceId ??= terminal.ExternalReferenceId;
            targetResponseHash ??= terminal.TargetResponseHash;
            var keyMatches = string.IsNullOrWhiteSpace(request.TargetIdempotencyKey) ||
                string.Equals(request.TargetIdempotencyKey, terminal.TargetIdempotencyKey, StringComparison.Ordinal);
            var typeMatches = string.IsNullOrWhiteSpace(request.ExternalReferenceType) ||
                string.Equals(request.ExternalReferenceType, terminal.ExternalReferenceType, StringComparison.Ordinal);
            var idMatches = string.IsNullOrWhiteSpace(request.ExternalReferenceId) ||
                string.Equals(request.ExternalReferenceId, terminal.ExternalReferenceId, StringComparison.Ordinal);
            var hashMatches = string.IsNullOrWhiteSpace(request.TargetResponseHash) ||
                string.Equals(request.TargetResponseHash, terminal.TargetResponseHash, StringComparison.Ordinal);

            matched = keyMatches && typeMatches && idMatches && hashMatches;
            status = matched ? InstructionReconciliationStatus.Reconciled : InstructionReconciliationStatus.Mismatch;
        }
        else if (latest is not null && IsUnknownFailure(latest))
        {
            status = InstructionReconciliationStatus.AwaitingVerification;
            externalReferenceType ??= latest.ExternalReferenceType;
            externalReferenceId ??= latest.ExternalReferenceId;
            targetResponseHash ??= latest.TargetResponseHash;
        }

        var eventDto = await repository.AppendReconciliationEventAsync(
            instruction,
            attemptId,
            status,
            request.TargetIdempotencyKey ?? targetKey,
            externalReferenceType,
            externalReferenceId,
            targetResponseHash,
            cancellationToken);

        return new InstructionReconciliationResult(
            instruction.InstructionId,
            status,
            matched,
            status is InstructionReconciliationStatus.Mismatch or InstructionReconciliationStatus.AwaitingVerification,
            eventDto,
            correlationId);
    }

    public async Task<SettlementRecoveryStatusDto> ReplaySettlementDecisionAsync(
        Guid settlementId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        return await GetSettlementStatusAsync(settlementId, correlationId, cancellationToken);
    }

    public async Task<SettlementRecoveryReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var readiness = await repository.CheckReadinessAsync(cancellationToken);
        return new SettlementRecoveryReadiness(
            readiness.Configured,
            readiness.RepositoryReachable,
            readiness.RepositoryReachable,
            readiness.RepositoryReachable,
            readiness.RepositoryReachable,
            readiness.RepositoryReachable,
            readiness.RepositoryReachable,
            true,
            readiness.Blockers);
    }

    private async Task<InstructionRecoveryResult> RecoverContextAsync(
        FinancialInstructionExecutionContext context,
        bool retryApproved,
        string? reason,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var instruction = context.Instruction;
        var status = await BuildInstructionStatusAsync(context, cancellationToken);
        var latestAttempt = status.LatestAttempt;

        if (status.RecoveryState == SettlementRecoveryState.SettlementCompleted)
        {
            var eventDto = await repository.AppendRecoveryEventAsync(
                instruction.SettlementId,
                instruction.InstructionId,
                latestAttempt?.AttemptId,
                SettlementRecoveryState.SettlementCompleted,
                "already-complete",
                "Committed",
                reason,
                cancellationToken);
            return new InstructionRecoveryResult(instruction.InstructionId, status.RecoveryState, "AlreadyComplete", null, eventDto, correlationId);
        }

        if (status.RequiresVerification)
        {
            var eventDto = await repository.AppendRecoveryEventAsync(
                instruction.SettlementId,
                instruction.InstructionId,
                latestAttempt?.AttemptId,
                SettlementRecoveryState.SettlementAwaitingVerification,
                "verification-required-before-retry",
                "Unknown",
                reason,
                cancellationToken);
            return new InstructionRecoveryResult(instruction.InstructionId, SettlementRecoveryState.SettlementAwaitingVerification, "AwaitingVerification", null, eventDto, correlationId);
        }

        if (status.RequiresApproval && !retryApproved)
        {
            var eventDto = await repository.AppendRecoveryEventAsync(
                instruction.SettlementId,
                instruction.InstructionId,
                latestAttempt?.AttemptId,
                SettlementRecoveryState.SettlementAwaitingRecovery,
                "retry-approval-required",
                "NotCommitted",
                reason,
                cancellationToken);
            return new InstructionRecoveryResult(instruction.InstructionId, SettlementRecoveryState.SettlementAwaitingRecovery, "RetryApprovalRequired", null, eventDto, correlationId);
        }

        var execution = status.RequiresApproval
            ? await executionService.RetryAsync(
                new FinancialInstructionRetryRequest(instruction.InstructionId, reason ?? "Settlement recovery approved retry."),
                correlationId,
                cancellationToken)
            : await executionService.ExecuteAsync(
                new FinancialInstructionExecutionRequest(instruction.InstructionId),
                correlationId,
                cancellationToken);
        var recoveredState = execution.Status == "Failed"
            ? SettlementRecoveryState.InstructionFailed
            : SettlementRecoveryState.SettlementCompleted;
        var recoveredEvent = await repository.AppendRecoveryEventAsync(
            instruction.SettlementId,
            instruction.InstructionId,
            execution.Attempt.AttemptId,
            recoveredState,
            execution.Status == "Failed" ? "execution-failed-preserved" : "missing-work-resumed",
            execution.Status == "Failed" ? "NotCommitted" : "Committed",
            reason,
            cancellationToken);

        return new InstructionRecoveryResult(instruction.InstructionId, recoveredState, "Resumed", execution, recoveredEvent, correlationId);
    }

    private async Task<InstructionRecoveryStatusDto> BuildInstructionStatusAsync(
        FinancialInstructionExecutionContext context,
        CancellationToken cancellationToken)
    {
        var attempts = await repository.ListExecutionAttemptsAsync(context.Instruction.InstructionId, cancellationToken);
        var latestAttempt = attempts.LastOrDefault();
        var terminalAttempt = attempts.LastOrDefault(IsTerminal);
        var latestRecovery = await repository.GetLatestRecoveryEventAsync(context.Instruction.InstructionId, cancellationToken);
        var latestReconciliation = await repository.GetLatestReconciliationEventAsync(context.Instruction.InstructionId, cancellationToken);

        if (terminalAttempt is not null)
        {
            return BuildStatus(context, SettlementRecoveryState.SettlementCompleted, false, false, false, terminalAttempt, latestRecovery, latestReconciliation);
        }

        if (latestAttempt is not null && latestAttempt.Status == FinancialInstructionExecutionAttemptStatus.Failed)
        {
            return IsUnknownFailure(latestAttempt)
                ? BuildStatus(context, SettlementRecoveryState.InstructionUnknownResult, false, false, true, latestAttempt, latestRecovery, latestReconciliation)
                : BuildStatus(context, SettlementRecoveryState.InstructionFailed, false, true, false, latestAttempt, latestRecovery, latestReconciliation);
        }

        var state = context.Instruction.InstructionStatus == FinancialInstructionStatus.Skipped
            ? SettlementRecoveryState.InstructionReady
            : context.Instruction.InstructionStatus == FinancialInstructionStatus.Pending
                ? SettlementRecoveryState.InstructionPending
                : SettlementRecoveryState.InstructionReady;

        return BuildStatus(context, state, state == SettlementRecoveryState.InstructionReady, false, false, latestAttempt, latestRecovery, latestReconciliation);
    }

    private static InstructionRecoveryStatusDto BuildStatus(
        FinancialInstructionExecutionContext context,
        SettlementRecoveryState state,
        bool canResume,
        bool requiresApproval,
        bool requiresVerification,
        FinancialInstructionExecutionAttemptDto? latestAttempt,
        RecoveryEventDto? latestRecovery,
        ReconciliationEventDto? latestReconciliation)
    {
        return new InstructionRecoveryStatusDto(
            context.Instruction.InstructionId,
            context.Instruction.SettlementId,
            context.Instruction.InstructionType,
            context.Instruction.InstructionStatus,
            state,
            canResume,
            requiresApproval,
            requiresVerification,
            latestAttempt,
            latestRecovery,
            latestReconciliation);
    }

    private static SettlementRecoveryState ClassifySettlement(IReadOnlyList<InstructionRecoveryStatusDto> instructions)
    {
        if (instructions.Count == 0)
        {
            return SettlementRecoveryState.SettlementFailed;
        }

        if (instructions.All(item => item.RecoveryState == SettlementRecoveryState.SettlementCompleted))
        {
            return SettlementRecoveryState.SettlementCompleted;
        }

        if (instructions.Any(item => item.RequiresVerification || item.RecoveryState == SettlementRecoveryState.InstructionUnknownResult))
        {
            return SettlementRecoveryState.SettlementAwaitingVerification;
        }

        if (instructions.Any(item => item.RequiresApproval || item.RecoveryState == SettlementRecoveryState.InstructionFailed))
        {
            return instructions.Any(item => item.RecoveryState == SettlementRecoveryState.SettlementCompleted)
                ? SettlementRecoveryState.SettlementPartiallyExecuted
                : SettlementRecoveryState.SettlementAwaitingRecovery;
        }

        return instructions.Any(item => item.RecoveryState == SettlementRecoveryState.SettlementCompleted)
            ? SettlementRecoveryState.SettlementPartiallyExecuted
            : SettlementRecoveryState.SettlementAwaitingRecovery;
    }

    private static bool IsTerminal(FinancialInstructionExecutionAttemptDto attempt)
    {
        return attempt.Status is FinancialInstructionExecutionAttemptStatus.Posted or FinancialInstructionExecutionAttemptStatus.Skipped;
    }

    private static bool IsUnknownFailure(FinancialInstructionExecutionAttemptDto attempt)
    {
        return attempt.Status == FinancialInstructionExecutionAttemptStatus.Failed &&
            (string.Equals(attempt.ErrorClassification, nameof(TaskCanceledException), StringComparison.Ordinal) ||
             string.Equals(attempt.ErrorClassification, nameof(HttpRequestException), StringComparison.Ordinal));
    }

    private static bool IsNoop(FinancialInstructionType instructionType)
    {
        return instructionType is FinancialInstructionType.LEDGER_NOOP or FinancialInstructionType.CREDIT_NOOP;
    }
}
