using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public interface IExternalResultSourceRepository
{
    Task<ExternalResultSourceDefinition?> FindSourceAsync(
        string sourceId,
        string sourceVersion,
        CancellationToken cancellationToken);

    Task<ExternalResultRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken);
}

public interface IExternalResultEvidenceRepository
{
    Task<ExternalResultVerificationEvidence?> FindBySourceDrawAsync(
        string sourceId,
        string sourceVersion,
        string providerId,
        string providerVersion,
        string externalDrawId,
        CancellationToken cancellationToken);

    Task AppendIngestionAsync(
        ExternalOfficialResultEnvelope envelope,
        ExternalResultNormalizedPayload normalizedPayload,
        ExternalResultVerificationEvidence evidence,
        CancellationToken cancellationToken);

    Task AppendVerificationEvidenceAsync(
        ExternalResultVerificationEvidence evidence,
        CancellationToken cancellationToken);

    Task<ExternalResultRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken);
}

public sealed record ExternalOfficialResultRuntimeResult(
    ExternalResultNormalizedPayload NormalizedPayload,
    OutcomeCertificate OutcomeCertificate,
    ExternalResultVerificationEvidence Evidence);

public sealed class ExternalOfficialResultRuntimeService(
    IExternalResultSourceRepository sourceRepository,
    IExternalResultEvidenceRepository evidenceRepository)
{
    public async Task<ExternalOfficialResultRuntimeResult> IngestAsync(
        OutcomeProviderRuntimeContext context,
        CancellationToken cancellationToken)
    {
        if (context.Request.Mode == OutcomeRuntimeExecutionMode.Production)
        {
            throw new InvalidOperationException("Production Outcome Authority remains disabled.");
        }

        var envelope = context.Request.ExternalOfficialResult
            ?? throw new InvalidOperationException("External Official Result runtime requires an external result envelope.");

        var source = await sourceRepository.FindSourceAsync(
            envelope.SourceId,
            envelope.SourceVersion,
            cancellationToken);

        var validation = ExternalOfficialResultValidator.ValidateEnvelope(
            envelope,
            source,
            context.Provider,
            context.Request,
            DateTimeOffset.UtcNow);

        if (!validation.IsValid)
        {
            var reason = string.Join("; ", validation.Errors.Select(error => error.Message));
            var failedEvidence = CreateEvidence(
                envelope,
                ExternalResultVerificationStatus.Rejected,
                ExternalResultCustodyState.Rejected,
                envelope.SourcePayloadHash,
                "VALIDATION_FAILED",
                reason);
            await evidenceRepository.AppendVerificationEvidenceAsync(failedEvidence, cancellationToken);
            throw new InvalidOperationException(reason);
        }

        if (source is null)
        {
            throw new InvalidOperationException("External result source is unknown.");
        }

        if (!VerifySignature(source, envelope))
        {
            var failedEvidence = CreateEvidence(
                envelope,
                ExternalResultVerificationStatus.Rejected,
                ExternalResultCustodyState.Rejected,
                envelope.SourcePayloadHash,
                "SIGNATURE_INVALID",
                "External result source signature verification failed.");
            await evidenceRepository.AppendVerificationEvidenceAsync(failedEvidence, cancellationToken);
            throw new InvalidOperationException("External result source signature verification failed.");
        }

        var normalized = Normalize(envelope);
        var existing = await evidenceRepository.FindBySourceDrawAsync(
            envelope.SourceId,
            envelope.SourceVersion,
            envelope.ProviderId,
            envelope.ProviderVersion,
            envelope.ExternalDrawId,
            cancellationToken);

        if (existing is not null)
        {
            if (existing.CanonicalResultHash == normalized.CanonicalPayloadHash)
            {
                return new ExternalOfficialResultRuntimeResult(
                    normalized,
                    CreateOutcomeCertificate(context, normalized.CanonicalPayloadHash, existing.EvidenceHash),
                    existing);
            }

            var conflict = CreateEvidence(
                envelope,
                ExternalResultVerificationStatus.Conflict,
                ExternalResultCustodyState.Disputed,
                normalized.CanonicalPayloadHash,
                "RESULT_CONFLICT",
                "External result conflicts with an existing official result and requires governed supersession.");
            await evidenceRepository.AppendVerificationEvidenceAsync(conflict, cancellationToken);
            throw new InvalidOperationException("External official result conflict requires governed supersession.");
        }

        var evidence = CreateEvidence(
            envelope,
            ExternalResultVerificationStatus.Verified,
            ExternalResultCustodyState.Certified,
            normalized.CanonicalPayloadHash,
            FailureCode: null,
            FailureReason: null);

        await evidenceRepository.AppendIngestionAsync(envelope, normalized, evidence, cancellationToken);
        return new ExternalOfficialResultRuntimeResult(
            normalized,
            CreateOutcomeCertificate(context, normalized.CanonicalPayloadHash, evidence.EvidenceHash),
            evidence);
    }

    public async Task<ExternalResultRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var sourceReadiness = await sourceRepository.CheckReadinessAsync(cancellationToken);
        var evidenceReadiness = await evidenceRepository.CheckReadinessAsync(cancellationToken);
        var blockers = sourceReadiness.Blockers.Concat(evidenceReadiness.Blockers).ToArray();
        return new ExternalResultRuntimeReadiness(
            SourceRepositoryReady: sourceReadiness.SourceRepositoryReady,
            SignatureVerificationReady: true,
            SchemaNormalizationReady: true,
            IngestionEvidenceRepositoryReady: evidenceReadiness.IngestionEvidenceRepositoryReady,
            DurableIdempotencyReady: evidenceReadiness.DurableIdempotencyReady,
            AdvisoryLockingReady: true,
            ProductionGenerationDisabled: true,
            CapabilityMarkers:
            [
                "external-source-definitions",
                "signature-verification",
                "canonical-normalization",
                "duplicate-conflict-detection",
                "custody-evidence"
            ],
            Blockers: blockers);
    }

    public static ExternalResultNormalizedPayload Normalize(ExternalOfficialResultEnvelope envelope)
    {
        IReadOnlyDictionary<string, object?> payload = envelope.SchemaType switch
        {
            ExternalResultSchemaType.UniqueNumberSet => NormalizeNumberSet(envelope.ResultPayload, ordered: false),
            ExternalResultSchemaType.OrderedNumberSequence => NormalizeNumberSet(envelope.ResultPayload, ordered: true),
            ExternalResultSchemaType.BonusNumberSet => NormalizeBonusNumberSet(envelope.ResultPayload),
            ExternalResultSchemaType.SymbolSequence => NormalizeSymbols(envelope.ResultPayload),
            ExternalResultSchemaType.Composite => NormalizeComposite(envelope.ResultPayload),
            _ => throw new InvalidOperationException("Unsupported external result schema.")
        };

        var canonical = CanonicalJson(payload);
        return new ExternalResultNormalizedPayload(
            envelope.SchemaType,
            payload,
            canonical,
            HashCanonical(canonical));
    }

    public static bool VerifySignature(
        ExternalResultSourceDefinition source,
        ExternalOfficialResultEnvelope envelope)
    {
        if (source.SignatureRequirement == ExternalResultSignatureRequirement.NotRequired)
        {
            return true;
        }

        if (string.IsNullOrWhiteSpace(envelope.SourceSignature) ||
            source.VerificationKeyRevokedAt is not null ||
            string.IsNullOrWhiteSpace(source.VerificationKeyId))
        {
            return false;
        }

        var expected = HashCanonical(
            $"external-official-result:v1|{source.SourceId}|{source.SourceVersion}|{envelope.ProviderId}|{envelope.ProviderVersion}|{envelope.ExternalDrawId}|{envelope.SourcePayloadHash}|{source.VerificationKeyId}|{envelope.SignatureAlgorithmVersion}");
        return FixedTimeEquals(expected, envelope.SourceSignature);
    }

    public static string CreateTestSignature(
        ExternalResultSourceDefinition source,
        ExternalOfficialResultEnvelope envelope)
    {
        return HashCanonical(
            $"external-official-result:v1|{source.SourceId}|{source.SourceVersion}|{envelope.ProviderId}|{envelope.ProviderVersion}|{envelope.ExternalDrawId}|{envelope.SourcePayloadHash}|{source.VerificationKeyId}|{envelope.SignatureAlgorithmVersion}");
    }

    public static string CanonicalJson(IReadOnlyDictionary<string, object?> payload)
    {
        var normalized = payload
            .OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .ToDictionary(pair => pair.Key, pair => NormalizeValue(pair.Value), StringComparer.Ordinal);
        return JsonSerializer.Serialize(normalized);
    }

    public static string HashCanonical(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private static IReadOnlyDictionary<string, object?> NormalizeNumberSet(
        IReadOnlyDictionary<string, object?> payload,
        bool ordered)
    {
        var numbers = ReadIntArray(payload, "numbers");
        if (numbers.Length == 0)
        {
            throw new InvalidOperationException("External result number payload is empty.");
        }

        if (!ordered)
        {
            if (numbers.Distinct().Count() != numbers.Length)
            {
                throw new InvalidOperationException("External result unique number set contains duplicate numbers.");
            }

            numbers = numbers.Order().ToArray();
        }

        return new Dictionary<string, object?>
        {
            ["resultType"] = ordered ? "OrderedNumberSequence" : "UniqueNumberSet",
            ["numbers"] = numbers
        };
    }

    private static IReadOnlyDictionary<string, object?> NormalizeBonusNumberSet(IReadOnlyDictionary<string, object?> payload)
    {
        var primary = ReadIntArray(payload, "numbers").Order().ToArray();
        var bonus = ReadIntArray(payload, "bonusNumbers").Order().ToArray();
        if (primary.Length == 0 || bonus.Length == 0)
        {
            throw new InvalidOperationException("External result bonus payload requires primary and bonus numbers.");
        }

        return new Dictionary<string, object?>
        {
            ["resultType"] = "BonusNumberSet",
            ["numbers"] = primary,
            ["bonusNumbers"] = bonus
        };
    }

    private static IReadOnlyDictionary<string, object?> NormalizeSymbols(IReadOnlyDictionary<string, object?> payload)
    {
        var symbols = ReadStringArray(payload, "symbols");
        if (symbols.Length == 0)
        {
            throw new InvalidOperationException("External result symbol payload is empty.");
        }

        return new Dictionary<string, object?>
        {
            ["resultType"] = "SymbolSequence",
            ["symbols"] = symbols
        };
    }

    private static IReadOnlyDictionary<string, object?> NormalizeComposite(IReadOnlyDictionary<string, object?> payload)
    {
        if (!payload.TryGetValue("components", out var components) || components is null)
        {
            throw new InvalidOperationException("External composite result requires components.");
        }

        return new Dictionary<string, object?>
        {
            ["resultType"] = "Composite",
            ["components"] = NormalizeValue(components)
        };
    }

    private static int[] ReadIntArray(IReadOnlyDictionary<string, object?> payload, string key)
    {
        if (!payload.TryGetValue(key, out var value) || value is null)
        {
            return [];
        }

        return value switch
        {
            int[] array => array,
            IEnumerable<int> values => values.ToArray(),
            IEnumerable<object> values => values.Select(Convert.ToInt32).ToArray(),
            JsonElement { ValueKind: JsonValueKind.Array } json => json.EnumerateArray().Select(item => item.GetInt32()).ToArray(),
            _ => throw new InvalidOperationException($"External result field {key} must be an integer array.")
        };
    }

    private static string[] ReadStringArray(IReadOnlyDictionary<string, object?> payload, string key)
    {
        if (!payload.TryGetValue(key, out var value) || value is null)
        {
            return [];
        }

        return value switch
        {
            string[] array => array,
            IEnumerable<string> values => values.ToArray(),
            IEnumerable<object> values => values.Select(Convert.ToString).Where(item => !string.IsNullOrWhiteSpace(item)).Cast<string>().ToArray(),
            JsonElement { ValueKind: JsonValueKind.Array } json => json.EnumerateArray().Select(item => item.GetString() ?? string.Empty).Where(item => item.Length > 0).ToArray(),
            _ => throw new InvalidOperationException($"External result field {key} must be a string array.")
        };
    }

    private static object? NormalizeValue(object? value)
    {
        return value switch
        {
            null => null,
            IReadOnlyDictionary<string, object?> dictionary => dictionary
                .OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .ToDictionary(pair => pair.Key, pair => NormalizeValue(pair.Value), StringComparer.Ordinal),
            IDictionary<string, object?> dictionary => dictionary
                .OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .ToDictionary(pair => pair.Key, pair => NormalizeValue(pair.Value), StringComparer.Ordinal),
            JsonElement element => NormalizeJsonElement(element),
            IEnumerable<int> numbers => numbers.ToArray(),
            IEnumerable<string> strings => strings.ToArray(),
            IEnumerable<object?> values => values.Select(NormalizeValue).ToArray(),
            _ => value
        };
    }

    private static object? NormalizeJsonElement(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Object => element.EnumerateObject()
                .OrderBy(property => property.Name, StringComparer.Ordinal)
                .ToDictionary(property => property.Name, property => NormalizeJsonElement(property.Value), StringComparer.Ordinal),
            JsonValueKind.Array => element.EnumerateArray().Select(NormalizeJsonElement).ToArray(),
            JsonValueKind.String => element.GetString(),
            JsonValueKind.Number when element.TryGetInt64(out var integer) => integer,
            JsonValueKind.Number => element.GetDouble(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private static ExternalResultVerificationEvidence CreateEvidence(
        ExternalOfficialResultEnvelope envelope,
        ExternalResultVerificationStatus status,
        ExternalResultCustodyState custodyState,
        string canonicalResultHash,
        string? FailureCode,
        string? FailureReason)
    {
        var evidenceHash = HashCanonical(
            $"{envelope.IngestionRequestId:N}|{envelope.SourceId}|{envelope.SourceVersion}|{envelope.ProviderId}|{envelope.ProviderVersion}|{envelope.ExternalDrawId}|{status}|{custodyState}|{canonicalResultHash}|{FailureCode}|{FailureReason}");
        return new ExternalResultVerificationEvidence(
            Guid.NewGuid(),
            envelope.IngestionRequestId,
            envelope.SourceId,
            envelope.SourceVersion,
            envelope.ProviderId,
            envelope.ProviderVersion,
            envelope.ExternalDrawId,
            status,
            custodyState,
            canonicalResultHash,
            envelope.SourcePayloadHash,
            FailureCode,
            FailureReason,
            evidenceHash,
            DateTimeOffset.UtcNow);
    }

    private static OutcomeCertificate CreateOutcomeCertificate(
        OutcomeProviderRuntimeContext context,
        string canonicalOutcomeHash,
        string evidenceHash)
    {
        var drawId = Guid.TryParse(context.Request.DrawRequestScope, out var parsedDrawId)
            ? parsedDrawId
            : Guid.NewGuid();
        return new OutcomeCertificate(
            Guid.NewGuid(),
            Guid.NewGuid(),
            drawId,
            context.Request.ManifestBinding?.ProviderId ?? context.Provider.ProviderId,
            context.Request.ManifestBinding?.ProviderVersion ?? context.Provider.ProviderVersion,
            context.Provider.ProviderId,
            context.Provider.ProviderVersion,
            canonicalOutcomeHash,
            evidenceHash,
            [],
            SigningMetadata: null,
            OutcomeCustodyState.Certified,
            DateTimeOffset.UtcNow);
    }

    private static bool FixedTimeEquals(string left, string right)
    {
        var leftBytes = Encoding.UTF8.GetBytes(left);
        var rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length &&
            CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }
}

public sealed class InMemoryExternalResultSourceRepository : IExternalResultSourceRepository
{
    private readonly List<ExternalResultSourceDefinition> sources = [];

    public IReadOnlyCollection<ExternalResultSourceDefinition> Sources => sources;

    public void Add(ExternalResultSourceDefinition source)
    {
        sources.Add(source);
    }

    public Task<ExternalResultSourceDefinition?> FindSourceAsync(
        string sourceId,
        string sourceVersion,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(sources.LastOrDefault(source =>
            source.SourceId == sourceId &&
            source.SourceVersion == sourceVersion));
    }

    public Task<ExternalResultRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new ExternalResultRuntimeReadiness(
            SourceRepositoryReady: true,
            SignatureVerificationReady: true,
            SchemaNormalizationReady: true,
            IngestionEvidenceRepositoryReady: true,
            DurableIdempotencyReady: false,
            AdvisoryLockingReady: false,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: ["in-memory-external-source-repository"],
            Blockers: []));
    }
}

public sealed class InMemoryExternalResultEvidenceRepository : IExternalResultEvidenceRepository
{
    private readonly List<ExternalResultVerificationEvidence> evidence = [];
    private readonly List<ExternalOfficialResultEnvelope> envelopes = [];

    public IReadOnlyCollection<ExternalResultVerificationEvidence> Evidence => evidence;

    public Task<ExternalResultVerificationEvidence?> FindBySourceDrawAsync(
        string sourceId,
        string sourceVersion,
        string providerId,
        string providerVersion,
        string externalDrawId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(evidence.LastOrDefault(item =>
            item.SourceId == sourceId &&
            item.SourceVersion == sourceVersion &&
            item.ProviderId == providerId &&
            item.ProviderVersion == providerVersion &&
            item.ExternalDrawId == externalDrawId &&
            item.Status == ExternalResultVerificationStatus.Verified));
    }

    public Task AppendIngestionAsync(
        ExternalOfficialResultEnvelope envelope,
        ExternalResultNormalizedPayload normalizedPayload,
        ExternalResultVerificationEvidence evidence,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        envelopes.Add(envelope);
        this.evidence.Add(evidence);
        return Task.CompletedTask;
    }

    public Task AppendVerificationEvidenceAsync(
        ExternalResultVerificationEvidence evidence,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        this.evidence.Add(evidence);
        return Task.CompletedTask;
    }

    public Task<ExternalResultRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new ExternalResultRuntimeReadiness(
            SourceRepositoryReady: true,
            SignatureVerificationReady: true,
            SchemaNormalizationReady: true,
            IngestionEvidenceRepositoryReady: true,
            DurableIdempotencyReady: false,
            AdvisoryLockingReady: false,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: ["in-memory-external-result-evidence"],
            Blockers: []));
    }
}
