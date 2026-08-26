using System.Security.Cryptography;
using System.Text;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed record SchedulerOutcomeFanoutOptions(
    bool Enabled,
    bool QualificationMode,
    string DeploymentEnvironment,
    string SigningPrivateKeyPem,
    int PageSize,
    int MaxDegreeOfParallelism,
    string QualificationFailureStage,
    int QualificationFailureAfterPages)
{
    public bool IsQualificationRuntime =>
        Enabled && QualificationMode &&
        !string.Equals(DeploymentEnvironment, "production", StringComparison.OrdinalIgnoreCase);

    public bool ShouldInjectFailure(string stage) =>
        IsQualificationRuntime &&
        string.Equals(QualificationFailureStage, stage, StringComparison.Ordinal);
}

public sealed record CanonicalOutcomeCertificateSource(
    Guid ExecutionManifestId,
    Guid DrawId,
    Guid ProviderEvidenceId,
    Guid ProviderExecutionId,
    string ProviderEvidenceHash,
    Guid GameManifestId,
    string GameManifestVersion,
    string GameManifestHash,
    string OutcomeStrategyId,
    string OutcomeStrategyVersion,
    string RngProviderId,
    string RngProviderVersion,
    string CanonicalOutcomeJson,
    string CanonicalOutcomeHash,
    DateTimeOffset GeneratedAt,
    SigningProviderDefinition SigningProvider);

public sealed record CanonicalOutcomeCertificateIssueResult(
    OutcomeCertificate Certificate,
    CertificateSignature Signature,
    bool Duplicate);

public interface ICanonicalOutcomeCertificateRepository
{
    Task<CanonicalOutcomeCertificateSource?> FindSourceAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken);

    Task<CanonicalOutcomeCertificateIssueResult?> FindByExecutionManifestAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken);

    Task<CanonicalOutcomeCertificateIssueResult> PersistAsync(
        CanonicalOutcomeCertificateSource source,
        OutcomeCertificate certificate,
        CertificateSignature signature,
        CancellationToken cancellationToken);
}

public sealed class CanonicalOutcomeCertificateAuthority(
    ICanonicalOutcomeCertificateRepository repository,
    CertificateVerificationService verificationService,
    SchedulerOutcomeFanoutOptions options)
{
    public async Task<CanonicalOutcomeCertificateIssueResult> IssueAsync(
        CanonicalDrawExecutionResult generation,
        CancellationToken cancellationToken)
    {
        if (!options.IsQualificationRuntime)
        {
            throw new InvalidOperationException(
                "Scheduler Outcome Certificate issuance is disabled outside an explicit non-production qualification runtime.");
        }
        if (generation.Status != CanonicalDrawExecutionStatus.AwaitingCertification)
        {
            throw new InvalidOperationException("Outcome Certificate issuance requires durable generated provider evidence.");
        }

        var existing = await repository.FindByExecutionManifestAsync(
            generation.ExecutionManifestId,
            cancellationToken);
        if (existing is not null)
        {
            EnsureGenerationMatches(generation, existing.Certificate.CanonicalOutcomeHash);
            return existing with { Duplicate = true };
        }

        var source = await repository.FindSourceAsync(generation.ExecutionManifestId, cancellationToken)
            ?? throw new InvalidOperationException("Canonical generated provider evidence is unavailable for certification.");
        EnsureGenerationMatches(generation, source.CanonicalOutcomeHash);
        if (CanonicalProviderOutcomeFactory.Hash(source.CanonicalOutcomeJson) != source.CanonicalOutcomeHash)
        {
            throw new InvalidOperationException("Canonical outcome source bytes do not match generated provider evidence.");
        }

        var issuedAt = DateTimeOffset.UtcNow;
        var certificateId = DeterministicGuid($"scheduler-outcome-certificate:{source.ExecutionManifestId:N}:{source.CanonicalOutcomeHash}");
        var outcomeId = DeterministicGuid($"scheduler-outcome-event:{source.ExecutionManifestId:N}:{source.CanonicalOutcomeHash}");
        var certificate = new OutcomeCertificate(
            certificateId,
            outcomeId,
            source.DrawId,
            source.OutcomeStrategyId,
            source.OutcomeStrategyVersion,
            source.RngProviderId,
            source.RngProviderVersion,
            source.CanonicalOutcomeHash,
            source.ProviderEvidenceHash,
            [],
            null,
            OutcomeCustodyState.Certified,
            issuedAt);
        var signature = CreateAndVerifySignature(source, certificateId, issuedAt);
        return await repository.PersistAsync(source, certificate, signature, cancellationToken);
    }

    private CertificateSignature CreateAndVerifySignature(
        CanonicalOutcomeCertificateSource source,
        Guid certificateId,
        DateTimeOffset issuedAt)
    {
        if (string.IsNullOrWhiteSpace(options.SigningPrivateKeyPem))
        {
            throw new InvalidOperationException("Qualification signing private key is not configured.");
        }

        string signatureValue;
        try
        {
            using var rsa = RSA.Create();
            rsa.ImportFromPem(options.SigningPrivateKeyPem);
            if (rsa.KeySize < 3072)
            {
                throw new InvalidOperationException("Qualification signing requires RSA-3072 or stronger.");
            }
            signatureValue = Convert.ToBase64String(rsa.SignData(
                Encoding.UTF8.GetBytes(source.CanonicalOutcomeHash),
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pkcs1));
        }
        catch (CryptographicException error)
        {
            throw new InvalidOperationException("Qualification signing private key is invalid.", error);
        }

        var signature = new CertificateSignature(
            DeterministicGuid($"scheduler-outcome-signature:{certificateId:N}:{source.SigningProvider.ContentHash}"),
            "OutcomeCertificate",
            certificateId,
            source.SigningProvider.ProviderId,
            source.SigningProvider.ProviderVersion,
            source.SigningProvider.Algorithm,
            source.SigningProvider.AlgorithmVersion,
            source.CanonicalOutcomeHash,
            signatureValue,
            SignatureVerificationStatus.Verified,
            issuedAt);
        var verification = verificationService.Verify(new CertificateVerificationRequest(
            "OutcomeCertificate",
            certificateId,
            source.CanonicalOutcomeHash,
            source.CanonicalOutcomeJson,
            signature,
            source.SigningProvider,
            [],
            CertificateVerificationMode.Production));
        if (!verification.IsValid)
        {
            throw new InvalidOperationException(
                $"Outcome Certificate signature verification failed: {string.Join("; ", verification.Errors)}");
        }
        return signature;
    }

    private static void EnsureGenerationMatches(CanonicalDrawExecutionResult generation, string outcomeHash)
    {
        if (!string.Equals(generation.GeneratedOutcomeHash, outcomeHash, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Outcome Certificate retry conflicts with generated provider evidence.");
        }
    }

    private static Guid DeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes.AsSpan(0, 16));
    }
}

public sealed record SchedulerTicketEvaluationItem(
    Guid TicketId,
    Guid TicketItemId,
    int ItemIndex,
    Guid ExecutionManifestId,
    string ExecutionManifestHash,
    Guid ProductVersionId,
    string ProductVersionHash,
    string Currency,
    long StakeMinor,
    GameManifestV1 Manifest,
    MathModelDefinitionV1 MathModel,
    PaytableDefinitionV1 Paytable,
    string WagerSchema,
    IReadOnlyDictionary<string, object?> WagerPayload);

public sealed record SchedulerTicketPage(
    IReadOnlyCollection<SchedulerTicketEvaluationItem> Items,
    Guid? NextTicketId);

public sealed record SchedulerVerifiedOutcomePayload(
    string CanonicalJson,
    IReadOnlyDictionary<string, object?> CanonicalPayload,
    int? BullseyeNumber,
    string? BullseyeEvidenceHash,
    string? BullseyePrimaryResultHash,
    string? BullseyeProviderConfigurationHash,
    Guid? BullseyeExecutionManifestId);

public interface ISchedulerOutcomeFanoutRepository
{
    Task<OutcomeCertificate> LoadOutcomeCertificateAsync(
        Guid certificateId,
        string certificateHash,
        CancellationToken cancellationToken);

    Task<SchedulerVerifiedOutcomePayload> LoadOutcomePayloadAsync(
        CanonicalOutcomeVersion outcome,
        CancellationToken cancellationToken);

    Task<SchedulerTicketPage> ListEligibleTicketItemsAsync(
        CanonicalOutcomeVersion outcome,
        Guid? afterTicketId,
        int limit,
        CancellationToken cancellationToken);
}

public sealed record SchedulerOutcomeFanoutResult(
    int EligibleItemCount,
    int EvaluationCount,
    int SettlementInputCount,
    int SettlementRequestCount,
    int PageCount,
    bool ZeroTicketDraw,
    string EvidenceHash);

public sealed class SchedulerOutcomeCompletionFanout(
    ISchedulerOutcomeFanoutRepository repository,
    DurableMathEvaluationService mathAuthority,
    SettlementInputAdapter settlementInputAdapter,
    CanonicalOutcomeAuthority outcomeAuthority,
    SchedulerOutcomeFanoutOptions options)
{
    public async Task<SchedulerOutcomeFanoutResult> ExecuteAsync(
        CanonicalOutcomeVersion outcome,
        CancellationToken cancellationToken)
    {
        if (!options.IsQualificationRuntime)
        {
            throw new InvalidOperationException(
                "Scheduler Outcome-to-Completion fanout is disabled outside an explicit non-production qualification runtime.");
        }

        var certificate = await repository.LoadOutcomeCertificateAsync(
            outcome.OutcomeCertificateId,
            outcome.OutcomeCertificateHash,
            cancellationToken);
        var verifiedOutcome = await repository.LoadOutcomePayloadAsync(outcome, cancellationToken);
        Guid? afterTicketId = null;
        var eligible = 0;
        var evaluations = 0;
        var settlementInputs = 0;
        var settlementRequests = 0;
        var pages = 0;

        while (true)
        {
            var page = await repository.ListEligibleTicketItemsAsync(
                outcome,
                afterTicketId,
                Math.Clamp(options.PageSize, 1, 500),
                cancellationToken);
            if (page.Items.Count == 0)
            {
                break;
            }

            pages += 1;
            eligible += page.Items.Count;
            var throttle = new SemaphoreSlim(Math.Clamp(options.MaxDegreeOfParallelism, 1, 8));
            var tasks = page.Items.GroupBy(item => item.TicketId).Select(async ticketItems =>
            {
                await throttle.WaitAsync(cancellationToken);
                try
                {
                    var completed = new List<(MathEvaluationResult Evaluation, SettlementInput Input, OutcomeSettlementRequest Request)>();
                    decimal allocatedPayoutMinor = 0m;
                    foreach (var item in ticketItems.OrderBy(item => item.ItemIndex))
                    {
                        ValidateLineage(outcome, item);
                        var wagerPayload = new Dictionary<string, object?>(item.WagerPayload, StringComparer.Ordinal);
                        if (verifiedOutcome.BullseyeNumber is not null)
                        {
                            wagerPayload["authorityBullseye"] = verifiedOutcome.BullseyeNumber.Value;
                            wagerPayload["authorityBullseyeEvidenceHash"] = verifiedOutcome.BullseyeEvidenceHash;
                            wagerPayload["authorityBullseyePrimaryResultHash"] = verifiedOutcome.BullseyePrimaryResultHash;
                            wagerPayload["authorityBullseyeProviderConfigurationHash"] = verifiedOutcome.BullseyeProviderConfigurationHash;
                            wagerPayload["authorityBullseyeExecutionManifestId"] = verifiedOutcome.BullseyeExecutionManifestId;
                        }
                        if (ReadCapMinor(item.Paytable.Caps, "combinedTicketPayoutCapMinor") is decimal ticketCapMinor)
                        {
                            wagerPayload["ticketPayoutCapMinor"] = ticketCapMinor;
                            wagerPayload["ticketPriorPayoutMinor"] = allocatedPayoutMinor;
                        }
                        var ticketReference = item.TicketItemId.ToString();
                        var idempotencyKey = $"scheduler-math:{outcome.OutcomeVersionId:N}:{item.TicketItemId:N}";
                        var result = await mathAuthority.EvaluateAsync(
                            new MathCertificateEvaluationRequest(
                                DeterministicGuid($"{idempotencyKey}:request"),
                                idempotencyKey,
                                MathEvaluationMode.DryRun,
                                item.Manifest,
                                certificate,
                                item.MathModel,
                                item.Paytable,
                                ticketReference,
                                item.WagerSchema,
                                wagerPayload,
                                verifiedOutcome.CanonicalPayload,
                                verifiedOutcome.CanonicalJson),
                            cancellationToken);
                        InjectFailure("AfterMathBeforeSettlementInput");
                        allocatedPayoutMinor += item.StakeMinor * result.PrizeFacts.Multiplier;
                        var settlementInput = await settlementInputAdapter.ConvertAsync(result, cancellationToken);
                        InjectFailure("AfterSettlementInputBeforeRequest");
                        var settlementRequest = await outcomeAuthority.EmitSettlementRequestAsync(
                            new OutcomeSettlementRequestCommand(
                                $"scheduler-settlement:{outcome.OutcomeVersionId:N}:{settlementInput.SettlementInputId:N}",
                                outcome.OutcomeVersionId,
                                settlementInput.SettlementInputId,
                                outcome.CorrelationId,
                                $"math-evaluation:{result.MathEvaluationId:N}",
                                outcome.AuditReference),
                            cancellationToken);
                        completed.Add((result, settlementInput, settlementRequest));
                    }
                    return completed;
                }
                finally
                {
                    throttle.Release();
                }
            }).ToArray();
            var completed = (await Task.WhenAll(tasks)).SelectMany(item => item).ToArray();
            evaluations += completed.Length;
            settlementInputs += completed.Select(item => item.Input.SettlementInputId).Distinct().Count();
            settlementRequests += completed.Select(item => item.Request.SettlementRequestId).Distinct().Count();
            if (options.ShouldInjectFailure("AfterCompletedPages") &&
                pages >= options.QualificationFailureAfterPages)
            {
                throw new InvalidOperationException(
                    "PR-04A qualification failure injected after a completed fanout page.");
            }
            afterTicketId = page.NextTicketId;
            if (afterTicketId is null)
            {
                break;
            }
        }

        var evidenceHash = Hash(string.Join(
            "|",
            outcome.OutcomeVersionId.ToString("N"),
            eligible,
            evaluations,
            settlementInputs,
            settlementRequests,
            pages));
        return new SchedulerOutcomeFanoutResult(
            eligible,
            evaluations,
            settlementInputs,
            settlementRequests,
            pages,
            eligible == 0,
            evidenceHash);
    }

    private void InjectFailure(string stage)
    {
        if (options.ShouldInjectFailure(stage))
        {
            throw new InvalidOperationException($"PR-04A qualification failure injected at {stage}.");
        }
    }

    private static decimal? ReadCapMinor(IReadOnlyDictionary<string, object?> caps, string key)
    {
        if (!caps.TryGetValue(key, out var value) || value is null) return null;
        if (value is System.Text.Json.JsonElement element &&
            element.ValueKind == System.Text.Json.JsonValueKind.Number)
        {
            return element.GetDecimal();
        }
        return Convert.ToDecimal(value);
    }

    private static void ValidateLineage(CanonicalOutcomeVersion outcome, SchedulerTicketEvaluationItem item)
    {
        if (item.ExecutionManifestId != outcome.ExecutionManifestId ||
            !string.Equals(item.ExecutionManifestHash, outcome.ExecutionManifestHash, StringComparison.Ordinal) ||
            item.ProductVersionId != outcome.GameDefinitionVersionId ||
            !string.Equals(item.ProductVersionHash, outcome.GameDefinitionHash, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Ticket-to-outcome immutable execution lineage mismatch.");
        }
        if (!item.Manifest.PaytableReferences.Any(reference =>
                reference.Contains(item.Paytable.PaytableId, StringComparison.Ordinal) &&
                reference.Contains(item.Paytable.Version, StringComparison.Ordinal)))
        {
            throw new InvalidOperationException("Ticket paytable lineage is not bound to its immutable Game Manifest.");
        }
        if (!string.Equals(item.Paytable.MathModelId, item.MathModel.MathModelId, StringComparison.Ordinal) ||
            !string.Equals(item.Paytable.MathModelVersion, item.MathModel.Version, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Ticket paytable lineage does not reference the exact Math Model version.");
        }
    }

    private static Guid DeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes.AsSpan(0, 16));
    }

    private static string Hash(string value) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
}
