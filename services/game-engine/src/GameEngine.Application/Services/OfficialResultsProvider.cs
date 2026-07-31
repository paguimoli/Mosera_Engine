using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using GameEngine.Application.Interfaces;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class OfficialResultsProvider(
    CanonicalOutcomeProviderAuthority providerAuthority,
    IExternalResultSourceRepository sourceRepository,
    IGameDefinitionRepository gameDefinitions,
    IGameDefinitionVersionRepository gameDefinitionVersions)
{
    private const string NormalizationVersion = "1.0.0";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter() }
    };

    public async Task<OfficialResultIngestionResult> IngestAsync(
        DrawExecutionManifest manifest,
        OfficialResultIngestionRequest request,
        CancellationToken cancellationToken)
    {
        ValidateRequestIdentity(manifest, request);
        var registration = await providerAuthority.ResolveAsync(manifest, cancellationToken);
        if (registration.ProviderCategory != CanonicalOutcomeProviderCategory.OfficialResults)
        {
            throw new InvalidOperationException(
                "Official result ingestion requires an OFFICIAL_RESULTS provider binding.");
        }

        var requestHash = HashCanonical(JsonSerializer.Serialize(request, JsonOptions));
        var existing = await providerAuthority.FindGeneratedEvidenceAsync(
            manifest.ExecutionManifestId,
            cancellationToken);
        if (existing is not null)
        {
            var existingEvidence = DeserializeEvidence(existing);
            if (FixedHashEquals(existingEvidence.CanonicalRequestHash, requestHash) ||
                IsSameOfficialResult(existingEvidence, request))
            {
                return RestoreResult(existing, existingEvidence, duplicate: true);
            }

            if (request.SupersedesEvidenceId != existing.EvidenceId)
            {
                throw new InvalidOperationException(
                    "Conflicting official result requires an explicit supersession of the current provider evidence.");
            }

            if (string.IsNullOrWhiteSpace(request.CorrectionReason))
            {
                throw new InvalidOperationException(
                    "Official result supersession requires a correction reason.");
            }
        }
        else if (request.SupersedesEvidenceId is not null)
        {
            throw new InvalidOperationException(
                "Official result supersession cannot reference missing provider evidence.");
        }

        var claim = existing is null
            ? await providerAuthority.ClaimExecutionAsync(
                manifest,
                request.IdempotencyKey,
                requestHash,
                cancellationToken)
            : await providerAuthority.ClaimSupersedingExecutionAsync(
                manifest,
                existing.ExecutionId,
                request.IdempotencyKey,
                requestHash,
                cancellationToken);

        if (claim.Duplicate)
        {
            var completed = await providerAuthority.FindGeneratedEvidenceAsync(
                manifest.ExecutionManifestId,
                cancellationToken);
            if (completed is not null &&
                completed.ExecutionId == claim.Claim.ExecutionId)
            {
                return RestoreResult(
                    completed,
                    DeserializeEvidence(completed),
                    duplicate: true);
            }
        }

        var attemptNumber = await providerAuthority.GetNextAttemptNumberAsync(
            claim.Claim.ExecutionId,
            cancellationToken);
        var startedAt = DateTimeOffset.UtcNow;
        try
        {
            var source = await sourceRepository.FindSourceAsync(
                request.SourceId,
                request.SourceVersion,
                cancellationToken)
                ?? throw new InvalidOperationException(
                    "Official result source is not registered.");
            var definitionVersion = await gameDefinitionVersions.GetAsync(
                manifest.GameDefinitionVersionId,
                cancellationToken)
                ?? throw new InvalidOperationException(
                    "Execution Manifest references an unknown Game Definition version.");
            var definition = await gameDefinitions.GetAsync(
                definitionVersion.GameDefinitionId,
                cancellationToken)
                ?? throw new InvalidOperationException(
                    "Game Definition version references an unknown Game Definition.");

            ValidateSource(source, request, definitionVersion);
            var normalized = Normalize(
                manifest,
                registration,
                definition,
                definitionVersion,
                request);
            var completedAt = DateTimeOffset.UtcNow;
            var evidenceWithoutHash = new OfficialResultProviderEvidence(
                request.RequestId,
                claim.Claim.ExecutionId,
                claim.Claim.ExecutionVersion,
                claim.Claim.SupersedesExecutionId,
                request.SupersedesEvidenceId,
                request.CorrectionReason,
                registration.ProviderId,
                registration.ProviderVersion,
                registration.ConfigurationVersion,
                request.SourceId,
                request.SourceVersion,
                request.AcquisitionMethod,
                request.RetrievedAt,
                NormalizationVersion,
                true,
                request.RawPayloadHash,
                normalized.CanonicalPayloadHash,
                request.SourceAuthenticationEvidenceHash,
                request.TransportEvidenceHash,
                $"official-result:{manifest.DrawId:N}:v{claim.Claim.ExecutionVersion}",
                requestHash,
                normalized,
                string.Empty,
                completedAt);
            var evidence = evidenceWithoutHash with
            {
                EvidenceHash = HashEvidence(evidenceWithoutHash)
            };
            var attempt = CompletedAttempt(
                claim.Claim,
                attemptNumber,
                requestHash,
                startedAt,
                completedAt);
            var authorityEvidence = ToAuthorityEvidence(
                manifest,
                claim.Claim,
                evidence,
                attempt);
            await providerAuthority.CompleteGeneratedExecutionAsync(
                attempt,
                authorityEvidence,
                cancellationToken);
            return new OfficialResultIngestionResult(
                claim.Claim.ExecutionId,
                authorityEvidence.EvidenceId,
                manifest.ExecutionManifestId,
                manifest.DrawId,
                request.IdempotencyKey,
                requestHash,
                normalized,
                evidence,
                Duplicate: false,
                Superseding: claim.Claim.ExecutionVersion > 1);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            var completedAt = DateTimeOffset.UtcNow;
            await providerAuthority.AppendAttemptAsync(
                FailedAttempt(
                    claim.Claim,
                    attemptNumber,
                    requestHash,
                    error,
                    startedAt,
                    completedAt),
                cancellationToken);
            throw new InvalidOperationException(
                "Official Results provider failed closed.",
                error);
        }
    }

    public async Task<OutcomeProviderExecutionEvidence> BindOutcomeCertificateAsync(
        DrawExecutionManifest manifest,
        Guid outcomeCertificateId,
        string outcomeCertificateHash,
        CancellationToken cancellationToken)
    {
        RequireHash(outcomeCertificateHash, "Outcome Certificate hash");
        var generated = await providerAuthority.FindGeneratedEvidenceAsync(
            manifest.ExecutionManifestId,
            cancellationToken)
            ?? throw new InvalidOperationException(
                "Outcome Certificate binding requires persisted official result evidence.");
        var authoritative = generated with
        {
            EvidenceId = Guid.NewGuid(),
            EvidenceHash = HashCanonical(
                $"{generated.EvidenceHash}|{outcomeCertificateId:N}|{outcomeCertificateHash}"),
            OutcomeCertificateId = outcomeCertificateId,
            OutcomeCertificateHash = outcomeCertificateHash,
            Stage = OutcomeProviderEvidenceStage.Authoritative
        };
        await providerAuthority.AppendAuthoritativeEvidenceAsync(
            authoritative,
            cancellationToken);
        return authoritative;
    }

    public async Task<OfficialResultReplayResult> VerifyReplayAsync(
        DrawExecutionManifest manifest,
        CancellationToken cancellationToken)
    {
        var stored = await providerAuthority.FindGeneratedEvidenceAsync(
            manifest.ExecutionManifestId,
            cancellationToken);
        if (stored is null)
        {
            return new OfficialResultReplayResult(
                false,
                manifest.ExecutionManifestId,
                string.Empty,
                string.Empty,
                ["Official result provider evidence was not found."]);
        }

        var blockers = new List<string>();
        OfficialResultProviderEvidence? evidence = null;
        try
        {
            evidence = DeserializeEvidence(stored);
        }
        catch (InvalidOperationException error)
        {
            blockers.Add(error.Message);
        }

        if (evidence is not null)
        {
            if (!FixedHashEquals(
                    HashCanonical(evidence.NormalizedResult.CanonicalPayloadJson),
                    stored.ResultHash) ||
                !FixedHashEquals(
                    evidence.NormalizedResult.CanonicalPayloadHash,
                    stored.ResultHash))
            {
                blockers.Add("Official result replay produced a different normalized result hash.");
            }

            var evidenceHash = HashEvidence(evidence with { EvidenceHash = string.Empty });
            if (!FixedHashEquals(evidenceHash, stored.EvidenceHash) ||
                !FixedHashEquals(evidenceHash, evidence.EvidenceHash))
            {
                blockers.Add("Official result replay produced a different evidence hash.");
            }
        }

        return new OfficialResultReplayResult(
            blockers.Count == 0,
            manifest.ExecutionManifestId,
            stored.ResultHash,
            stored.EvidenceHash,
            blockers);
    }

    public async Task<OfficialResultsProviderReadiness> CheckReadinessAsync(
        CancellationToken cancellationToken)
    {
        var source = await sourceRepository.CheckReadinessAsync(cancellationToken);
        var authority = await providerAuthority.CheckReadinessAsync(cancellationToken);
        var officialProviderReady =
            await providerAuthority.IsProviderCategoryProductionReadyAsync(
                CanonicalOutcomeProviderCategory.OfficialResults,
                cancellationToken);
        var blockers = source.Blockers.ToList();
        if (!authority.ProviderEvidencePersistenceReady)
        {
            blockers.Add("Canonical Outcome Provider evidence persistence is unavailable.");
        }

        if (!officialProviderReady)
        {
            blockers.Add("Official Results provider configuration is not production-ready.");
        }

        if (!authority.ProductionActivationDisabled)
        {
            blockers.Add("Official Results provider must remain disabled until governed activation.");
        }

        return new OfficialResultsProviderReadiness(
            true,
            source.SourceRepositoryReady,
            true,
            true,
            true,
            true,
            authority.ProviderEvidencePersistenceReady,
            true,
            true,
            officialProviderReady && blockers.Count == 0,
            authority.ProviderEnabled,
            blockers);
    }

    private static OfficialResultNormalizedPayload Normalize(
        DrawExecutionManifest manifest,
        CanonicalOutcomeProviderRegistration registration,
        GameDefinition definition,
        GameDefinitionVersion definitionVersion,
        OfficialResultIngestionRequest request)
    {
        var rules = definitionVersion.OutcomeGenerationDefinition
            ?? throw new InvalidOperationException(
                "Game Definition version has no immutable official result rules.");
        ValidateNumbers("official", request.OfficialNumbers, rules);
        var officialNumbers = ApplyOrdering(request.OfficialNumbers, rules.Ordering);

        var bonusNumbers = Array.Empty<int>();
        if (rules.BonusNumbers is not null)
        {
            ValidateBonusNumbers(request, rules.BonusNumbers, officialNumbers);
            bonusNumbers = ApplyOrdering(
                request.BonusNumbers,
                rules.BonusNumbers.Ordering);
        }
        else if (request.BonusNumbers.Count > 0)
        {
            throw new InvalidOperationException(
                "Official result supplies bonus numbers but the Game Definition does not allow them.");
        }

        if (!string.Equals(request.GameIdentifier, definition.Code, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Official result game identifier does not match the immutable Game Definition.");
        }

        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["acquisitionMethod"] = request.AcquisitionMethod.ToString(),
            ["bonusNumbers"] = bonusNumbers,
            ["configurationVersion"] = registration.ConfigurationVersion,
            ["drawDateTime"] = request.DrawDateTime,
            ["drawId"] = manifest.DrawId,
            ["executionManifestId"] = manifest.ExecutionManifestId,
            ["gameIdentifier"] = definition.Code,
            ["jurisdiction"] = request.Jurisdiction,
            ["metadata"] = NormalizeValue(request.Metadata),
            ["officialNumbers"] = officialNumbers,
            ["providerId"] = registration.ProviderId,
            ["providerVersion"] = registration.ProviderVersion,
            ["scheduleVersionId"] = manifest.ScheduleVersionId,
            ["sourceId"] = request.SourceId,
            ["sourceVersion"] = request.SourceVersion
        };
        var canonicalJson = JsonSerializer.Serialize(payload, JsonOptions);
        return new OfficialResultNormalizedPayload(
            registration.ProviderId,
            registration.ProviderVersion,
            registration.ConfigurationVersion,
            request.SourceId,
            request.SourceVersion,
            request.AcquisitionMethod,
            request.Jurisdiction,
            definition.Code,
            manifest.DrawId,
            manifest.ScheduleVersionId,
            manifest.ExecutionManifestId,
            request.DrawDateTime,
            officialNumbers,
            bonusNumbers,
            rules.Ordering,
            rules.BonusNumbers?.Ordering,
            (IReadOnlyDictionary<string, object?>)NormalizeValue(request.Metadata)!,
            canonicalJson,
            HashCanonical(canonicalJson));
    }

    private static void ValidateRequestIdentity(
        DrawExecutionManifest manifest,
        OfficialResultIngestionRequest request)
    {
        if (request.RequestId == Guid.Empty ||
            string.IsNullOrWhiteSpace(request.IdempotencyKey) ||
            string.IsNullOrWhiteSpace(request.CorrelationId) ||
            string.IsNullOrWhiteSpace(request.SourceId) ||
            string.IsNullOrWhiteSpace(request.SourceVersion) ||
            string.IsNullOrWhiteSpace(request.GameIdentifier))
        {
            throw new ArgumentException(
                "Official result request, idempotency, correlation, source, and game identifiers are required.");
        }

        if (request.DrawId != manifest.DrawId ||
            request.ScheduleVersionId != manifest.ScheduleVersionId ||
            request.ExecutionManifestId != manifest.ExecutionManifestId ||
            request.DrawDateTime != manifest.ScheduledExecutionAt)
        {
            throw new InvalidOperationException(
                "Official result must match exactly one authoritative Draw Instance, schedule, and Execution Manifest.");
        }

        RequireHash(request.RawPayloadHash, "Raw payload hash");
        RequireHash(request.SourceAuthenticationEvidenceHash, "Source authentication evidence hash");
        RequireHash(request.TransportEvidenceHash, "Transport evidence hash");
    }

    private static void ValidateSource(
        ExternalResultSourceDefinition source,
        OfficialResultIngestionRequest request,
        GameDefinitionVersion definitionVersion)
    {
        var sourceValidation = ExternalOfficialResultValidator.ValidateSource(source);
        if (!sourceValidation.IsValid)
        {
            throw new InvalidOperationException(
                $"Official result source definition is invalid: {string.Join(
                    "; ",
                    sourceValidation.Errors.Select(error => error.Message))}");
        }

        if (!source.ProductionEligible ||
            source.LifecycleState != ExternalResultSourceLifecycleState.Active ||
            source.FailureMode != ExternalResultFailureMode.FailClosed)
        {
            throw new InvalidOperationException(
                "Official result source is not active, production-eligible, and fail-closed.");
        }

        var methodMatches = request.AcquisitionMethod switch
        {
            OfficialResultAcquisitionMethod.OfficialApi =>
                source.SourceType == ExternalResultSourceType.OfficialApi,
            OfficialResultAcquisitionMethod.OfficialFile =>
                source.SourceType == ExternalResultSourceType.SignedFileFeed,
            OfficialResultAcquisitionMethod.OfficialScraper =>
                source.SourceType == ExternalResultSourceType.ApprovedOperatorFeed,
            OfficialResultAcquisitionMethod.ManualImport =>
                source.SourceType == ExternalResultSourceType.ManualRegulatorImport,
            _ => false
        };
        if (!methodMatches)
        {
            throw new InvalidOperationException(
                "Official result acquisition method does not match the approved source definition.");
        }

        if (!source.SupportedGameIdentifiers.Contains(
                request.GameIdentifier,
                StringComparer.Ordinal))
        {
            throw new InvalidOperationException(
                "Official result source is not approved for the requested game.");
        }

        var rules = definitionVersion.OutcomeGenerationDefinition
            ?? throw new InvalidOperationException(
                "Game Definition version has no immutable official result rules.");
        var primarySchema = rules.Unique
            ? ExternalResultSchemaType.UniqueNumberSet
            : ExternalResultSchemaType.OrderedNumberSequence;
        if (!source.SupportedResultSchemas.Contains(primarySchema) ||
            rules.BonusNumbers is not null &&
            !source.SupportedResultSchemas.Contains(
                ExternalResultSchemaType.BonusNumberSet))
        {
            throw new InvalidOperationException(
                "Official result source schema capabilities do not satisfy the immutable Game Definition.");
        }

        if (ExternalOfficialResultValidator.HasForbiddenField(request.Metadata) ||
            ExternalOfficialResultValidator.HasSecretField(request.Metadata))
        {
            throw new InvalidOperationException(
                "Official result metadata cannot contain financial logic or secret material.");
        }

        var now = request.RetrievedAt;
        if (source.PublicationDelayPolicy.FutureTimestampsRejected &&
            request.DrawDateTime > now + source.PublicationDelayPolicy.MaxClockSkew)
        {
            throw new InvalidOperationException(
                "Official result draw timestamp is future-dated beyond source policy.");
        }

        if (source.PublicationDelayPolicy.MaxResultAge is { } maxAge &&
            request.DrawDateTime < now - maxAge)
        {
            throw new InvalidOperationException(
                "Official result draw timestamp is stale under source policy.");
        }
    }

    private static void ValidateNumbers(
        string label,
        IReadOnlyList<int> numbers,
        NumberOutcomeGenerationDefinition rules)
    {
        if (numbers.Count != rules.NumbersRequired)
        {
            throw new InvalidOperationException(
                $"Official result {label} number count does not match the Game Definition.");
        }

        if (numbers.Any(number => !rules.NumberUniverse.Contains(number)))
        {
            throw new InvalidOperationException(
                $"Official result {label} number is outside the Game Definition universe.");
        }

        if ((rules.Unique || !rules.WithReplacement) &&
            numbers.Distinct().Count() != numbers.Count)
        {
            throw new InvalidOperationException(
                $"Official result {label} numbers violate Game Definition uniqueness rules.");
        }
    }

    private static void ValidateBonusNumbers(
        OfficialResultIngestionRequest request,
        BonusNumberOutcomeDefinition rules,
        IReadOnlyList<int> officialNumbers)
    {
        if (request.BonusNumbers.Count != rules.NumbersRequired ||
            request.BonusNumbers.Any(number => !rules.NumberUniverse.Contains(number)))
        {
            throw new InvalidOperationException(
                "Official result bonus numbers do not match the Game Definition count or universe.");
        }

        if ((rules.Unique || !rules.WithReplacement) &&
            request.BonusNumbers.Distinct().Count() != request.BonusNumbers.Count)
        {
            throw new InvalidOperationException(
                "Official result bonus numbers violate Game Definition uniqueness rules.");
        }

        if (!rules.MayOverlapPrimary &&
            request.BonusNumbers.Intersect(officialNumbers).Any())
        {
            throw new InvalidOperationException(
                "Official result bonus numbers cannot overlap primary numbers.");
        }
    }

    private static int[] ApplyOrdering(
        IReadOnlyList<int> numbers,
        OutcomeNumberOrdering ordering) =>
        ordering == OutcomeNumberOrdering.Ascending
            ? numbers.Order().ToArray()
            : numbers.ToArray();

    private static object? NormalizeValue(object? value) =>
        value switch
        {
            null => null,
            JsonElement element => NormalizeJsonElement(element),
            IReadOnlyDictionary<string, object?> dictionary => dictionary
                .OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .ToDictionary(
                    pair => pair.Key,
                    pair => NormalizeValue(pair.Value),
                    StringComparer.Ordinal),
            IDictionary<string, object?> dictionary => dictionary
                .OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .ToDictionary(
                    pair => pair.Key,
                    pair => NormalizeValue(pair.Value),
                    StringComparer.Ordinal),
            IEnumerable<object?> values => values.Select(NormalizeValue).ToArray(),
            _ => value
        };

    private static object? NormalizeJsonElement(JsonElement element) =>
        element.ValueKind switch
        {
            JsonValueKind.Object => element.EnumerateObject()
                .OrderBy(property => property.Name, StringComparer.Ordinal)
                .ToDictionary(
                    property => property.Name,
                    property => NormalizeJsonElement(property.Value),
                    StringComparer.Ordinal),
            JsonValueKind.Array => element.EnumerateArray()
                .Select(NormalizeJsonElement)
                .ToArray(),
            JsonValueKind.String => element.GetString(),
            JsonValueKind.Number when element.TryGetInt64(out var integer) => integer,
            JsonValueKind.Number => element.GetDecimal(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };

    private static bool IsSameOfficialResult(
        OfficialResultProviderEvidence evidence,
        OfficialResultIngestionRequest request) =>
        evidence.SourceId == request.SourceId &&
        evidence.SourceVersion == request.SourceVersion &&
        evidence.NormalizedResult.DrawId == request.DrawId &&
        evidence.NormalizedResult.OfficialNumbers.SequenceEqual(
            ApplyOrdering(
                request.OfficialNumbers,
                evidence.NormalizedResult.NumberOrdering)) &&
        evidence.NormalizedResult.BonusNumbers.SequenceEqual(
            ApplyOrdering(
                request.BonusNumbers,
                evidence.NormalizedResult.BonusNumberOrdering ??
                    OutcomeNumberOrdering.DrawOrder));

    private static OfficialResultProviderEvidence DeserializeEvidence(
        OutcomeProviderExecutionEvidence evidence) =>
        JsonSerializer.Deserialize<OfficialResultProviderEvidence>(
            evidence.ProviderEvidenceJson,
            JsonOptions)
        ?? throw new InvalidOperationException(
            "Stored Official Results provider evidence is invalid.");

    private static OfficialResultIngestionResult RestoreResult(
        OutcomeProviderExecutionEvidence stored,
        OfficialResultProviderEvidence evidence,
        bool duplicate) =>
        new(
            stored.ExecutionId,
            stored.EvidenceId,
            stored.ExecutionManifestId,
            stored.DrawId,
            stored.IdempotencyKey,
            stored.RequestHash,
            evidence.NormalizedResult,
            evidence,
            duplicate,
            evidence.ExecutionVersion > 1);

    private static OutcomeProviderExecutionAttempt CompletedAttempt(
        OutcomeProviderExecutionClaim claim,
        int attemptNumber,
        string requestHash,
        DateTimeOffset startedAt,
        DateTimeOffset completedAt) =>
        new(
            Guid.NewGuid(),
            claim.ExecutionId,
            attemptNumber,
            OutcomeProviderExecutionStatus.Completed,
            OutcomeProviderFailureClassification.None,
            null,
            null,
            requestHash,
            HashCanonical(
                $"{claim.ExecutionId:N}|{attemptNumber}|COMPLETED|{requestHash}|{completedAt:O}"),
            startedAt,
            completedAt);

    private static OutcomeProviderExecutionAttempt FailedAttempt(
        OutcomeProviderExecutionClaim claim,
        int attemptNumber,
        string requestHash,
        Exception error,
        DateTimeOffset startedAt,
        DateTimeOffset completedAt) =>
        new(
            Guid.NewGuid(),
            claim.ExecutionId,
            attemptNumber,
            OutcomeProviderExecutionStatus.NonRetryableFailure,
            OutcomeProviderFailureClassification.NonRetryable,
            error.GetType().Name,
            error.Message,
            requestHash,
            HashCanonical(
                $"{claim.ExecutionId:N}|{attemptNumber}|FAILED|{requestHash}|{error.GetType().Name}|{completedAt:O}"),
            startedAt,
            completedAt);

    private static OutcomeProviderExecutionEvidence ToAuthorityEvidence(
        DrawExecutionManifest manifest,
        OutcomeProviderExecutionClaim claim,
        OfficialResultProviderEvidence evidence,
        OutcomeProviderExecutionAttempt attempt) =>
        new(
            Guid.NewGuid(),
            claim.ExecutionId,
            manifest.ExecutionManifestId,
            manifest.DrawId,
            claim.ProviderId,
            claim.ProviderVersion,
            claim.ConfigurationVersion,
            claim.CanonicalRequestHash,
            evidence.NormalizedPayloadHash,
            evidence.EvidenceHash,
            null,
            null,
            attempt.AttemptNumber,
            claim.IdempotencyKey,
            OutcomeProviderEvidenceStage.Generated,
            JsonSerializer.Serialize(evidence, JsonOptions),
            attempt.StartedAt,
            evidence.CompletedAt);

    private static string HashEvidence(OfficialResultProviderEvidence evidence) =>
        HashCanonical(JsonSerializer.Serialize(
            new
            {
                evidence.RequestId,
                evidence.ExecutionId,
                evidence.ExecutionVersion,
                evidence.SupersedesExecutionId,
                evidence.SupersedesEvidenceId,
                evidence.CorrectionReason,
                evidence.ProviderId,
                evidence.ProviderVersion,
                evidence.ConfigurationVersion,
                evidence.SourceId,
                evidence.SourceVersion,
                evidence.AcquisitionMethod,
                evidence.RetrievedAt,
                evidence.NormalizationVersion,
                evidence.ValidationPassed,
                evidence.RawPayloadHash,
                evidence.NormalizedPayloadHash,
                evidence.SourceAuthenticationEvidenceHash,
                evidence.TransportEvidenceHash,
                evidence.ReplayIdentifier,
                evidence.CanonicalRequestHash,
                evidence.NormalizedResult,
                evidence.CompletedAt
            },
            JsonOptions));

    private static string HashCanonical(string value) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";

    private static bool FixedHashEquals(string first, string second)
    {
        var firstBytes = Encoding.UTF8.GetBytes(first);
        var secondBytes = Encoding.UTF8.GetBytes(second);
        try
        {
            return firstBytes.Length == secondBytes.Length &&
                CryptographicOperations.FixedTimeEquals(firstBytes, secondBytes);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(firstBytes);
            CryptographicOperations.ZeroMemory(secondBytes);
        }
    }

    private static void RequireHash(string? value, string name)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            !value.StartsWith("sha256:", StringComparison.Ordinal))
        {
            throw new ArgumentException($"{name} must be a canonical sha256 hash.");
        }
    }
}
