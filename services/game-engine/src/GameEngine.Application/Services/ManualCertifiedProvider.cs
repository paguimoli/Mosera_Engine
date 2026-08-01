using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using GameEngine.Application.Interfaces;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class ManualCertifiedProvider(
    CanonicalOutcomeProviderAuthority providerAuthority,
    IGameDefinitionRepository gameDefinitions,
    IGameDefinitionVersionRepository gameDefinitionVersions)
{
    private const string NormalizationVersion = "1.0.0";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter() }
    };

    public async Task<ManualCertifiedSubmissionResult> SubmitAsync(
        DrawExecutionManifest manifest,
        ManualCertifiedSubmissionRequest request,
        CancellationToken cancellationToken)
    {
        ValidateRequestIdentity(manifest, request);
        var registration = await providerAuthority.ResolveAsync(manifest, cancellationToken);
        if (registration.ProviderCategory != CanonicalOutcomeProviderCategory.ManualCertified)
        {
            throw new InvalidOperationException(
                "Manual certified submission requires a MANUAL_CERTIFIED provider binding.");
        }

        var requestHash = HashCanonical(CanonicalizeRequest(request));
        var existing = await providerAuthority.FindGeneratedEvidenceAsync(
            manifest.ExecutionManifestId,
            cancellationToken);
        if (existing is not null)
        {
            var existingEvidence = DeserializeEvidence(existing);
            if (FixedHashEquals(existingEvidence.CanonicalRequestHash, requestHash))
            {
                return RestoreResult(existing, existingEvidence, duplicate: true);
            }

            if (request.SupersedesEvidenceId != existing.EvidenceId)
            {
                throw new InvalidOperationException(
                    "Conflicting manual certified submission requires explicit supersession of the current provider evidence.");
            }

            if (string.IsNullOrWhiteSpace(request.CorrectionReason))
            {
                throw new InvalidOperationException(
                    "Manual certified supersession requires a correction reason.");
            }
        }
        else if (request.SupersedesEvidenceId is not null)
        {
            throw new InvalidOperationException(
                "Manual certified supersession cannot reference missing provider evidence.");
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
            if (completed is not null && completed.ExecutionId == claim.Claim.ExecutionId)
            {
                return RestoreResult(completed, DeserializeEvidence(completed), duplicate: true);
            }
        }

        var attemptNumber = await providerAuthority.GetNextAttemptNumberAsync(
            claim.Claim.ExecutionId,
            cancellationToken);
        var startedAt = DateTimeOffset.UtcNow;
        try
        {
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
            var normalized = Normalize(
                manifest,
                registration,
                definition,
                definitionVersion,
                request);
            var completedAt = DateTimeOffset.UtcNow;
            var evidenceWithoutHash = new ManualCertifiedProviderEvidence(
                request.RequestId,
                claim.Claim.ExecutionId,
                claim.Claim.ExecutionVersion,
                claim.Claim.SupersedesExecutionId,
                request.SupersedesEvidenceId,
                request.CorrectionReason,
                registration.ProviderId,
                registration.ProviderVersion,
                registration.ConfigurationVersion,
                request.OperatorIdentityReference,
                request.CertificationReference,
                request.ReasonCode,
                request.SubmittedAt,
                request.SubmissionEvidenceHash,
                normalized.CanonicalPayloadHash,
                $"manual-certified:{manifest.DrawId:N}:v{claim.Claim.ExecutionVersion}",
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
                definitionVersion,
                claim.Claim,
                evidence,
                attempt);
            await providerAuthority.CompleteGeneratedExecutionAsync(
                attempt,
                authorityEvidence,
                cancellationToken);
            return new ManualCertifiedSubmissionResult(
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
                "Manual Certified provider failed closed.",
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
                "Outcome Certificate binding requires persisted manual certified evidence.");
        if (!FixedHashEquals(generated.ResultHash, outcomeCertificateHash))
        {
            throw new InvalidOperationException(
                "Outcome Certificate hash does not match the certified manual result.");
        }

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

    public async Task<ManualCertifiedReplayResult> VerifyReplayAsync(
        DrawExecutionManifest manifest,
        CancellationToken cancellationToken)
    {
        var stored = await providerAuthority.FindGeneratedEvidenceAsync(
            manifest.ExecutionManifestId,
            cancellationToken);
        if (stored is null)
        {
            return new ManualCertifiedReplayResult(
                false,
                manifest.ExecutionManifestId,
                string.Empty,
                string.Empty,
                ["Manual certified provider evidence was not found."]);
        }

        var blockers = new List<string>();
        ManualCertifiedProviderEvidence? evidence = null;
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
                blockers.Add("Manual certified replay produced a different normalized result hash.");
            }

            var evidenceHash = HashEvidence(evidence with { EvidenceHash = string.Empty });
            if (!FixedHashEquals(evidenceHash, stored.EvidenceHash) ||
                !FixedHashEquals(evidenceHash, evidence.EvidenceHash))
            {
                blockers.Add("Manual certified replay produced a different evidence hash.");
            }
        }

        return new ManualCertifiedReplayResult(
            blockers.Count == 0,
            manifest.ExecutionManifestId,
            stored.ResultHash,
            stored.EvidenceHash,
            blockers);
    }

    public async Task<ManualCertifiedProviderReadiness> CheckReadinessAsync(
        CancellationToken cancellationToken)
    {
        var authority = await providerAuthority.CheckReadinessAsync(cancellationToken);
        var categoryReady = await providerAuthority.IsProviderCategoryProductionReadyAsync(
            CanonicalOutcomeProviderCategory.ManualCertified,
            cancellationToken);
        var blockers = new List<string>();
        if (!authority.ProviderEvidencePersistenceReady)
        {
            blockers.Add("Canonical Outcome Provider evidence persistence is unavailable.");
        }

        if (!categoryReady)
        {
            blockers.Add("Manual Certified provider configuration is not production-ready.");
        }

        return new ManualCertifiedProviderReadiness(
            true,
            true,
            true,
            true,
            authority.ProviderEvidencePersistenceReady,
            true,
            true,
            true,
            true,
            categoryReady && blockers.Count == 0,
            authority.ProviderEnabled,
            blockers);
    }

    private static ManualCertifiedNormalizedPayload Normalize(
        DrawExecutionManifest manifest,
        CanonicalOutcomeProviderRegistration registration,
        GameDefinition definition,
        GameDefinitionVersion definitionVersion,
        ManualCertifiedSubmissionRequest request)
    {
        var rules = definitionVersion.OutcomeGenerationDefinition
            ?? throw new InvalidOperationException(
                "Game Definition version has no immutable certified result rules.");
        ValidateNumbers("primary", request.CertifiedNumbers, rules);
        var certifiedNumbers = ApplyOrdering(request.CertifiedNumbers, rules.Ordering);

        var bonusNumbers = Array.Empty<int>();
        if (rules.BonusNumbers is not null)
        {
            ValidateBonusNumbers(request.BonusNumbers, rules.BonusNumbers, certifiedNumbers);
            bonusNumbers = ApplyOrdering(request.BonusNumbers, rules.BonusNumbers.Ordering);
        }
        else if (request.BonusNumbers.Count > 0)
        {
            throw new InvalidOperationException(
                "Manual submission supplies bonus numbers but the Game Definition does not allow them.");
        }

        if (!string.Equals(request.GameIdentifier, definition.Code, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Manual submission game identifier does not match the immutable Game Definition.");
        }

        if (ExternalOfficialResultValidator.HasForbiddenField(request.ProviderMetadata) ||
            ExternalOfficialResultValidator.HasSecretField(request.ProviderMetadata))
        {
            throw new InvalidOperationException(
                "Manual provider metadata cannot contain financial logic or secret material.");
        }

        var normalizedMetadata = (IReadOnlyDictionary<string, object?>)NormalizeValue(
            request.ProviderMetadata)!;
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["bonusNumbers"] = bonusNumbers,
            ["certificationReference"] = request.CertificationReference,
            ["certifiedNumbers"] = certifiedNumbers,
            ["configurationVersion"] = registration.ConfigurationVersion,
            ["drawDateTime"] = request.DrawDateTime,
            ["drawId"] = manifest.DrawId,
            ["executionManifestId"] = manifest.ExecutionManifestId,
            ["gameIdentifier"] = definition.Code,
            ["officialDrawIdentifier"] = request.OfficialDrawIdentifier,
            ["operatorIdentityReference"] = request.OperatorIdentityReference,
            ["providerId"] = registration.ProviderId,
            ["providerMetadata"] = normalizedMetadata,
            ["providerVersion"] = registration.ProviderVersion,
            ["reasonCode"] = request.ReasonCode,
            ["scheduleVersionId"] = manifest.ScheduleVersionId
        };
        var canonicalJson = JsonSerializer.Serialize(payload, JsonOptions);
        return new ManualCertifiedNormalizedPayload(
            registration.ProviderId,
            registration.ProviderVersion,
            registration.ConfigurationVersion,
            request.OfficialDrawIdentifier,
            definition.Code,
            manifest.DrawId,
            manifest.ScheduleVersionId,
            manifest.ExecutionManifestId,
            request.DrawDateTime,
            certifiedNumbers,
            bonusNumbers,
            rules.Ordering,
            rules.BonusNumbers?.Ordering,
            normalizedMetadata,
            request.CertificationReference,
            request.OperatorIdentityReference,
            request.ReasonCode,
            canonicalJson,
            HashCanonical(canonicalJson));
    }

    private static void ValidateRequestIdentity(
        DrawExecutionManifest manifest,
        ManualCertifiedSubmissionRequest request)
    {
        if (request.RequestId == Guid.Empty ||
            string.IsNullOrWhiteSpace(request.IdempotencyKey) ||
            string.IsNullOrWhiteSpace(request.CorrelationId) ||
            string.IsNullOrWhiteSpace(request.OfficialDrawIdentifier) ||
            string.IsNullOrWhiteSpace(request.GameIdentifier) ||
            string.IsNullOrWhiteSpace(request.CertificationReference) ||
            string.IsNullOrWhiteSpace(request.OperatorIdentityReference) ||
            string.IsNullOrWhiteSpace(request.ReasonCode))
        {
            throw new ArgumentException(
                "Manual request, idempotency, correlation, draw, game, certification, operator, and reason references are required.");
        }

        if (request.DrawId != manifest.DrawId ||
            request.ScheduleVersionId != manifest.ScheduleVersionId ||
            request.ExecutionManifestId != manifest.ExecutionManifestId ||
            request.DrawDateTime != manifest.ScheduledExecutionAt)
        {
            throw new InvalidOperationException(
                "Manual certified submission must match exactly one Draw Instance, schedule, and Execution Manifest.");
        }

        if (request.SubmittedAt < request.DrawDateTime)
        {
            throw new InvalidOperationException(
                "Manual certified submission cannot predate the authoritative draw.");
        }

        RequireHash(request.SubmissionEvidenceHash, "Submission evidence hash");
    }

    private static void ValidateNumbers(
        string label,
        IReadOnlyList<int> numbers,
        NumberOutcomeGenerationDefinition rules)
    {
        if (numbers.Count != rules.NumbersRequired)
        {
            throw new InvalidOperationException(
                $"Manual certified {label} number count does not match the Game Definition.");
        }

        if (numbers.Any(number => !rules.NumberUniverse.Contains(number)))
        {
            throw new InvalidOperationException(
                $"Manual certified {label} number is outside the Game Definition universe.");
        }

        if ((rules.Unique || !rules.WithReplacement) &&
            numbers.Distinct().Count() != numbers.Count)
        {
            throw new InvalidOperationException(
                $"Manual certified {label} numbers violate Game Definition uniqueness rules.");
        }
    }

    private static void ValidateBonusNumbers(
        IReadOnlyList<int> bonusNumbers,
        BonusNumberOutcomeDefinition rules,
        IReadOnlyList<int> certifiedNumbers)
    {
        if (bonusNumbers.Count != rules.NumbersRequired ||
            bonusNumbers.Any(number => !rules.NumberUniverse.Contains(number)))
        {
            throw new InvalidOperationException(
                "Manual certified bonus numbers do not match the Game Definition count or universe.");
        }

        if ((rules.Unique || !rules.WithReplacement) &&
            bonusNumbers.Distinct().Count() != bonusNumbers.Count)
        {
            throw new InvalidOperationException(
                "Manual certified bonus numbers violate Game Definition uniqueness rules.");
        }

        if (!rules.MayOverlapPrimary && bonusNumbers.Intersect(certifiedNumbers).Any())
        {
            throw new InvalidOperationException(
                "Manual certified bonus numbers cannot overlap primary numbers.");
        }
    }

    private static int[] ApplyOrdering(
        IReadOnlyList<int> numbers,
        OutcomeNumberOrdering ordering) =>
        ordering == OutcomeNumberOrdering.Ascending
            ? numbers.Order().ToArray()
            : numbers.ToArray();

    private static string CanonicalizeRequest(ManualCertifiedSubmissionRequest request) =>
        JsonSerializer.Serialize(new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["bonusNumbers"] = request.BonusNumbers,
            ["certificationReference"] = request.CertificationReference,
            ["certifiedNumbers"] = request.CertifiedNumbers,
            ["correlationId"] = request.CorrelationId,
            ["correctionReason"] = request.CorrectionReason,
            ["drawDateTime"] = request.DrawDateTime,
            ["drawId"] = request.DrawId,
            ["executionManifestId"] = request.ExecutionManifestId,
            ["gameIdentifier"] = request.GameIdentifier,
            ["idempotencyKey"] = request.IdempotencyKey,
            ["officialDrawIdentifier"] = request.OfficialDrawIdentifier,
            ["operatorIdentityReference"] = request.OperatorIdentityReference,
            ["providerMetadata"] = NormalizeValue(request.ProviderMetadata),
            ["reasonCode"] = request.ReasonCode,
            ["requestId"] = request.RequestId,
            ["scheduleVersionId"] = request.ScheduleVersionId,
            ["submissionEvidenceHash"] = request.SubmissionEvidenceHash,
            ["submittedAt"] = request.SubmittedAt,
            ["supersedesEvidenceId"] = request.SupersedesEvidenceId
        }, JsonOptions);

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

    private static ManualCertifiedProviderEvidence DeserializeEvidence(
        OutcomeProviderExecutionEvidence evidence) =>
        JsonSerializer.Deserialize<ManualCertifiedProviderEvidence>(
            evidence.ProviderEvidenceJson,
            JsonOptions)
        ?? throw new InvalidOperationException(
            "Stored Manual Certified provider evidence is invalid.");

    private static ManualCertifiedSubmissionResult RestoreResult(
        OutcomeProviderExecutionEvidence stored,
        ManualCertifiedProviderEvidence evidence,
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
        GameDefinitionVersion definitionVersion,
        OutcomeProviderExecutionClaim claim,
        ManualCertifiedProviderEvidence evidence,
        OutcomeProviderExecutionAttempt attempt)
    {
        var canonical = CanonicalProviderOutcomeFactory.Create(
            manifest,
            definitionVersion,
            evidence.NormalizedResult.CertifiedNumbers,
            evidence.NormalizedResult.BonusNumbers,
            evidence.NormalizedResult.NumberOrdering,
            evidence.NormalizedResult.BonusNumberOrdering,
            null,
            evidence.NormalizedPayloadHash);
        return new(
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
            evidence.CompletedAt,
            canonical.Json,
            canonical.Hash);
    }

    private static string HashEvidence(ManualCertifiedProviderEvidence evidence) =>
        HashCanonical(JsonSerializer.Serialize(new
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
            evidence.OperatorIdentityReference,
            evidence.CertificationReference,
            evidence.ReasonCode,
            evidence.SubmissionTimestamp,
            evidence.SubmissionEvidenceHash,
            evidence.NormalizedPayloadHash,
            evidence.ReplayIdentifier,
            evidence.CanonicalRequestHash,
            evidence.NormalizedResult,
            evidence.CompletedAt
        }, JsonOptions));

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
