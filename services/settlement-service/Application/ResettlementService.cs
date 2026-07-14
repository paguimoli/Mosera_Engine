using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SettlementService.Contracts;
using SettlementService.Infrastructure;

namespace SettlementService.Application;

public sealed class ResettlementService(
    ResettlementRepository repository,
    FinancialInstructionRepository financialInstructionRepository,
    SettlementInputIngestionRepository settlementInputRepository,
    SettlementInputIngestionService ingestionService,
    SettlementExecutionService executionService,
    FinancialInstructionService instructionService,
    FinancialInstructionExecutionService instructionExecutionService)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    private static readonly HashSet<string> SupportedReasonCodes = new(StringComparer.Ordinal)
    {
        "MATH_CORRECTION",
        "RESULT_CORRECTION",
        "VOID_CORRECTION",
        "OPERATOR_CORRECTION"
    };

    public async Task<ResettlementResult> CreateAsync(
        ResettlementCreateRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var validation = await ValidateCreateAsync(request, cancellationToken);
        if (!validation.IsValid)
        {
            throw new ResettlementValidationException(validation.Errors);
        }

        var canonicalHash = BuildCanonicalRequestHash(request);
        var (stored, ev, duplicate) = await repository.ClaimRequestAsync(request, canonicalHash, cancellationToken);
        var chain = await repository.GetChainAsync(stored.ResettlementRequestId, cancellationToken);
        return new ResettlementResult(stored, chain, ev, duplicate, correlationId);
    }

    public async Task<ResettlementValidationResult> ValidateAsync(Guid requestId, CancellationToken cancellationToken)
    {
        var request = await repository.GetRequestAsync(requestId, cancellationToken);
        if (request is null)
        {
            return new ResettlementValidationResult(false, ["Resettlement request was not found."]);
        }

        var create = new ResettlementCreateRequest(
            request.ResettlementRequestId,
            request.IdempotencyKey,
            request.OriginalSettlementId,
            request.OriginalSettlementHash,
            request.OriginalSettlementInputId,
            request.OriginalSettlementInputHash,
            request.CorrectedSettlementInputId,
            request.CorrectedSettlementInputHash,
            request.OriginalMathEvaluationCertificateId,
            request.OriginalMathEvaluationCertificateHash,
            request.CorrectedMathEvaluationCertificateId,
            request.CorrectedMathEvaluationCertificateHash,
            request.ReasonCode,
            request.RequestorReference,
            request.ApprovalMetadata,
            request.RequestedAt,
            request.Provenance,
            request.Mode);
        return await ValidateCreateAsync(create, cancellationToken);
    }

    public async Task<ResettlementResult> ExecuteOrResumeAsync(
        ResettlementExecuteRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var storedRequest = await repository.GetRequestAsync(request.ResettlementRequestId, cancellationToken)
            ?? throw new ResettlementValidationException(["Resettlement request was not found."]);
        var validation = await ValidateAsync(request.ResettlementRequestId, cancellationToken);
        if (!validation.IsValid)
        {
            await repository.AppendEventAsync(
                request.ResettlementRequestId,
                null,
                ResettlementLifecycleState.Failed,
                "ValidationFailed",
                validation.Errors,
                cancellationToken);
            throw new ResettlementValidationException(validation.Errors);
        }

        var existingChain = await repository.GetChainAsync(request.ResettlementRequestId, cancellationToken);
        if (existingChain is not null)
        {
            var duplicateEvent = await repository.AppendEventAsync(
                request.ResettlementRequestId,
                existingChain.ResettlementRecordId,
                ResettlementLifecycleState.Completed,
                "DuplicateExecutionReused",
                [],
                cancellationToken);
            return new ResettlementResult(storedRequest, existingChain, duplicateEvent, true, correlationId);
        }

        await repository.AppendEventAsync(
            request.ResettlementRequestId,
            null,
            ResettlementLifecycleState.Validated,
            "Validated",
            [],
            cancellationToken);

        var original = await financialInstructionRepository.GetSettlementRecordAsync(
            storedRequest.OriginalSettlementId,
            cancellationToken)
            ?? throw new ResettlementValidationException(["Original SettlementRecord was not found."]);
        var originalRequest = await repository.GetSettlementRequestContextAsync(
            original.SettlementRequestId,
            cancellationToken)
            ?? throw new ResettlementValidationException(["Original settlement request context was not found."]);
        var correctedInput = await settlementInputRepository.GetSettlementInputAsync(
            storedRequest.CorrectedSettlementInputId,
            cancellationToken)
            ?? throw new ResettlementValidationException(["Corrected SettlementInput was not found."]);

        var reversal = await repository.CreateReversalRecordAsync(storedRequest, original, cancellationToken);
        await repository.InsertReversalInstructionsAsync(storedRequest, original, reversal, cancellationToken);

        if (request.ExecuteFinancialInstructions)
        {
            await repository.AppendEventAsync(
                request.ResettlementRequestId,
                null,
                ResettlementLifecycleState.ReversalExecuting,
                "ReversalExecutionRequested",
                [],
                cancellationToken);
            var reversalExecution = await instructionExecutionService.ExecuteSettlementAsync(
                new FinancialInstructionSettlementExecutionRequest(reversal.SettlementId),
                correlationId,
                cancellationToken);
            if (reversalExecution.Results.Any(result => result.Status == "Failed"))
            {
                var ev = await repository.AppendEventAsync(
                    request.ResettlementRequestId,
                    null,
                    ResettlementLifecycleState.AwaitingVerification,
                    "ReversalExecutionAwaitingVerification",
                    reversalExecution.Results
                        .Where(result => result.Status == "Failed")
                        .Select(result => result.Attempt.ErrorMessage ?? "Reversal instruction failed.")
                        .ToArray(),
                    cancellationToken);
                return new ResettlementResult(storedRequest, null, ev, false, correlationId);
            }
        }

        var correctedIngestion = await ingestionService.IngestAsync(
            BuildCorrectedIngestionRequest(storedRequest, originalRequest, correctedInput),
            correlationId,
            cancellationToken);
        await repository.AppendEventAsync(
            request.ResettlementRequestId,
            null,
            ResettlementLifecycleState.CorrectionPrepared,
            "CorrectionPrepared",
            [],
            cancellationToken);

        var correctedExecution = await executionService.ExecuteAsync(
            new SettlementExecutionRequest(
                correctedIngestion.SettlementRequestId,
                correctedIngestion.IdempotencyKey,
                SettlementExecutionMode.DryRun),
            correlationId,
            cancellationToken);
        var correctedInstructions = await instructionService.GenerateAsync(
            new FinancialInstructionGenerationRequest(correctedExecution.SettlementRecord.SettlementId),
            correlationId,
            cancellationToken);

        if (request.ExecuteFinancialInstructions)
        {
            await repository.AppendEventAsync(
                request.ResettlementRequestId,
                null,
                ResettlementLifecycleState.CorrectionExecuting,
                "CorrectionExecutionRequested",
                [],
                cancellationToken);
            var correctionExecution = await instructionExecutionService.ExecuteSettlementAsync(
                new FinancialInstructionSettlementExecutionRequest(correctedExecution.SettlementRecord.SettlementId),
                correlationId,
                cancellationToken);
            if (correctionExecution.Results.Any(result => result.Status == "Failed"))
            {
                var ev = await repository.AppendEventAsync(
                    request.ResettlementRequestId,
                    null,
                    ResettlementLifecycleState.AwaitingVerification,
                    "CorrectionExecutionAwaitingVerification",
                    correctionExecution.Results
                        .Where(result => result.Status == "Failed")
                        .Select(result => result.Attempt.ErrorMessage ?? "Correction instruction failed.")
                        .ToArray(),
                    cancellationToken);
                return new ResettlementResult(storedRequest, null, ev, false, correlationId);
            }
        }

        if (correctedInstructions.Instructions.Count == 0)
        {
            throw new ResettlementValidationException(["Corrected settlement financial instructions were not generated."]);
        }

        var chain = await repository.CreateChainAsync(
            storedRequest,
            original,
            reversal,
            correctedExecution.SettlementRecord,
            cancellationToken);
        var completed = await repository.AppendEventAsync(
            request.ResettlementRequestId,
            chain.ResettlementRecordId,
            ResettlementLifecycleState.Completed,
            request.ExecuteFinancialInstructions ? "CompletedWithInstructionExecution" : "CompletedPostingDisabled",
            [],
            cancellationToken);

        return new ResettlementResult(storedRequest, chain, completed, false, correlationId);
    }

    public async Task<ResettlementResult> RetryAsync(
        ResettlementRetryRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Reason))
        {
            throw new ResettlementValidationException(["Governed retry reason is required."]);
        }

        await repository.AppendEventAsync(
            request.ResettlementRequestId,
            null,
            ResettlementLifecycleState.Requested,
            "GovernedRetryRequested",
            [],
            cancellationToken);
        return await ExecuteOrResumeAsync(
            new ResettlementExecuteRequest(request.ResettlementRequestId, false),
            correlationId,
            cancellationToken);
    }

    public async Task<ResettlementResult> CancelAsync(
        ResettlementCancelRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Reason))
        {
            throw new ResettlementValidationException(["Cancellation reason is required."]);
        }

        var stored = await repository.GetRequestAsync(request.ResettlementRequestId, cancellationToken)
            ?? throw new ResettlementValidationException(["Resettlement request was not found."]);
        var chain = await repository.GetChainAsync(request.ResettlementRequestId, cancellationToken);
        if (chain is not null)
        {
            var reversalExecuted = await repository.HasFinancialExecutionAsync(chain.ReversalSettlementId, cancellationToken);
            var correctionExecuted = await repository.HasFinancialExecutionAsync(chain.CorrectedSettlementId, cancellationToken);
            if (reversalExecuted || correctionExecuted)
            {
                throw new ResettlementValidationException(["Resettlement cannot be cancelled after financial instruction execution has posted."]);
            }
        }

        var ev = await repository.AppendEventAsync(
            request.ResettlementRequestId,
            chain?.ResettlementRecordId,
            ResettlementLifecycleState.CancelledBeforeExecution,
            "CancelledBeforeExecution",
            [],
            cancellationToken);
        return new ResettlementResult(stored, chain, ev, false, correlationId);
    }

    public async Task<(ResettlementRequestDto Request, ResettlementChainDto? Chain, IReadOnlyList<ResettlementEventDto> Events)> GetChainAsync(
        Guid requestId,
        CancellationToken cancellationToken)
    {
        var request = await repository.GetRequestAsync(requestId, cancellationToken)
            ?? throw new ResettlementValidationException(["Resettlement request was not found."]);
        var chain = await repository.GetChainAsync(requestId, cancellationToken);
        var events = await repository.ListEventsAsync(requestId, cancellationToken);
        return (request, chain, events);
    }

    public Task<ResettlementReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        return repository.CheckReadinessAsync(cancellationToken);
    }

    private async Task<ResettlementValidationResult> ValidateCreateAsync(
        ResettlementCreateRequest request,
        CancellationToken cancellationToken)
    {
        var errors = new List<string>();
        RequireText(request.IdempotencyKey, "idempotencyKey", errors);
        RequireText(request.OriginalSettlementHash, "originalSettlementHash", errors);
        RequireText(request.OriginalSettlementInputHash, "originalSettlementInputHash", errors);
        RequireText(request.CorrectedSettlementInputHash, "correctedSettlementInputHash", errors);
        RequireText(request.OriginalMathEvaluationCertificateHash, "originalMathEvaluationCertificateHash", errors);
        RequireText(request.CorrectedMathEvaluationCertificateHash, "correctedMathEvaluationCertificateHash", errors);
        RequireText(request.RequestorReference, "requestorReference", errors);

        if (request.Mode != ResettlementMode.DryRun)
        {
            errors.Add("Production resettlement is disabled; mode must be DryRun.");
        }

        if (!SupportedReasonCodes.Contains(request.ReasonCode))
        {
            errors.Add("Unsupported resettlement reasonCode.");
        }

        if (request.OriginalSettlementInputId == request.CorrectedSettlementInputId ||
            string.Equals(request.OriginalSettlementInputHash, request.CorrectedSettlementInputHash, StringComparison.Ordinal))
        {
            errors.Add("Corrected SettlementInput must differ from original SettlementInput.");
        }

        var original = await financialInstructionRepository.GetSettlementRecordAsync(
            request.OriginalSettlementId,
            cancellationToken);
        if (original is null)
        {
            errors.Add("Original SettlementRecord was not found.");
            return new ResettlementValidationResult(false, errors);
        }

        if (!string.Equals(original.CanonicalSettlementHash, request.OriginalSettlementHash, StringComparison.Ordinal))
        {
            errors.Add("Original SettlementRecord hash mismatch.");
        }

        if (original.SettlementInputId != request.OriginalSettlementInputId ||
            !string.Equals(original.SettlementInputHash, request.OriginalSettlementInputHash, StringComparison.Ordinal))
        {
            errors.Add("Original SettlementInput reference/hash mismatch.");
        }

        if (original.MathEvaluationCertificateId != request.OriginalMathEvaluationCertificateId ||
            !string.Equals(original.MathEvaluationCertificateHash, request.OriginalMathEvaluationCertificateHash, StringComparison.Ordinal))
        {
            errors.Add("Original Math Evaluation Certificate reference/hash mismatch.");
        }

        var originalRequest = await repository.GetSettlementRequestContextAsync(
            original.SettlementRequestId,
            cancellationToken);
        if (originalRequest is null)
        {
            errors.Add("Original settlement request context was not found.");
            return new ResettlementValidationResult(false, errors);
        }

        var correctedInput = await settlementInputRepository.GetSettlementInputAsync(
            request.CorrectedSettlementInputId,
            cancellationToken);
        if (correctedInput is null)
        {
            errors.Add("Corrected SettlementInput was not found.");
            return new ResettlementValidationResult(false, errors);
        }

        if (!string.Equals(correctedInput.SettlementInputHash, request.CorrectedSettlementInputHash, StringComparison.Ordinal))
        {
            errors.Add("Corrected SettlementInput hash mismatch.");
        }

        if (correctedInput.MathEvaluationCertificateId != request.CorrectedMathEvaluationCertificateId ||
            !string.Equals(correctedInput.MathEvaluationCertificateHash, request.CorrectedMathEvaluationCertificateHash, StringComparison.Ordinal))
        {
            errors.Add("Corrected Math Evaluation Certificate reference/hash mismatch.");
        }

        if (!TicketReferenceMatches(correctedInput.TicketReference, originalRequest.TicketId, originalRequest.TicketLineId))
        {
            errors.Add("Corrected SettlementInput ticket/wager scope does not match original accepted wager scope.");
        }

        return new ResettlementValidationResult(errors.Count == 0, errors);
    }

    private static SettlementInputIngestionRequest BuildCorrectedIngestionRequest(
        ResettlementRequestDto request,
        ResettlementSettlementRequestContext original,
        StoredSettlementInputDto correctedInput)
    {
        var correctedRequestId = CreateDeterministicGuid($"resettlement-corrected-request:{request.ResettlementRequestId:N}");
        var idempotencyKey = $"resettlement-corrected-settlement:{request.ResettlementRequestId:N}";
        var creditReference = string.IsNullOrWhiteSpace(original.CreditReservationReference)
            ? null
            : new CreditReservationReferenceDto(
                original.CreditReservationReference,
                original.PlayerAccountReference,
                original.TicketId,
                original.TicketLineId);
        var acceptedContext = new AcceptedWagerFinancialContextDto(
            original.AcceptedWagerFinancialContextReference,
            original.TicketId,
            original.TicketLineId,
            original.PlayerAccountReference,
            original.AcceptedStakeAmountMinor,
            original.Currency,
            original.MinorUnitPrecision,
            original.RoundingPolicyReference,
            creditReference,
            original.AcceptedAt);
        var provenance = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["resettlementRequestId"] = request.ResettlementRequestId,
            ["resettlementRole"] = "corrected",
            ["originalSettlementId"] = request.OriginalSettlementId,
            ["originalSettlementHash"] = request.OriginalSettlementHash,
            ["correctedSettlementInputHash"] = request.CorrectedSettlementInputHash
        };

        return new SettlementInputIngestionRequest(
            correctedRequestId,
            idempotencyKey,
            request.CorrectedSettlementInputId,
            request.CorrectedSettlementInputHash,
            correctedInput.MathEvaluationCertificateId,
            correctedInput.MathEvaluationCertificateHash,
            correctedInput.OutcomeCertificateId,
            correctedInput.OutcomeCertificateHash,
            original.TicketId,
            original.TicketLineId,
            original.PlayerAccountReference,
            original.AcceptedWagerFinancialContextReference,
            original.AcceptedStakeAmountMinor,
            original.Currency,
            original.MinorUnitPrecision,
            original.RoundingPolicyReference,
            original.CreditReservationReference,
            original.SettlementPolicyVersion,
            original.AcceptedAt,
            provenance,
            SettlementIngestionMode.DryRun,
            acceptedContext,
            new SettlementPolicyReferenceDto(original.SettlementPolicyVersion));
    }

    public static string BuildCanonicalRequestHash(ResettlementCreateRequest request)
    {
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["correctedMathEvaluationCertificateHash"] = request.CorrectedMathEvaluationCertificateHash,
            ["correctedMathEvaluationCertificateId"] = request.CorrectedMathEvaluationCertificateId,
            ["correctedSettlementInputHash"] = request.CorrectedSettlementInputHash,
            ["correctedSettlementInputId"] = request.CorrectedSettlementInputId,
            ["mode"] = request.Mode.ToString(),
            ["originalMathEvaluationCertificateHash"] = request.OriginalMathEvaluationCertificateHash,
            ["originalMathEvaluationCertificateId"] = request.OriginalMathEvaluationCertificateId,
            ["originalSettlementHash"] = request.OriginalSettlementHash,
            ["originalSettlementId"] = request.OriginalSettlementId,
            ["originalSettlementInputHash"] = request.OriginalSettlementInputHash,
            ["originalSettlementInputId"] = request.OriginalSettlementInputId,
            ["reasonCode"] = request.ReasonCode,
            ["requestorReference"] = request.RequestorReference
        };

        return HashCanonical(JsonSerializer.Serialize(payload, JsonOptions));
    }

    private static bool TicketReferenceMatches(string ticketReference, string ticketId, string ticketLineId)
    {
        return string.Equals(ticketReference, ticketLineId, StringComparison.Ordinal) ||
            string.Equals(ticketReference, ticketId, StringComparison.Ordinal) ||
            string.Equals(ticketReference, $"{ticketId}:{ticketLineId}", StringComparison.Ordinal);
    }

    private static void RequireText(string value, string field, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            errors.Add($"{field} is required.");
        }
        else if (field.Contains("Hash", StringComparison.Ordinal) &&
            !value.StartsWith("sha256:", StringComparison.Ordinal))
        {
            errors.Add($"{field} must be a sha256 hash.");
        }
    }

    private static string HashCanonical(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private static Guid CreateDeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes[..16]);
    }
}

public sealed class ResettlementValidationException(IReadOnlyList<string> errors)
    : Exception(string.Join(" ", errors))
{
    public IReadOnlyList<string> Errors { get; } = errors;
}
