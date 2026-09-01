using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public enum DurableMathEvaluationStatus
{
    Claimed,
    Completed,
    Failed
}

public enum MathEvaluationAttemptStatus
{
    Started,
    Completed,
    Failed,
    ReplayVerified,
    ReplayMismatch
}

public sealed record DurableMathEvaluationRequestRecord(
    Guid EvaluationRequestId,
    string IdempotencyKey,
    string CanonicalRequestHash,
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
    string TicketReference,
    string WagerSchema,
    string EvaluatorType,
    string EvaluatorVersion,
    MathEvaluationMode Mode,
    DurableMathEvaluationStatus Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt = null,
    string? FailureCode = null,
    string? FailureReason = null,
    Guid? MathEvaluationId = null,
    Guid? CertificateId = null,
    string? CertificateHash = null,
    DateTimeOffset? AdmittedAt = null);

public sealed record DurableMathEvaluationClaim(
    DurableMathEvaluationRequestRecord Request,
    bool Created,
    bool Duplicate);

public sealed record DurableMathEvaluationStartedClaim(
    DurableMathEvaluationClaim Claim,
    int AttemptNumber,
    DateTimeOffset ConnectionRequestedAt,
    DateTimeOffset ConnectionAcquiredAt,
    DateTimeOffset ClaimAcquiredAt);

public sealed record AdmittedMathEvaluationWork(
    MathCertificateEvaluationRequest Evaluation,
    DurableMathEvaluationClaim Admission);

public sealed record MathEvaluationProcessingTiming(
    DateTimeOffset WorkerReceivedAt,
    DateTimeOffset WorkCreatedAt,
    DateTimeOffset WorkPublishedAt,
    DateTimeOffset ClaimAttemptedAt,
    DateTimeOffset ConnectionRequestedAt,
    DateTimeOffset ConnectionAcquiredAt,
    DateTimeOffset ClaimAcquiredAt,
    DateTimeOffset ProcessingStartedAt,
    DateTimeOffset MathStartedAt,
    DateTimeOffset MathCompletedAt,
    DateTimeOffset PersistenceStartedAt);

public sealed record MathEvaluationAttemptRecord(
    Guid AttemptId,
    Guid EvaluationRequestId,
    int AttemptNumber,
    MathEvaluationAttemptStatus Status,
    string? FailureCode,
    string? FailureReason,
    string CanonicalAttemptHash,
    DateTimeOffset StartedAt,
    DateTimeOffset? CompletedAt);

public sealed record MathEvaluationPersistenceReadiness(
    bool TypedEvaluatorRegistryReady,
    bool DurableRepositoryConfigured,
    bool DurableRepositoryReachable,
    bool IdempotencyConfigured,
    bool ReplayVerificationReady,
    bool ProductionActivationDisabled,
    IReadOnlyCollection<string> Blockers);

public sealed record MathEvaluationReplayResult(
    bool Verified,
    MathEvaluationResult Original,
    MathEvaluationResult Replayed,
    string OriginalPrizeFactsHash,
    string ReplayedPrizeFactsHash);

public interface IMathEvaluationDurableRepository
{
    Task<IReadOnlyCollection<DurableMathEvaluationClaim>> ClaimRequestsAsync(
        IReadOnlyCollection<DurableMathEvaluationRequestRecord> requests,
        CancellationToken cancellationToken);

    Task<DurableMathEvaluationStartedClaim> ClaimAndStartRequestAsync(
        DurableMathEvaluationRequestRecord request,
        DateTimeOffset workerReceivedAt,
        DateTimeOffset claimAttemptedAt,
        string canonicalAttemptHash,
        CancellationToken cancellationToken);

    Task<DurableMathEvaluationStartedClaim> StartClaimedRequestAsync(
        DurableMathEvaluationRequestRecord request,
        DateTimeOffset workerReceivedAt,
        DateTimeOffset claimAttemptedAt,
        string canonicalAttemptHash,
        CancellationToken cancellationToken);

    Task<DurableMathEvaluationClaim> ClaimRequestAsync(
        DurableMathEvaluationRequestRecord request,
        CancellationToken cancellationToken);

    Task<MathEvaluationAttemptRecord> AppendAttemptAsync(
        Guid evaluationRequestId,
        MathEvaluationAttemptStatus status,
        string? failureCode,
        string? failureReason,
        string canonicalAttemptHash,
        DateTimeOffset startedAt,
        DateTimeOffset? completedAt,
        CancellationToken cancellationToken);

    Task<MathEvaluationResult> CompleteEvaluationAsync(
        DurableMathEvaluationRequestRecord request,
        MathEvaluationResult result,
        IReadOnlyDictionary<string, object?> wagerPayload,
        CancellationToken cancellationToken);

    Task<MathEvaluationResult> CompleteEvaluationWithEvidenceAsync(
        DurableMathEvaluationRequestRecord request,
        int attemptNumber,
        MathEvaluationResult result,
        IReadOnlyDictionary<string, object?> wagerPayload,
        MathEvaluationProcessingTiming timing,
        string canonicalAttemptHash,
        CancellationToken cancellationToken);

    Task<DurableMathEvaluationRequestRecord> FailRequestAsync(
        DurableMathEvaluationRequestRecord request,
        string failureCode,
        string failureReason,
        CancellationToken cancellationToken);

    Task<MathEvaluationResult?> FindCompletedResultAsync(
        Guid evaluationRequestId,
        CancellationToken cancellationToken);

    Task<DurableMathEvaluationRequestRecord?> FindByIdempotencyKeyAsync(
        string idempotencyKey,
        CancellationToken cancellationToken);

    Task<IReadOnlyCollection<DurableMathEvaluationRequestRecord>> FindIncompleteAsync(
        CancellationToken cancellationToken);

    Task<IReadOnlyCollection<DurableMathEvaluationRequestRecord>> FindByTicketReferenceAsync(
        string ticketReference,
        CancellationToken cancellationToken);

    Task<IReadOnlyCollection<DurableMathEvaluationRequestRecord>> FindByOutcomeCertificateAsync(
        Guid outcomeCertificateId,
        string outcomeCertificateHash,
        CancellationToken cancellationToken);

    Task<DurableMathEvaluationRequestRecord?> FindByCertificateHashAsync(
        string certificateHash,
        CancellationToken cancellationToken);

    Task<MathEvaluationPersistenceReadiness> CheckReadinessAsync(CancellationToken cancellationToken);
}

public sealed class DurableMathEvaluationService(
    MathEvaluatorRegistry registry,
    MathCertificateEvaluationService certificateService,
    IMathEvaluationDurableRepository repository)
{
    internal PrizeFacts EvaluatePrizeFactsForTicketCap(
        MathCertificateEvaluationRequest request)
    {
        return certificateService.Evaluate(request).PrizeFacts;
    }

    public async Task<IReadOnlyCollection<AdmittedMathEvaluationWork>> AdmitBatchAsync(
        IReadOnlyCollection<MathCertificateEvaluationRequest> requests,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (requests.Count == 0)
        {
            return [];
        }

        var prepared = requests.Select(request =>
        {
            var evaluator = registry.Resolve(request.Manifest.GameFamily, request.WagerSchema);
            return new AdmittedMathEvaluationWork(
                request,
                new DurableMathEvaluationClaim(
                    BuildDurableRequest(request, evaluator),
                    Created: false,
                    Duplicate: false));
        }).ToArray();
        var claims = (await repository.ClaimRequestsAsync(
            prepared.Select(item => item.Admission.Request).ToArray(),
            cancellationToken)).ToArray();
        if (claims.Length != prepared.Length)
        {
            throw new InvalidOperationException("Math Evaluation admission did not return one durable claim per requested item.");
        }

        return prepared.Select((item, index) => item with { Admission = claims[index] }).ToArray();
    }

    public async Task<MathEvaluationResult> EvaluateAsync(
        MathCertificateEvaluationRequest request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var evaluator = registry.Resolve(request.Manifest.GameFamily, request.WagerSchema);
        var durableRequest = BuildDurableRequest(request, evaluator);
        var workerReceivedAt = DateTimeOffset.UtcNow;
        var claimAttemptedAt = DateTimeOffset.UtcNow;
        var started = await repository.ClaimAndStartRequestAsync(
            durableRequest,
            workerReceivedAt,
            claimAttemptedAt,
            HashCanonical($"{durableRequest.CanonicalRequestHash}|attempt|started|{claimAttemptedAt:O}"),
            cancellationToken);

        return await ExecuteStartedAsync(
            request,
            durableRequest,
            started,
            workerReceivedAt,
            claimAttemptedAt,
            cancellationToken);
    }

    public async Task<MathEvaluationResult> EvaluateAdmittedAsync(
        AdmittedMathEvaluationWork admitted,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var durableRequest = admitted.Admission.Request;
        var workerReceivedAt = DateTimeOffset.UtcNow;
        var claimAttemptedAt = DateTimeOffset.UtcNow;
        var started = await repository.StartClaimedRequestAsync(
            durableRequest,
            workerReceivedAt,
            claimAttemptedAt,
            HashCanonical($"{durableRequest.CanonicalRequestHash}|attempt|started|{claimAttemptedAt:O}"),
            cancellationToken);

        return await ExecuteStartedAsync(
            admitted.Evaluation,
            durableRequest,
            started,
            workerReceivedAt,
            claimAttemptedAt,
            cancellationToken);
    }

    private async Task<MathEvaluationResult> ExecuteStartedAsync(
        MathCertificateEvaluationRequest request,
        DurableMathEvaluationRequestRecord durableRequest,
        DurableMathEvaluationStartedClaim started,
        DateTimeOffset workerReceivedAt,
        DateTimeOffset claimAttemptedAt,
        CancellationToken cancellationToken)
    {
        var claim = started.Claim;

        if (claim.Request.Status == DurableMathEvaluationStatus.Completed)
        {
            return await ReadCompletedResultAsync(claim.Request, cancellationToken);
        }

        var processingStartedAt = DateTimeOffset.UtcNow;

        try
        {
            var mathStartedAt = DateTimeOffset.UtcNow;
            var result = certificateService.Evaluate(request);
            var mathCompletedAt = DateTimeOffset.UtcNow;
            var persistenceStartedAt = DateTimeOffset.UtcNow;
            var completed = await repository.CompleteEvaluationWithEvidenceAsync(
                claim.Request,
                started.AttemptNumber,
                result,
                request.WagerPayload,
                new MathEvaluationProcessingTiming(
                    workerReceivedAt,
                    durableRequest.CreatedAt,
                    claim.Request.AdmittedAt ?? durableRequest.CreatedAt,
                    claimAttemptedAt,
                    started.ConnectionRequestedAt,
                    started.ConnectionAcquiredAt,
                    started.ClaimAcquiredAt,
                    processingStartedAt,
                    mathStartedAt,
                    mathCompletedAt,
                    persistenceStartedAt),
                HashCanonical($"{claim.Request.CanonicalRequestHash}|attempt|completed|{result.Certificate.CertificateId}|{result.CanonicalPrizeFactsHash}"),
                cancellationToken);

            return completed;
        }
        catch (Exception error) when (error is InvalidOperationException or ArgumentException)
        {
            var completedAt = DateTimeOffset.UtcNow;
            var failureCode = "MATH_EVALUATION_FAILED";
            await repository.AppendAttemptAsync(
                claim.Request.EvaluationRequestId,
                MathEvaluationAttemptStatus.Failed,
                failureCode,
                error.Message,
                HashCanonical($"{claim.Request.CanonicalRequestHash}|attempt|failed|{error.Message}"),
                processingStartedAt,
                completedAt,
                cancellationToken);
            await repository.FailRequestAsync(claim.Request, failureCode, error.Message, cancellationToken);
            throw;
        }
    }

    public async Task<MathEvaluationReplayResult> ReplayAsync(
        MathCertificateEvaluationRequest request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var existingRequest = await repository.FindByIdempotencyKeyAsync(request.IdempotencyKey, cancellationToken)
            ?? throw new InvalidOperationException("Math Evaluation request was not found for replay.");
        if (existingRequest.Status != DurableMathEvaluationStatus.Completed)
        {
            throw new InvalidOperationException("Only completed Math Evaluation requests can be replay-verified.");
        }

        var original = await ReadCompletedResultAsync(existingRequest, cancellationToken);
        var replayed = certificateService.Evaluate(request);
        var verified = string.Equals(original.CanonicalPrizeFactsHash, replayed.CanonicalPrizeFactsHash, StringComparison.Ordinal);
        var now = DateTimeOffset.UtcNow;
        var status = verified ? MathEvaluationAttemptStatus.ReplayVerified : MathEvaluationAttemptStatus.ReplayMismatch;
        await repository.AppendAttemptAsync(
            existingRequest.EvaluationRequestId,
            status,
            verified ? null : "MATH_EVALUATION_REPLAY_MISMATCH",
            verified ? null : "Replay prize facts hash did not match original Math Evaluation evidence.",
            HashCanonical($"{existingRequest.CanonicalRequestHash}|replay|{original.CanonicalPrizeFactsHash}|{replayed.CanonicalPrizeFactsHash}"),
            now,
            now,
            cancellationToken);

        if (!verified)
        {
            throw new InvalidOperationException("Math Evaluation replay mismatch detected.");
        }

        return new MathEvaluationReplayResult(
            true,
            original,
            replayed,
            original.CanonicalPrizeFactsHash,
            replayed.CanonicalPrizeFactsHash);
    }

    public Task<MathEvaluationPersistenceReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        return repository.CheckReadinessAsync(cancellationToken);
    }

    public static DurableMathEvaluationRequestRecord BuildDurableRequest(
        MathCertificateEvaluationRequest request,
        IMathEvaluator evaluator)
    {
        var manifestId = request.Manifest.Id.ToString("N");
        var manifestVersion = request.Manifest.SemanticVersion;
        var manifestHash = request.Manifest.ContentHash;
        var canonicalRequestHash = BuildCanonicalRequestHash(request, evaluator);
        return new DurableMathEvaluationRequestRecord(
            request.RequestId,
            request.IdempotencyKey,
            canonicalRequestHash,
            request.OutcomeCertificate.CertificateId,
            request.OutcomeCertificate.CanonicalOutcomeHash,
            manifestId,
            manifestVersion,
            manifestHash,
            request.MathModel.MathModelId,
            request.MathModel.Version,
            request.MathModel.ContentHash,
            request.Paytable.PaytableId,
            request.Paytable.Version,
            request.Paytable.ContentHash,
            request.TicketReference,
            request.WagerSchema,
            evaluator.GetType().Name,
            evaluator.EvaluatorVersion,
            request.Mode,
            DurableMathEvaluationStatus.Claimed,
            DateTimeOffset.UtcNow);
    }

    public static string BuildCanonicalRequestHash(
        MathCertificateEvaluationRequest request,
        IMathEvaluator evaluator)
    {
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["evaluationMode"] = request.Mode.ToString(),
            ["evaluatorType"] = evaluator.GetType().Name,
            ["evaluatorVersion"] = evaluator.EvaluatorVersion,
            ["gameManifestHash"] = request.Manifest.ContentHash,
            ["gameManifestId"] = request.Manifest.Id.ToString("N"),
            ["gameManifestVersion"] = request.Manifest.SemanticVersion,
            ["mathModelHash"] = request.MathModel.ContentHash,
            ["mathModelId"] = request.MathModel.MathModelId,
            ["mathModelVersion"] = request.MathModel.Version,
            ["outcomeCertificateHash"] = request.OutcomeCertificate.CanonicalOutcomeHash,
            ["outcomeCertificateId"] = request.OutcomeCertificate.CertificateId,
            ["paytableHash"] = request.Paytable.ContentHash,
            ["paytableId"] = request.Paytable.PaytableId,
            ["paytableVersion"] = request.Paytable.Version,
            ["ticketReference"] = request.TicketReference,
            ["wagerPayloadHash"] = MathEvaluationCanonicalizer.HashPayload(request.WagerPayload),
            ["wagerSchema"] = request.WagerSchema
        };

        return HashCanonical(JsonSerializer.Serialize(payload));
    }

    public static string HashCanonical(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private async Task<MathEvaluationResult> ReadCompletedResultAsync(
        DurableMathEvaluationRequestRecord request,
        CancellationToken cancellationToken)
    {
        var result = await repository.FindCompletedResultAsync(request.EvaluationRequestId, cancellationToken);
        return result ?? throw new InvalidOperationException("Completed Math Evaluation request has no deterministic certificate result.");
    }
}

public sealed class InMemoryMathEvaluationDurableRepository : IMathEvaluationDurableRepository
{
    private readonly List<DurableMathEvaluationRequestRecord> requests = [];
    private readonly List<MathEvaluationAttemptRecord> attempts = [];
    private readonly Dictionary<Guid, MathEvaluationResult> results = [];

    public IReadOnlyCollection<DurableMathEvaluationRequestRecord> Requests => requests;

    public IReadOnlyCollection<MathEvaluationAttemptRecord> Attempts => attempts;

    public async Task<IReadOnlyCollection<DurableMathEvaluationClaim>> ClaimRequestsAsync(
        IReadOnlyCollection<DurableMathEvaluationRequestRecord> batch,
        CancellationToken cancellationToken)
    {
        var claims = new List<DurableMathEvaluationClaim>(batch.Count);
        foreach (var request in batch)
        {
            claims.Add(await ClaimRequestAsync(request, cancellationToken));
        }
        return claims;
    }

    public async Task<DurableMathEvaluationStartedClaim> ClaimAndStartRequestAsync(
        DurableMathEvaluationRequestRecord request,
        DateTimeOffset workerReceivedAt,
        DateTimeOffset claimAttemptedAt,
        string canonicalAttemptHash,
        CancellationToken cancellationToken)
    {
        var claim = await ClaimRequestAsync(request, cancellationToken);
        var acquiredAt = DateTimeOffset.UtcNow;
        if (claim.Request.Status == DurableMathEvaluationStatus.Completed)
        {
            return new DurableMathEvaluationStartedClaim(
                claim,
                0,
                claimAttemptedAt,
                acquiredAt,
                acquiredAt);
        }

        var attempt = await AppendAttemptAsync(
            claim.Request.EvaluationRequestId,
            MathEvaluationAttemptStatus.Started,
            null,
            null,
            canonicalAttemptHash,
            claimAttemptedAt,
            null,
            cancellationToken);
        return new DurableMathEvaluationStartedClaim(
            claim,
            attempt.AttemptNumber,
            claimAttemptedAt,
            acquiredAt,
            DateTimeOffset.UtcNow);
    }

    public async Task<DurableMathEvaluationStartedClaim> StartClaimedRequestAsync(
        DurableMathEvaluationRequestRecord request,
        DateTimeOffset workerReceivedAt,
        DateTimeOffset claimAttemptedAt,
        string canonicalAttemptHash,
        CancellationToken cancellationToken)
    {
        var existing = requests.LastOrDefault(item => item.IdempotencyKey == request.IdempotencyKey)
            ?? throw new InvalidOperationException("Admitted Math Evaluation request was not found.");
        if (!string.Equals(existing.CanonicalRequestHash, request.CanonicalRequestHash, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Conflicting payload for the same Math Evaluation idempotency key.");
        }
        var claim = new DurableMathEvaluationClaim(existing, Created: false, Duplicate: true);
        var acquiredAt = DateTimeOffset.UtcNow;
        if (existing.Status == DurableMathEvaluationStatus.Completed)
        {
            return new DurableMathEvaluationStartedClaim(claim, 0, claimAttemptedAt, acquiredAt, acquiredAt);
        }
        var attempt = await AppendAttemptAsync(
            existing.EvaluationRequestId,
            MathEvaluationAttemptStatus.Started,
            null,
            null,
            canonicalAttemptHash,
            claimAttemptedAt,
            null,
            cancellationToken);
        return new DurableMathEvaluationStartedClaim(
            claim,
            attempt.AttemptNumber,
            claimAttemptedAt,
            acquiredAt,
            DateTimeOffset.UtcNow);
    }

    public Task<DurableMathEvaluationClaim> ClaimRequestAsync(
        DurableMathEvaluationRequestRecord request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var existing = requests.LastOrDefault(item => item.IdempotencyKey == request.IdempotencyKey);
        if (existing is not null)
        {
            if (!string.Equals(existing.CanonicalRequestHash, request.CanonicalRequestHash, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Conflicting payload for the same Math Evaluation idempotency key.");
            }

            return Task.FromResult(new DurableMathEvaluationClaim(existing, Created: false, Duplicate: true));
        }

        var admitted = request with { AdmittedAt = DateTimeOffset.UtcNow };
        requests.Add(admitted);
        return Task.FromResult(new DurableMathEvaluationClaim(admitted, Created: true, Duplicate: false));
    }

    public Task<MathEvaluationAttemptRecord> AppendAttemptAsync(
        Guid evaluationRequestId,
        MathEvaluationAttemptStatus status,
        string? failureCode,
        string? failureReason,
        string canonicalAttemptHash,
        DateTimeOffset startedAt,
        DateTimeOffset? completedAt,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var attempt = new MathEvaluationAttemptRecord(
            Guid.NewGuid(),
            evaluationRequestId,
            attempts.Count(item => item.EvaluationRequestId == evaluationRequestId) + 1,
            status,
            failureCode,
            failureReason,
            canonicalAttemptHash,
            startedAt,
            completedAt);
        attempts.Add(attempt);
        return Task.FromResult(attempt);
    }

    public Task<MathEvaluationResult> CompleteEvaluationAsync(
        DurableMathEvaluationRequestRecord request,
        MathEvaluationResult result,
        IReadOnlyDictionary<string, object?> wagerPayload,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (results.TryGetValue(request.EvaluationRequestId, out var existing))
        {
            return Task.FromResult(existing);
        }

        results[request.EvaluationRequestId] = result;
        ReplaceRequest(request with
        {
            Status = DurableMathEvaluationStatus.Completed,
            CompletedAt = result.EvaluatedAt,
            MathEvaluationId = result.MathEvaluationId,
            CertificateId = result.Certificate.CertificateId,
            CertificateHash = result.CanonicalPrizeFactsHash
        });
        return Task.FromResult(result);
    }

    public async Task<MathEvaluationResult> CompleteEvaluationWithEvidenceAsync(
        DurableMathEvaluationRequestRecord request,
        int attemptNumber,
        MathEvaluationResult result,
        IReadOnlyDictionary<string, object?> wagerPayload,
        MathEvaluationProcessingTiming timing,
        string canonicalAttemptHash,
        CancellationToken cancellationToken)
    {
        var completed = await CompleteEvaluationAsync(request, result, wagerPayload, cancellationToken);
        await AppendAttemptAsync(
            request.EvaluationRequestId,
            MathEvaluationAttemptStatus.Completed,
            null,
            null,
            canonicalAttemptHash,
            timing.ProcessingStartedAt,
            DateTimeOffset.UtcNow,
            cancellationToken);
        return completed;
    }

    public Task<DurableMathEvaluationRequestRecord> FailRequestAsync(
        DurableMathEvaluationRequestRecord request,
        string failureCode,
        string failureReason,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var failed = request with
        {
            Status = DurableMathEvaluationStatus.Failed,
            CompletedAt = DateTimeOffset.UtcNow,
            FailureCode = failureCode,
            FailureReason = failureReason
        };
        ReplaceRequest(failed);
        return Task.FromResult(failed);
    }

    public Task<MathEvaluationResult?> FindCompletedResultAsync(
        Guid evaluationRequestId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(results.TryGetValue(evaluationRequestId, out var result) ? result : null);
    }

    public Task<DurableMathEvaluationRequestRecord?> FindByIdempotencyKeyAsync(
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(requests.LastOrDefault(request => request.IdempotencyKey == idempotencyKey));
    }

    public Task<IReadOnlyCollection<DurableMathEvaluationRequestRecord>> FindIncompleteAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult<IReadOnlyCollection<DurableMathEvaluationRequestRecord>>(
            requests.Where(request => request.Status == DurableMathEvaluationStatus.Claimed).ToArray());
    }

    public Task<IReadOnlyCollection<DurableMathEvaluationRequestRecord>> FindByTicketReferenceAsync(
        string ticketReference,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult<IReadOnlyCollection<DurableMathEvaluationRequestRecord>>(
            requests.Where(request => request.TicketReference == ticketReference).ToArray());
    }

    public Task<IReadOnlyCollection<DurableMathEvaluationRequestRecord>> FindByOutcomeCertificateAsync(
        Guid outcomeCertificateId,
        string outcomeCertificateHash,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult<IReadOnlyCollection<DurableMathEvaluationRequestRecord>>(
            requests.Where(request => request.OutcomeCertificateId == outcomeCertificateId &&
                request.OutcomeCertificateHash == outcomeCertificateHash).ToArray());
    }

    public Task<DurableMathEvaluationRequestRecord?> FindByCertificateHashAsync(
        string certificateHash,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(requests.LastOrDefault(request => request.CertificateHash == certificateHash));
    }

    public Task<MathEvaluationPersistenceReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new MathEvaluationPersistenceReadiness(
            TypedEvaluatorRegistryReady: true,
            DurableRepositoryConfigured: false,
            DurableRepositoryReachable: false,
            IdempotencyConfigured: true,
            ReplayVerificationReady: true,
            ProductionActivationDisabled: true,
            Blockers: ["Math Evaluation persistence is using non-production in-memory storage."]));
    }

    private void ReplaceRequest(DurableMathEvaluationRequestRecord replacement)
    {
        var index = requests.FindIndex(request => request.EvaluationRequestId == replacement.EvaluationRequestId);
        if (index < 0)
        {
            throw new InvalidOperationException("Math Evaluation request was not claimed.");
        }

        requests[index] = replacement;
    }
}
