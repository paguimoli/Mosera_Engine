using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public interface IPhysicalDrawAuthorityRepository
{
    Task<PhysicalDrawAuthorityDefinition?> FindAuthorityAsync(
        string authorityId,
        string authorityVersion,
        CancellationToken cancellationToken);

    Task<PhysicalDrawRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken);
}

public interface IPhysicalDrawEvidenceRepository
{
    Task<PhysicalDrawVerificationEvidence?> FindByAuthorityDrawAsync(
        string authorityId,
        string authorityVersion,
        string providerId,
        string providerVersion,
        string drawIdentifier,
        CancellationToken cancellationToken);

    Task AppendDrawEventAsync(
        PhysicalDrawResultEnvelope envelope,
        PhysicalDrawNormalizedPayload normalizedPayload,
        PhysicalDrawVerificationEvidence evidence,
        CancellationToken cancellationToken);

    Task AppendVerificationEvidenceAsync(
        PhysicalDrawVerificationEvidence evidence,
        CancellationToken cancellationToken);

    Task<PhysicalDrawRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken);
}

public sealed record PhysicalDrawResultRuntimeResult(
    PhysicalDrawNormalizedPayload NormalizedPayload,
    OutcomeCertificate OutcomeCertificate,
    PhysicalDrawVerificationEvidence Evidence);

public sealed class PhysicalDrawResultRuntimeService(
    IPhysicalDrawAuthorityRepository authorityRepository,
    IPhysicalDrawEvidenceRepository evidenceRepository)
{
    public async Task<PhysicalDrawResultRuntimeResult> IngestAsync(
        OutcomeProviderRuntimeContext context,
        CancellationToken cancellationToken)
    {
        if (context.Request.Mode == OutcomeRuntimeExecutionMode.Production)
        {
            throw new InvalidOperationException("Production Outcome Authority remains disabled.");
        }

        var envelope = context.Request.PhysicalDrawResult
            ?? throw new InvalidOperationException("Physical Draw runtime requires a physical draw event.");

        var authority = await authorityRepository.FindAuthorityAsync(
            envelope.AuthorityId,
            envelope.AuthorityVersion,
            cancellationToken);

        var validation = PhysicalDrawResultValidator.ValidateEnvelope(
            envelope,
            authority,
            context.Provider,
            context.Request,
            DateTimeOffset.UtcNow);

        if (!validation.IsValid)
        {
            var reason = string.Join("; ", validation.Errors.Select(error => error.Message));
            var failedEvidence = CreateEvidence(
                envelope,
                PhysicalDrawVerificationStatus.Rejected,
                PhysicalDrawCustodyState.Rejected,
                envelope.ContentHash,
                "VALIDATION_FAILED",
                reason);
            await evidenceRepository.AppendVerificationEvidenceAsync(failedEvidence, cancellationToken);
            throw new InvalidOperationException(reason);
        }

        if (authority is null)
        {
            throw new InvalidOperationException("Physical draw authority is unknown.");
        }

        var normalized = Normalize(envelope);
        var existing = await evidenceRepository.FindByAuthorityDrawAsync(
            envelope.AuthorityId,
            envelope.AuthorityVersion,
            envelope.ProviderId,
            envelope.ProviderVersion,
            envelope.DrawIdentifier,
            cancellationToken);

        if (existing is not null)
        {
            if (existing.CanonicalResultHash == normalized.CanonicalPayloadHash)
            {
                return new PhysicalDrawResultRuntimeResult(
                    normalized,
                    CreateOutcomeCertificate(context, normalized.CanonicalPayloadHash, existing.EvidenceHash),
                    existing);
            }

            var conflict = CreateEvidence(
                envelope,
                PhysicalDrawVerificationStatus.Conflict,
                PhysicalDrawCustodyState.Disputed,
                normalized.CanonicalPayloadHash,
                "PHYSICAL_DRAW_CONFLICT",
                "Physical draw result conflicts with an existing certified draw and requires governed supersession.");
            await evidenceRepository.AppendVerificationEvidenceAsync(conflict, cancellationToken);
            throw new InvalidOperationException("Physical draw result conflict requires governed supersession.");
        }

        var evidence = CreateEvidence(
            envelope,
            PhysicalDrawVerificationStatus.Verified,
            PhysicalDrawCustodyState.Certified,
            normalized.CanonicalPayloadHash,
            FailureCode: null,
            FailureReason: null);

        await evidenceRepository.AppendDrawEventAsync(envelope, normalized, evidence, cancellationToken);
        return new PhysicalDrawResultRuntimeResult(
            normalized,
            CreateOutcomeCertificate(context, normalized.CanonicalPayloadHash, evidence.EvidenceHash),
            evidence);
    }

    public async Task<PhysicalDrawRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var authorityReadiness = await authorityRepository.CheckReadinessAsync(cancellationToken);
        var evidenceReadiness = await evidenceRepository.CheckReadinessAsync(cancellationToken);
        var blockers = authorityReadiness.Blockers.Concat(evidenceReadiness.Blockers).ToArray();
        return new PhysicalDrawRuntimeReadiness(
            AuthorityRepositoryReady: authorityReadiness.AuthorityRepositoryReady,
            WitnessValidationReady: true,
            EquipmentValidationReady: true,
            SchemaNormalizationReady: true,
            EvidenceRepositoryReady: evidenceReadiness.EvidenceRepositoryReady,
            DurableIdempotencyReady: evidenceReadiness.DurableIdempotencyReady,
            AdvisoryLockingReady: true,
            ProductionGenerationDisabled: true,
            CapabilityMarkers:
            [
                "physical-draw-authorities",
                "physical-witness-validation",
                "physical-equipment-validation",
                "physical-custody-evidence",
                "physical-canonical-normalization",
                "physical-conflict-detection"
            ],
            Blockers: blockers);
    }

    public static PhysicalDrawNormalizedPayload Normalize(PhysicalDrawResultEnvelope envelope)
    {
        IReadOnlyDictionary<string, object?> payload = envelope.SchemaType switch
        {
            PhysicalDrawResultSchemaType.UniqueNumberSet => NormalizeNumberSet(envelope.ResultPayload, ordered: false),
            PhysicalDrawResultSchemaType.OrderedNumberSequence => NormalizeNumberSet(envelope.ResultPayload, ordered: true),
            PhysicalDrawResultSchemaType.BonusNumberSet => NormalizeBonusNumberSet(envelope.ResultPayload),
            PhysicalDrawResultSchemaType.SupplementaryNumberSet => NormalizeSupplementaryNumberSet(envelope.ResultPayload),
            PhysicalDrawResultSchemaType.Composite => NormalizeComposite(envelope.ResultPayload),
            _ => throw new InvalidOperationException("Unsupported physical draw result schema.")
        };

        var canonical = CanonicalJson(payload);
        return new PhysicalDrawNormalizedPayload(
            envelope.SchemaType,
            payload,
            canonical,
            HashCanonical(canonical));
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
            throw new InvalidOperationException("Physical draw number payload is empty.");
        }

        if (!ordered)
        {
            if (numbers.Distinct().Count() != numbers.Length)
            {
                throw new InvalidOperationException("Physical draw unique number set contains duplicate numbers.");
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
            throw new InvalidOperationException("Physical draw bonus payload requires primary and bonus numbers.");
        }

        return new Dictionary<string, object?>
        {
            ["resultType"] = "BonusNumberSet",
            ["numbers"] = primary,
            ["bonusNumbers"] = bonus
        };
    }

    private static IReadOnlyDictionary<string, object?> NormalizeSupplementaryNumberSet(IReadOnlyDictionary<string, object?> payload)
    {
        var primary = ReadIntArray(payload, "numbers").Order().ToArray();
        var supplementary = ReadIntArray(payload, "supplementaryNumbers").Order().ToArray();
        if (primary.Length == 0 || supplementary.Length == 0)
        {
            throw new InvalidOperationException("Physical draw supplementary payload requires primary and supplementary numbers.");
        }

        return new Dictionary<string, object?>
        {
            ["resultType"] = "SupplementaryNumberSet",
            ["numbers"] = primary,
            ["supplementaryNumbers"] = supplementary
        };
    }

    private static IReadOnlyDictionary<string, object?> NormalizeComposite(IReadOnlyDictionary<string, object?> payload)
    {
        if (!payload.TryGetValue("components", out var components) || components is null)
        {
            throw new InvalidOperationException("Physical composite draw requires components.");
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
            _ => throw new InvalidOperationException($"Physical draw field {key} must be an integer array.")
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

    private static PhysicalDrawVerificationEvidence CreateEvidence(
        PhysicalDrawResultEnvelope envelope,
        PhysicalDrawVerificationStatus status,
        PhysicalDrawCustodyState custodyState,
        string canonicalResultHash,
        string? FailureCode,
        string? FailureReason)
    {
        var evidenceHash = HashCanonical(
            $"{envelope.DrawEventId:N}|{envelope.AuthorityId}|{envelope.AuthorityVersion}|{envelope.ProviderId}|{envelope.ProviderVersion}|{envelope.DrawIdentifier}|{status}|{custodyState}|{canonicalResultHash}|{FailureCode}|{FailureReason}");
        return new PhysicalDrawVerificationEvidence(
            Guid.NewGuid(),
            envelope.DrawEventId,
            envelope.AuthorityId,
            envelope.AuthorityVersion,
            envelope.ProviderId,
            envelope.ProviderVersion,
            envelope.DrawIdentifier,
            status,
            custodyState,
            canonicalResultHash,
            envelope.ContentHash,
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
}

public sealed class InMemoryPhysicalDrawAuthorityRepository : IPhysicalDrawAuthorityRepository
{
    private readonly List<PhysicalDrawAuthorityDefinition> authorities = [];

    public IReadOnlyCollection<PhysicalDrawAuthorityDefinition> Authorities => authorities;

    public void Add(PhysicalDrawAuthorityDefinition authority)
    {
        authorities.Add(authority);
    }

    public Task<PhysicalDrawAuthorityDefinition?> FindAuthorityAsync(
        string authorityId,
        string authorityVersion,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(authorities.LastOrDefault(authority =>
            authority.AuthorityId == authorityId &&
            authority.AuthorityVersion == authorityVersion));
    }

    public Task<PhysicalDrawRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new PhysicalDrawRuntimeReadiness(
            AuthorityRepositoryReady: true,
            WitnessValidationReady: true,
            EquipmentValidationReady: true,
            SchemaNormalizationReady: true,
            EvidenceRepositoryReady: true,
            DurableIdempotencyReady: false,
            AdvisoryLockingReady: false,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: ["in-memory-physical-draw-authorities"],
            Blockers: []));
    }
}

public sealed class InMemoryPhysicalDrawEvidenceRepository : IPhysicalDrawEvidenceRepository
{
    private readonly List<PhysicalDrawVerificationEvidence> evidence = [];
    private readonly List<PhysicalDrawResultEnvelope> events = [];

    public IReadOnlyCollection<PhysicalDrawVerificationEvidence> Evidence => evidence;

    public Task<PhysicalDrawVerificationEvidence?> FindByAuthorityDrawAsync(
        string authorityId,
        string authorityVersion,
        string providerId,
        string providerVersion,
        string drawIdentifier,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(evidence.LastOrDefault(item =>
            item.AuthorityId == authorityId &&
            item.AuthorityVersion == authorityVersion &&
            item.ProviderId == providerId &&
            item.ProviderVersion == providerVersion &&
            item.DrawIdentifier == drawIdentifier &&
            item.Status == PhysicalDrawVerificationStatus.Verified));
    }

    public Task AppendDrawEventAsync(
        PhysicalDrawResultEnvelope envelope,
        PhysicalDrawNormalizedPayload normalizedPayload,
        PhysicalDrawVerificationEvidence evidence,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        events.Add(envelope);
        this.evidence.Add(evidence);
        return Task.CompletedTask;
    }

    public Task AppendVerificationEvidenceAsync(
        PhysicalDrawVerificationEvidence evidence,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        this.evidence.Add(evidence);
        return Task.CompletedTask;
    }

    public Task<PhysicalDrawRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new PhysicalDrawRuntimeReadiness(
            AuthorityRepositoryReady: true,
            WitnessValidationReady: true,
            EquipmentValidationReady: true,
            SchemaNormalizationReady: true,
            EvidenceRepositoryReady: true,
            DurableIdempotencyReady: false,
            AdvisoryLockingReady: false,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: ["in-memory-physical-draw-evidence"],
            Blockers: []));
    }
}
