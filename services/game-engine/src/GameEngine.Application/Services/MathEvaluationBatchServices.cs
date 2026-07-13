using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public enum MathEvaluationBatchStatus
{
    Pending,
    Running,
    PartiallyCompleted,
    Completed,
    Failed,
    Cancelled
}

public enum MathEvaluationBatchItemStatus
{
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled
}

public enum MathEvaluationBatchAttemptStatus
{
    Started,
    Completed,
    Failed,
    Recovered,
    Cancelled
}

public sealed record MathEvaluationBatchItemRequest(
    Guid BatchItemId,
    string TicketReference,
    string ItemIdempotencyKey,
    IReadOnlyDictionary<string, object?> WagerPayload);

public sealed record MathEvaluationBatchRequest(
    Guid BatchId,
    string BatchIdempotencyKey,
    MathEvaluationMode Mode,
    GameManifestV1 Manifest,
    OutcomeCertificate OutcomeCertificate,
    MathModelDefinitionV1 MathModel,
    PaytableDefinitionV1 Paytable,
    string WagerSchema,
    IReadOnlyDictionary<string, object?> OutcomePayload,
    IReadOnlyCollection<MathEvaluationBatchItemRequest> Items,
    int MaxDegreeOfParallelism,
    IReadOnlyDictionary<string, object?> ProvenanceMetadata);

public sealed record MathEvaluationBatchRecord(
    Guid BatchId,
    string BatchIdempotencyKey,
    string CanonicalBatchRequestHash,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    string GameManifestId,
    string GameManifestVersion,
    string GameManifestHash,
    string MathModelId,
    string MathModelVersion,
    string MathModelHash,
    string PaytableId,
    string PaytableVersion,
    string PaytableHash,
    string EvaluatorType,
    string EvaluatorVersion,
    int ExpectedItemCount,
    int CompletedItemCount,
    int FailedItemCount,
    MathEvaluationBatchStatus Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt,
    string? FailureCode,
    string? FailureReason,
    IReadOnlyDictionary<string, object?> ProvenanceMetadata);

public sealed record MathEvaluationBatchItemRecord(
    Guid BatchItemId,
    Guid BatchId,
    string TicketReference,
    string ItemIdempotencyKey,
    string CanonicalWagerPayloadHash,
    Guid? EvaluationRequestId,
    MathEvaluationBatchItemStatus EvaluationStatus,
    Guid? CertificateId,
    string? CertificateHash,
    int AttemptCount,
    string? FailureCode,
    string? FailureReason,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt);

public sealed record MathEvaluationBatchClaim(MathEvaluationBatchRecord Batch, bool Created, bool Duplicate);

public sealed record MathEvaluationBatchItemClaim(MathEvaluationBatchItemRecord Item, bool Created, bool Duplicate);

public sealed record MathEvaluationBatchResult(
    MathEvaluationBatchRecord Batch,
    IReadOnlyCollection<MathEvaluationBatchItemRecord> Items,
    IReadOnlyDictionary<Guid, MathEvaluationResult> CompletedResults);

public sealed record MathEvaluationBatchReadiness(
    bool BatchRepositoryConfigured,
    bool BatchPersistenceReachable,
    bool BatchRecoveryReady,
    bool ItemIdempotencyReady,
    bool BoundedParallelExecutionReady,
    bool ProductionActivationDisabled,
    IReadOnlyCollection<string> Blockers);

public interface IMathEvaluationBatchRepository
{
    Task<MathEvaluationBatchClaim> ClaimBatchAsync(MathEvaluationBatchRecord batch, CancellationToken cancellationToken);

    Task<MathEvaluationBatchItemClaim> ClaimItemAsync(MathEvaluationBatchItemRecord item, CancellationToken cancellationToken);

    Task AppendAttemptAsync(
        Guid batchId,
        Guid? batchItemId,
        MathEvaluationBatchAttemptStatus status,
        string? failureCode,
        string? failureReason,
        string canonicalAttemptHash,
        DateTimeOffset completedAt,
        CancellationToken cancellationToken);

    Task CompleteItemAsync(
        Guid batchItemId,
        Guid evaluationRequestId,
        Guid certificateId,
        string certificateHash,
        CancellationToken cancellationToken);

    Task FailItemAsync(
        Guid batchItemId,
        string failureCode,
        string failureReason,
        CancellationToken cancellationToken);

    Task CancelPendingItemsAsync(
        Guid batchId,
        string reasonCode,
        string reason,
        CancellationToken cancellationToken);

    Task<MathEvaluationBatchRecord> RecalculateBatchStatusAsync(Guid batchId, CancellationToken cancellationToken);

    Task<MathEvaluationBatchRecord?> FindBatchByIdempotencyKeyAsync(string batchIdempotencyKey, CancellationToken cancellationToken);

    Task<MathEvaluationBatchRecord?> FindBatchAsync(Guid batchId, CancellationToken cancellationToken);

    Task<IReadOnlyCollection<MathEvaluationBatchItemRecord>> ListItemsAsync(Guid batchId, CancellationToken cancellationToken);

    Task<MathEvaluationBatchReadiness> CheckReadinessAsync(CancellationToken cancellationToken);
}

public sealed class MathEvaluationBatchService(
    MathEvaluatorRegistry registry,
    DurableMathEvaluationService durableEvaluationService,
    IMathEvaluationBatchRepository repository)
{
    public async Task<MathEvaluationBatchResult> ExecuteAsync(
        MathEvaluationBatchRequest request,
        CancellationToken cancellationToken)
    {
        ValidateBatchRequest(request);
        var evaluator = registry.Resolve(request.Manifest.GameFamily, request.WagerSchema);
        var batch = BuildBatch(request, evaluator, MathEvaluationBatchStatus.Pending);
        var claim = await repository.ClaimBatchAsync(batch, cancellationToken);
        if (claim.Batch.Status == MathEvaluationBatchStatus.Completed ||
            claim.Batch.Status == MathEvaluationBatchStatus.Cancelled)
        {
            return new MathEvaluationBatchResult(
                claim.Batch,
                await repository.ListItemsAsync(claim.Batch.BatchId, cancellationToken),
                new Dictionary<Guid, MathEvaluationResult>());
        }

        await repository.AppendAttemptAsync(
            claim.Batch.BatchId,
            null,
            MathEvaluationBatchAttemptStatus.Started,
            null,
            null,
            DurableMathEvaluationService.HashCanonical($"{claim.Batch.CanonicalBatchRequestHash}|batch-started"),
            DateTimeOffset.UtcNow,
            cancellationToken);

        var completed = new Dictionary<Guid, MathEvaluationResult>();
        var parallelism = Math.Clamp(request.MaxDegreeOfParallelism, 1, 8);
        using var throttle = new SemaphoreSlim(parallelism);
        var tasks = request.Items
            .OrderBy(item => item.TicketReference, StringComparer.Ordinal)
            .ThenBy(item => item.ItemIdempotencyKey, StringComparer.Ordinal)
            .Select(async item =>
            {
                await throttle.WaitAsync(cancellationToken);
                try
                {
                    var result = await ExecuteItemAsync(claim.Batch, request, item, cancellationToken);
                    if (result is not null)
                    {
                        lock (completed)
                        {
                            completed[item.BatchItemId] = result;
                        }
                    }
                }
                finally
                {
                    throttle.Release();
                }
            });

        await Task.WhenAll(tasks);
        var recalculated = await repository.RecalculateBatchStatusAsync(claim.Batch.BatchId, cancellationToken);
        await repository.AppendAttemptAsync(
            claim.Batch.BatchId,
            null,
            recalculated.Status == MathEvaluationBatchStatus.Failed
                ? MathEvaluationBatchAttemptStatus.Failed
                : MathEvaluationBatchAttemptStatus.Completed,
            recalculated.Status == MathEvaluationBatchStatus.Failed ? "MATH_BATCH_FAILED" : null,
            recalculated.FailureReason,
            DurableMathEvaluationService.HashCanonical($"{claim.Batch.CanonicalBatchRequestHash}|batch-finished|{recalculated.Status}"),
            DateTimeOffset.UtcNow,
            cancellationToken);
        return new MathEvaluationBatchResult(
            recalculated,
            await repository.ListItemsAsync(claim.Batch.BatchId, cancellationToken),
            completed);
    }

    public async Task<MathEvaluationBatchResult> RecoverAsync(
        string batchIdempotencyKey,
        MathEvaluationBatchRequest request,
        bool retryFailedItems,
        CancellationToken cancellationToken)
    {
        var batch = await repository.FindBatchByIdempotencyKeyAsync(batchIdempotencyKey, cancellationToken)
            ?? throw new InvalidOperationException("Math Evaluation batch was not found for recovery.");
        await repository.AppendAttemptAsync(
            batch.BatchId,
            null,
            MathEvaluationBatchAttemptStatus.Recovered,
            null,
            null,
            DurableMathEvaluationService.HashCanonical($"{batch.CanonicalBatchRequestHash}|batch-recovery"),
            DateTimeOffset.UtcNow,
            cancellationToken);

        var items = await repository.ListItemsAsync(batch.BatchId, cancellationToken);
        var pendingTickets = items
            .Where(item => item.EvaluationStatus is MathEvaluationBatchItemStatus.Pending or MathEvaluationBatchItemStatus.Running ||
                (retryFailedItems && item.EvaluationStatus == MathEvaluationBatchItemStatus.Failed))
            .Select(item => item.TicketReference)
            .ToHashSet(StringComparer.Ordinal);
        var recoveryItems = request.Items.Where(item => pendingTickets.Contains(item.TicketReference)).ToArray();
        if (recoveryItems.Length == 0)
        {
            var recalculated = await repository.RecalculateBatchStatusAsync(batch.BatchId, cancellationToken);
            return new MathEvaluationBatchResult(recalculated, items, new Dictionary<Guid, MathEvaluationResult>());
        }

        var completed = new Dictionary<Guid, MathEvaluationResult>();
        foreach (var item in recoveryItems)
        {
            var result = await ExecuteItemAsync(batch, request, item, cancellationToken);
            if (result is not null)
            {
                completed[item.BatchItemId] = result;
            }
        }

        var recovered = await repository.RecalculateBatchStatusAsync(batch.BatchId, cancellationToken);
        return new MathEvaluationBatchResult(
            recovered,
            await repository.ListItemsAsync(batch.BatchId, cancellationToken),
            completed);
    }

    public async Task<MathEvaluationBatchResult> CancelAsync(
        string batchIdempotencyKey,
        string reasonCode,
        string reason,
        CancellationToken cancellationToken)
    {
        var batch = await repository.FindBatchByIdempotencyKeyAsync(batchIdempotencyKey, cancellationToken)
            ?? throw new InvalidOperationException("Math Evaluation batch was not found for cancellation.");
        await repository.CancelPendingItemsAsync(batch.BatchId, reasonCode, reason, cancellationToken);
        await repository.AppendAttemptAsync(
            batch.BatchId,
            null,
            MathEvaluationBatchAttemptStatus.Cancelled,
            reasonCode,
            reason,
            DurableMathEvaluationService.HashCanonical($"{batch.CanonicalBatchRequestHash}|batch-cancelled|{reasonCode}|{reason}"),
            DateTimeOffset.UtcNow,
            cancellationToken);
        var recalculated = await repository.RecalculateBatchStatusAsync(batch.BatchId, cancellationToken);
        return new MathEvaluationBatchResult(
            recalculated,
            await repository.ListItemsAsync(batch.BatchId, cancellationToken),
            new Dictionary<Guid, MathEvaluationResult>());
    }

    public Task<MathEvaluationBatchReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        return repository.CheckReadinessAsync(cancellationToken);
    }

    private async Task<MathEvaluationResult?> ExecuteItemAsync(
        MathEvaluationBatchRecord batch,
        MathEvaluationBatchRequest request,
        MathEvaluationBatchItemRequest item,
        CancellationToken cancellationToken)
    {
        var itemRecord = new MathEvaluationBatchItemRecord(
            item.BatchItemId,
            batch.BatchId,
            item.TicketReference,
            item.ItemIdempotencyKey,
            MathEvaluationCanonicalizer.HashPayload(item.WagerPayload),
            null,
            MathEvaluationBatchItemStatus.Pending,
            null,
            null,
            0,
            null,
            null,
            DateTimeOffset.UtcNow,
            null);
        var claim = await repository.ClaimItemAsync(itemRecord, cancellationToken);
        if (claim.Item.EvaluationStatus == MathEvaluationBatchItemStatus.Completed)
        {
            return null;
        }

        await repository.AppendAttemptAsync(
            batch.BatchId,
            claim.Item.BatchItemId,
            MathEvaluationBatchAttemptStatus.Started,
            null,
            null,
            DurableMathEvaluationService.HashCanonical($"{batch.CanonicalBatchRequestHash}|{claim.Item.ItemIdempotencyKey}|started"),
            DateTimeOffset.UtcNow,
            cancellationToken);

        try
        {
            var evaluationRequest = new MathCertificateEvaluationRequest(
                DeterministicGuid($"{batch.BatchId:N}:{claim.Item.ItemIdempotencyKey}:math-evaluation-request"),
                claim.Item.ItemIdempotencyKey,
                request.Mode,
                request.Manifest,
                request.OutcomeCertificate,
                request.MathModel,
                request.Paytable,
                item.TicketReference,
                request.WagerSchema,
                item.WagerPayload,
                request.OutcomePayload);
            var result = await durableEvaluationService.EvaluateAsync(evaluationRequest, cancellationToken);
            await repository.CompleteItemAsync(
                claim.Item.BatchItemId,
                result.RequestId,
                result.Certificate.CertificateId,
                result.CanonicalPrizeFactsHash,
                cancellationToken);
            await repository.AppendAttemptAsync(
                batch.BatchId,
                claim.Item.BatchItemId,
                MathEvaluationBatchAttemptStatus.Completed,
                null,
                null,
                DurableMathEvaluationService.HashCanonical($"{batch.CanonicalBatchRequestHash}|{claim.Item.ItemIdempotencyKey}|completed|{result.CanonicalPrizeFactsHash}"),
                DateTimeOffset.UtcNow,
                cancellationToken);
            return result;
        }
        catch (Exception error) when (error is InvalidOperationException or ArgumentException)
        {
            await repository.FailItemAsync(claim.Item.BatchItemId, "MATH_BATCH_ITEM_FAILED", error.Message, cancellationToken);
            await repository.AppendAttemptAsync(
                batch.BatchId,
                claim.Item.BatchItemId,
                MathEvaluationBatchAttemptStatus.Failed,
                "MATH_BATCH_ITEM_FAILED",
                error.Message,
                DurableMathEvaluationService.HashCanonical($"{batch.CanonicalBatchRequestHash}|{claim.Item.ItemIdempotencyKey}|failed|{error.Message}"),
                DateTimeOffset.UtcNow,
                cancellationToken);
            return null;
        }
    }

    private static MathEvaluationBatchRecord BuildBatch(
        MathEvaluationBatchRequest request,
        IMathEvaluator evaluator,
        MathEvaluationBatchStatus status)
    {
        return new MathEvaluationBatchRecord(
            request.BatchId,
            request.BatchIdempotencyKey,
            BuildCanonicalBatchRequestHash(request, evaluator),
            request.OutcomeCertificate.CertificateId,
            request.OutcomeCertificate.CanonicalOutcomeHash,
            request.Manifest.Id.ToString("N"),
            request.Manifest.SemanticVersion,
            request.Manifest.ContentHash,
            request.MathModel.MathModelId,
            request.MathModel.Version,
            request.MathModel.ContentHash,
            request.Paytable.PaytableId,
            request.Paytable.Version,
            request.Paytable.ContentHash,
            evaluator.GetType().Name,
            evaluator.EvaluatorVersion,
            request.Items.Count,
            0,
            0,
            status,
            DateTimeOffset.UtcNow,
            null,
            null,
            null,
            null,
            request.ProvenanceMetadata);
    }

    private static string BuildCanonicalBatchRequestHash(
        MathEvaluationBatchRequest request,
        IMathEvaluator evaluator)
    {
        var items = request.Items
            .OrderBy(item => item.TicketReference, StringComparer.Ordinal)
            .ThenBy(item => item.ItemIdempotencyKey, StringComparer.Ordinal)
            .Select(item => new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["itemIdempotencyKey"] = item.ItemIdempotencyKey,
                ["ticketReference"] = item.TicketReference,
                ["wagerPayloadHash"] = MathEvaluationCanonicalizer.HashPayload(item.WagerPayload)
            })
            .ToArray();
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["batchIdempotencyKey"] = request.BatchIdempotencyKey,
            ["evaluatorType"] = evaluator.GetType().Name,
            ["evaluatorVersion"] = evaluator.EvaluatorVersion,
            ["gameManifestHash"] = request.Manifest.ContentHash,
            ["gameManifestId"] = request.Manifest.Id.ToString("N"),
            ["gameManifestVersion"] = request.Manifest.SemanticVersion,
            ["items"] = items,
            ["mathModelHash"] = request.MathModel.ContentHash,
            ["mathModelId"] = request.MathModel.MathModelId,
            ["mathModelVersion"] = request.MathModel.Version,
            ["mode"] = request.Mode.ToString(),
            ["outcomeCertificateHash"] = request.OutcomeCertificate.CanonicalOutcomeHash,
            ["outcomeCertificateId"] = request.OutcomeCertificate.CertificateId,
            ["paytableHash"] = request.Paytable.ContentHash,
            ["paytableId"] = request.Paytable.PaytableId,
            ["paytableVersion"] = request.Paytable.Version,
            ["wagerSchema"] = request.WagerSchema
        };
        return DurableMathEvaluationService.HashCanonical(JsonSerializer.Serialize(payload));
    }

    private static void ValidateBatchRequest(MathEvaluationBatchRequest request)
    {
        if (request.Items.Count == 0)
        {
            throw new InvalidOperationException("Math Evaluation batch requires at least one item.");
        }

        if (request.Mode == MathEvaluationMode.ProductionDisabled)
        {
            throw new InvalidOperationException("Production Math Authority batch evaluation is disabled.");
        }

        if (request.Items.Select(item => item.ItemIdempotencyKey).Distinct(StringComparer.Ordinal).Count() != request.Items.Count)
        {
            throw new InvalidOperationException("Math Evaluation batch item idempotency keys must be unique.");
        }

        if (request.ProvenanceMetadata.Keys.Any(key =>
            key.Contains("ledger", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("wallet", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("cash", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("rng", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("entropy", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException("Math Evaluation batch provenance cannot contain financial or randomness references.");
        }
    }

    private static Guid DeterministicGuid(string value)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value));
        return new Guid(bytes[..16]);
    }
}

public sealed class InMemoryMathEvaluationBatchRepository : IMathEvaluationBatchRepository
{
    private readonly List<MathEvaluationBatchRecord> batches = [];
    private readonly List<MathEvaluationBatchItemRecord> items = [];
    private readonly List<(Guid BatchId, Guid? ItemId, MathEvaluationBatchAttemptStatus Status)> attempts = [];

    public IReadOnlyCollection<MathEvaluationBatchRecord> Batches => batches;

    public IReadOnlyCollection<MathEvaluationBatchItemRecord> Items => items;

    public IReadOnlyCollection<(Guid BatchId, Guid? ItemId, MathEvaluationBatchAttemptStatus Status)> Attempts => attempts;

    public Task<MathEvaluationBatchClaim> ClaimBatchAsync(MathEvaluationBatchRecord batch, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var existing = batches.LastOrDefault(item => item.BatchIdempotencyKey == batch.BatchIdempotencyKey);
        if (existing is not null)
        {
            if (existing.CanonicalBatchRequestHash != batch.CanonicalBatchRequestHash)
            {
                throw new InvalidOperationException("Conflicting payload for the same Math Evaluation batch idempotency key.");
            }

            return Task.FromResult(new MathEvaluationBatchClaim(existing, Created: false, Duplicate: true));
        }

        batches.Add(batch with { Status = MathEvaluationBatchStatus.Running, StartedAt = DateTimeOffset.UtcNow });
        return Task.FromResult(new MathEvaluationBatchClaim(batches[^1], Created: true, Duplicate: false));
    }

    public Task<MathEvaluationBatchItemClaim> ClaimItemAsync(MathEvaluationBatchItemRecord item, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var existing = items.LastOrDefault(existing => existing.ItemIdempotencyKey == item.ItemIdempotencyKey);
        if (existing is not null)
        {
            if (existing.CanonicalWagerPayloadHash != item.CanonicalWagerPayloadHash)
            {
                throw new InvalidOperationException("Conflicting payload for the same Math Evaluation batch item idempotency key.");
            }

            return Task.FromResult(new MathEvaluationBatchItemClaim(existing, Created: false, Duplicate: true));
        }

        var running = item with { EvaluationStatus = MathEvaluationBatchItemStatus.Running, AttemptCount = 0 };
        items.Add(running);
        return Task.FromResult(new MathEvaluationBatchItemClaim(running, Created: true, Duplicate: false));
    }

    public Task AppendAttemptAsync(
        Guid batchId,
        Guid? batchItemId,
        MathEvaluationBatchAttemptStatus status,
        string? failureCode,
        string? failureReason,
        string canonicalAttemptHash,
        DateTimeOffset completedAt,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        attempts.Add((batchId, batchItemId, status));
        if (batchItemId is not null)
        {
            ReplaceItem(items.Single(item => item.BatchItemId == batchItemId) with
            {
                AttemptCount = items.Single(item => item.BatchItemId == batchItemId).AttemptCount + 1
            });
        }

        return Task.CompletedTask;
    }

    public Task CompleteItemAsync(
        Guid batchItemId,
        Guid evaluationRequestId,
        Guid certificateId,
        string certificateHash,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var item = items.Single(item => item.BatchItemId == batchItemId);
        if (item.EvaluationStatus == MathEvaluationBatchItemStatus.Completed)
        {
            return Task.CompletedTask;
        }

        ReplaceItem(item with
        {
            EvaluationRequestId = evaluationRequestId,
            EvaluationStatus = MathEvaluationBatchItemStatus.Completed,
            CertificateId = certificateId,
            CertificateHash = certificateHash,
            CompletedAt = DateTimeOffset.UtcNow,
            FailureCode = null,
            FailureReason = null
        });
        return Task.CompletedTask;
    }

    public Task FailItemAsync(Guid batchItemId, string failureCode, string failureReason, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var item = items.Single(item => item.BatchItemId == batchItemId);
        ReplaceItem(item with
        {
            EvaluationStatus = MathEvaluationBatchItemStatus.Failed,
            FailureCode = failureCode,
            FailureReason = failureReason
        });
        return Task.CompletedTask;
    }

    public Task CancelPendingItemsAsync(Guid batchId, string reasonCode, string reason, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        foreach (var item in items.Where(item => item.BatchId == batchId &&
            item.EvaluationStatus is MathEvaluationBatchItemStatus.Pending or MathEvaluationBatchItemStatus.Running))
        {
            ReplaceItem(item with
            {
                EvaluationStatus = MathEvaluationBatchItemStatus.Cancelled,
                FailureCode = reasonCode,
                FailureReason = reason
            });
        }

        return Task.CompletedTask;
    }

    public Task<MathEvaluationBatchRecord> RecalculateBatchStatusAsync(Guid batchId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var batch = batches.Single(batch => batch.BatchId == batchId);
        var batchItems = items.Where(item => item.BatchId == batchId).ToArray();
        var completed = batchItems.Count(item => item.EvaluationStatus == MathEvaluationBatchItemStatus.Completed);
        var failed = batchItems.Count(item => item.EvaluationStatus == MathEvaluationBatchItemStatus.Failed);
        var cancelled = batchItems.Count(item => item.EvaluationStatus == MathEvaluationBatchItemStatus.Cancelled);
        var status = completed == batch.ExpectedItemCount
            ? MathEvaluationBatchStatus.Completed
            : cancelled > 0
                ? MathEvaluationBatchStatus.Cancelled
                : completed > 0 && failed == 0
                    ? MathEvaluationBatchStatus.PartiallyCompleted
                    : failed > 0 && completed == 0
                        ? MathEvaluationBatchStatus.Failed
                        : failed > 0
                            ? MathEvaluationBatchStatus.PartiallyCompleted
                            : MathEvaluationBatchStatus.Running;
        var updated = batch with
        {
            CompletedItemCount = completed,
            FailedItemCount = failed,
            Status = status,
            CompletedAt = status is MathEvaluationBatchStatus.Completed or MathEvaluationBatchStatus.Failed or MathEvaluationBatchStatus.Cancelled
                ? DateTimeOffset.UtcNow
                : null,
            FailureCode = failed > 0 ? "MATH_BATCH_ITEM_FAILURE" : cancelled > 0 ? "MATH_BATCH_CANCELLED" : null,
            FailureReason = failed > 0 ? "One or more Math Evaluation batch items failed." : cancelled > 0 ? "Math Evaluation batch was cancelled." : null
        };
        ReplaceBatch(updated);
        return Task.FromResult(updated);
    }

    public Task<MathEvaluationBatchRecord?> FindBatchByIdempotencyKeyAsync(string batchIdempotencyKey, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(batches.LastOrDefault(batch => batch.BatchIdempotencyKey == batchIdempotencyKey));
    }

    public Task<MathEvaluationBatchRecord?> FindBatchAsync(Guid batchId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(batches.LastOrDefault(batch => batch.BatchId == batchId));
    }

    public Task<IReadOnlyCollection<MathEvaluationBatchItemRecord>> ListItemsAsync(Guid batchId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult<IReadOnlyCollection<MathEvaluationBatchItemRecord>>(
            items.Where(item => item.BatchId == batchId).OrderBy(item => item.TicketReference, StringComparer.Ordinal).ToArray());
    }

    public Task<MathEvaluationBatchReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new MathEvaluationBatchReadiness(
            BatchRepositoryConfigured: false,
            BatchPersistenceReachable: false,
            BatchRecoveryReady: true,
            ItemIdempotencyReady: true,
            BoundedParallelExecutionReady: true,
            ProductionActivationDisabled: true,
            Blockers: ["Math Evaluation batch persistence is using non-production in-memory storage."]));
    }

    private void ReplaceBatch(MathEvaluationBatchRecord replacement)
    {
        var index = batches.FindIndex(batch => batch.BatchId == replacement.BatchId);
        batches[index] = replacement;
    }

    private void ReplaceItem(MathEvaluationBatchItemRecord replacement)
    {
        var index = items.FindIndex(item => item.BatchItemId == replacement.BatchItemId);
        items[index] = replacement;
    }
}
