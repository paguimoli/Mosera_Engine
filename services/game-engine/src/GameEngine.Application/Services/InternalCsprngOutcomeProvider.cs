using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using GameEngine.Application.Interfaces;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class InternalCsprngOutcomeProvider(
    CanonicalOutcomeProviderAuthority providerAuthority,
    IGameDefinitionVersionRepository gameDefinitions,
    IOsEntropyProvider entropyProvider,
    IHmacDrbgRuntime drbgRuntime,
    ICertifiedCsprngSampler sampler)
{
    private const int SecurityStrengthBits = 256;
    private const int EntropyBytes = 48;
    private const int NonceBytes = 32;
    private static readonly JsonSerializerOptions CanonicalJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter() }
    };

    public async Task<InternalCsprngGenerationResult> GenerateAsync(
        DrawExecutionManifest manifest,
        InternalCsprngExecutionRequest request,
        CancellationToken cancellationToken)
    {
        ValidateRequest(request);
        var registration = await providerAuthority.ResolveAsync(manifest, cancellationToken);
        if (registration.ProviderCategory != CanonicalOutcomeProviderCategory.InternalCsprng)
        {
            throw new InvalidOperationException(
                "Internal CSPRNG execution requires an INTERNAL_CSPRNG provider binding.");
        }

        var definitionVersion = await gameDefinitions.GetAsync(
            manifest.GameDefinitionVersionId,
            cancellationToken)
            ?? throw new InvalidOperationException(
                "Execution Manifest references an unknown Game Definition version.");
        var generationDefinition = definitionVersion.OutcomeGenerationDefinition
            ?? throw new InvalidOperationException(
                "Game Definition version has no immutable outcome generation definition.");
        ValidateGenerationDefinition(generationDefinition);

        var requestHash = HashCanonical(JsonSerializer.Serialize(
            new
            {
                request.RequestId,
                request.IdempotencyKey,
                request.CorrelationId,
                manifest.ExecutionManifestId,
                manifest.DrawId,
                manifest.CanonicalManifestHash,
                manifest.GameDefinitionVersionId,
                definitionVersion.DefinitionHash,
                manifest.OutcomeProviderId,
                manifest.OutcomeProviderVersion,
                manifest.ProviderConfigurationVersion,
                generationDefinition
            },
            CanonicalJsonOptions));
        var claim = await providerAuthority.ClaimExecutionAsync(
            manifest,
            request.IdempotencyKey,
            requestHash,
            cancellationToken);

        if (claim.Duplicate)
        {
            var existing = await providerAuthority.FindGeneratedEvidenceAsync(
                manifest.ExecutionManifestId,
                cancellationToken);
            if (existing is null)
            {
                throw new InvalidOperationException(
                    "The Outcome Provider execution is already claimed and has no completed result evidence.");
            }

            return RestoreResult(manifest, existing, duplicate: true);
        }

        var startedAt = DateTimeOffset.UtcNow;
        var startTimestamp = Stopwatch.GetTimestamp();
        try
        {
            var health = BuildHealthEvidence();
            if (health.Blockers.Count > 0)
            {
                throw new CryptographicException(string.Join("; ", health.Blockers));
            }

            var generated = Generate(
                manifest,
                registration,
                request,
                generationDefinition,
                startedAt,
                startTimestamp,
                health) with
            {
                ExecutionId = claim.Claim.ExecutionId,
                CanonicalRequestHash = requestHash
            };
            var attempt = CompletedAttempt(
                claim.Claim,
                requestHash,
                generated.Evidence.CompletedAt);
            await providerAuthority.CompleteGeneratedExecutionAsync(
                attempt,
                ToGeneratedAuthorityEvidence(
                    manifest,
                    definitionVersion,
                    generationDefinition,
                    claim.Claim,
                    generated,
                    attempt),
                cancellationToken);
            return generated;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            var completedAt = DateTimeOffset.UtcNow;
            await providerAuthority.AppendAttemptAsync(
                FailedAttempt(claim.Claim, requestHash, error, startedAt, completedAt),
                cancellationToken);
            throw new InvalidOperationException(
                "Internal CSPRNG provider failed closed.",
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
                "Outcome Certificate binding requires persisted generated provider evidence.");
        if (!FixedHashEquals(generated.ResultHash, outcomeCertificateHash))
        {
            throw new InvalidOperationException(
                "Outcome Certificate hash does not match the generated Internal CSPRNG result.");
        }
        var bindingHash = HashCanonical(
            $"{generated.EvidenceHash}|{outcomeCertificateId:N}|{outcomeCertificateHash}");
        var authoritative = generated with
        {
            EvidenceId = Guid.NewGuid(),
            EvidenceHash = bindingHash,
            OutcomeCertificateId = outcomeCertificateId,
            OutcomeCertificateHash = outcomeCertificateHash,
            Stage = OutcomeProviderEvidenceStage.Authoritative
        };
        await providerAuthority.AppendAuthoritativeEvidenceAsync(
            authoritative,
            cancellationToken);
        return authoritative;
    }

    public async Task<InternalCsprngReplayResult> VerifyReplayAsync(
        DrawExecutionManifest manifest,
        CancellationToken cancellationToken)
    {
        var stored = await providerAuthority.FindGeneratedEvidenceAsync(
            manifest.ExecutionManifestId,
            cancellationToken);
        if (stored is null)
        {
            return new InternalCsprngReplayResult(
                false,
                manifest.ExecutionManifestId,
                string.Empty,
                string.Empty,
                ["Generated provider evidence was not found."]);
        }

        var blockers = new List<string>();
        InternalCsprngExecutionEvidence? evidence = null;
        try
        {
            evidence = JsonSerializer.Deserialize<InternalCsprngExecutionEvidence>(
                stored.ProviderEvidenceJson,
                CanonicalJsonOptions);
        }
        catch (JsonException error)
        {
            blockers.Add($"Provider evidence JSON is invalid: {error.Message}");
        }

        if (evidence is null)
        {
            blockers.Add("Provider evidence payload is unavailable.");
        }
        else
        {
            var outcomeJson = CanonicalOutcome(
                manifest,
                evidence.GeneratedNumbers,
                evidence.Health.States.Contains(InternalCsprngHealthState.ExecutionSucceeded));
            var resultHash = HashCanonical(outcomeJson);
            var evidenceHash = HashEvidence(evidence with { EvidenceHash = string.Empty });
            if (!FixedHashEquals(resultHash, stored.ResultHash))
            {
                blockers.Add("Replayed canonical outcome hash does not match persisted result evidence.");
            }

            if (!FixedHashEquals(evidenceHash, stored.EvidenceHash) ||
                !FixedHashEquals(evidenceHash, evidence.EvidenceHash))
            {
                blockers.Add("Replayed provider evidence hash does not match persisted evidence.");
            }
        }

        return new InternalCsprngReplayResult(
            blockers.Count == 0,
            manifest.ExecutionManifestId,
            stored.ResultHash,
            stored.EvidenceHash,
            blockers);
    }

    public async Task<InternalCsprngReadiness> CheckReadinessAsync(
        CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        var entropy = entropyProvider.CheckReadiness();
        var drbg = drbgRuntime.RunHealthChecks();
        var authority = await providerAuthority.CheckReadinessAsync(cancellationToken);
        if (!entropy.Ready)
        {
            blockers.AddRange(entropy.Blockers);
        }

        if (!drbg.IsReady)
        {
            blockers.AddRange(drbg.Blockers);
        }

        if (!authority.ProviderEvidencePersistenceReady)
        {
            blockers.Add("Canonical Outcome Provider evidence persistence is unavailable.");
        }

        if (!authority.ProviderProductionReady)
        {
            blockers.Add("Internal CSPRNG provider configuration is not production-ready.");
        }

        return new InternalCsprngReadiness(
            ProviderImplementationReady: true,
            OperatingSystemEntropyReady: entropy.Ready,
            StartupSelfTestPassed: drbg.StartupSelfTestPassed,
            KnownAnswerTestsPassed: drbg.KnownAnswerResults.All(result => result.Passed),
            ContinuousTestReady: drbg.ContinuousTestReady,
            GameDefinitionDrivenGenerationReady: true,
            CanonicalEvidencePersistenceReady: authority.ProviderEvidencePersistenceReady,
            ProductionReady: blockers.Count == 0,
            ProductionActive: authority.ProviderEnabled,
            Blockers: blockers);
    }

    private InternalCsprngGenerationResult Generate(
        DrawExecutionManifest manifest,
        CanonicalOutcomeProviderRegistration registration,
        InternalCsprngExecutionRequest request,
        NumberOutcomeGenerationDefinition definition,
        DateTimeOffset startedAt,
        long startTimestamp,
        InternalCsprngHealthEvidence initialHealth)
    {
        var entropy = new byte[EntropyBytes];
        var nonce = new byte[NonceBytes];
        var reseedEntropy = new byte[EntropyBytes];
        var personalization = Encoding.UTF8.GetBytes(
            $"{manifest.ExecutionManifestId:N}|{manifest.CanonicalManifestHash}|{request.RequestId:N}");
        HmacDrbgSession? session = null;
        try
        {
            entropyProvider.Fill(entropy);
            entropyProvider.Fill(nonce);
            entropyProvider.Fill(reseedEntropy);
            var seedIdentifier = $"seed:{HashMaterial(entropy, nonce, personalization)}";
            session = drbgRuntime.Instantiate(
                CertifiedCsprngHashAlgorithm.Sha256,
                entropy,
                nonce,
                personalization,
                SecurityStrengthBits);
            drbgRuntime.Reseed(session, reseedEntropy, personalization);
            var numbers = sampler.SelectNumbers(
                session,
                definition.NumberUniverse,
                definition.NumbersRequired,
                definition.Unique,
                definition.WithReplacement,
                definition.Ordering);
            var completedAt = DateTimeOffset.UtcNow;
            var states = initialHealth.States
                .Concat([
                    InternalCsprngHealthState.EntropyAcquired,
                    InternalCsprngHealthState.Seeded,
                    InternalCsprngHealthState.Ready,
                    InternalCsprngHealthState.Reseeded,
                    InternalCsprngHealthState.ExecutionSucceeded
                ])
                .Distinct()
                .ToArray();
            var health = initialHealth with { States = states };
            var outcomeJson = CanonicalOutcome(manifest, numbers, executionSucceeded: true);
            var outcomeHash = HashCanonical(outcomeJson);
            var evidenceWithoutHash = new InternalCsprngExecutionEvidence(
                $"os:{entropyProvider.Platform}",
                registration.ProviderVersion,
                registration.ConfigurationVersion,
                Guid.NewGuid(),
                seedIdentifier,
                session.ReseedCounter,
                request.RequestId,
                session.GetGeneratedBytesHash(),
                session.GeneratedByteCount,
                numbers,
                startedAt,
                completedAt,
                checked((long)(Stopwatch.GetElapsedTime(startTimestamp).TotalMilliseconds * 1000)),
                health,
                string.Empty);
            var evidence = evidenceWithoutHash with
            {
                EvidenceHash = HashEvidence(evidenceWithoutHash)
            };
            return new InternalCsprngGenerationResult(
                Guid.Empty,
                manifest.ExecutionManifestId,
                manifest.DrawId,
                request.IdempotencyKey,
                string.Empty,
                outcomeJson,
                outcomeHash,
                evidence,
                Duplicate: false);
        }
        finally
        {
            if (session is not null)
            {
                drbgRuntime.Destroy(session);
            }

            CryptographicOperations.ZeroMemory(entropy);
            CryptographicOperations.ZeroMemory(nonce);
            CryptographicOperations.ZeroMemory(reseedEntropy);
            CryptographicOperations.ZeroMemory(personalization);
        }
    }

    private InternalCsprngHealthEvidence BuildHealthEvidence()
    {
        var entropy = entropyProvider.CheckReadiness();
        var drbg = drbgRuntime.RunHealthChecks();
        return new InternalCsprngHealthEvidence(
            drbg.StartupSelfTestPassed,
            drbg.KnownAnswerResults.All(result => result.Passed),
            drbg.ContinuousTestReady,
            [InternalCsprngHealthState.Instantiated],
            entropy.Blockers.Concat(drbg.Blockers).ToArray());
    }

    private static InternalCsprngGenerationResult RestoreResult(
        DrawExecutionManifest manifest,
        OutcomeProviderExecutionEvidence stored,
        bool duplicate)
    {
        var evidence = JsonSerializer.Deserialize<InternalCsprngExecutionEvidence>(
            stored.ProviderEvidenceJson,
            CanonicalJsonOptions)
            ?? throw new InvalidOperationException("Stored Internal CSPRNG evidence is invalid.");
        var outcomeJson = CanonicalOutcome(
            manifest,
            evidence.GeneratedNumbers,
            executionSucceeded: true);
        if (!FixedHashEquals(HashCanonical(outcomeJson), stored.ResultHash))
        {
            throw new InvalidOperationException(
                "Stored Internal CSPRNG result evidence failed deterministic replay validation.");
        }

        return new InternalCsprngGenerationResult(
            stored.ExecutionId,
            stored.ExecutionManifestId,
            stored.DrawId,
            stored.IdempotencyKey,
            stored.RequestHash,
            outcomeJson,
            stored.ResultHash,
            evidence,
            duplicate);
    }

    private static OutcomeProviderExecutionAttempt CompletedAttempt(
        OutcomeProviderExecutionClaim claim,
        string requestHash,
        DateTimeOffset completedAt) =>
        new(
            Guid.NewGuid(),
            claim.ExecutionId,
            1,
            OutcomeProviderExecutionStatus.Completed,
            OutcomeProviderFailureClassification.None,
            null,
            null,
            requestHash,
            HashCanonical(
                $"{claim.ExecutionId:N}|1|COMPLETED|{requestHash}|{completedAt:O}"),
            claim.ClaimedAt,
            completedAt);

    private static OutcomeProviderExecutionAttempt FailedAttempt(
        OutcomeProviderExecutionClaim claim,
        string requestHash,
        Exception error,
        DateTimeOffset startedAt,
        DateTimeOffset completedAt) =>
        new(
            Guid.NewGuid(),
            claim.ExecutionId,
            1,
            OutcomeProviderExecutionStatus.NonRetryableFailure,
            OutcomeProviderFailureClassification.NonRetryable,
            error.GetType().Name,
            error.Message,
            requestHash,
            HashCanonical(
                $"{claim.ExecutionId:N}|1|FAILED|{requestHash}|{error.GetType().Name}|{completedAt:O}"),
            startedAt,
            completedAt);

    private static OutcomeProviderExecutionEvidence ToGeneratedAuthorityEvidence(
        DrawExecutionManifest manifest,
        GameDefinitionVersion definitionVersion,
        NumberOutcomeGenerationDefinition generationDefinition,
        OutcomeProviderExecutionClaim claim,
        InternalCsprngGenerationResult result,
        OutcomeProviderExecutionAttempt attempt)
    {
        var canonical = CanonicalProviderOutcomeFactory.Create(
            manifest,
            definitionVersion,
            result.Evidence.GeneratedNumbers,
            [],
            generationDefinition.Ordering,
            null,
            null,
            result.CanonicalOutcomeHash);
        return new(
            Guid.NewGuid(),
            claim.ExecutionId,
            manifest.ExecutionManifestId,
            manifest.DrawId,
            claim.ProviderId,
            claim.ProviderVersion,
            claim.ConfigurationVersion,
            claim.CanonicalRequestHash,
            result.CanonicalOutcomeHash,
            result.Evidence.EvidenceHash,
            null,
            null,
            attempt.AttemptNumber,
            claim.IdempotencyKey,
            OutcomeProviderEvidenceStage.Generated,
            JsonSerializer.Serialize(result.Evidence, CanonicalJsonOptions),
            result.Evidence.StartedAt,
            result.Evidence.CompletedAt,
            canonical.Json,
            canonical.Hash);
    }

    private static string CanonicalOutcome(
        DrawExecutionManifest manifest,
        IReadOnlyList<int> numbers,
        bool executionSucceeded) =>
        JsonSerializer.Serialize(
            new
            {
                manifest.DrawId,
                manifest.ExecutionManifestId,
                manifest.GameDefinitionVersionId,
                Numbers = numbers,
                ExecutionSucceeded = executionSucceeded
            },
            CanonicalJsonOptions);

    private static string HashEvidence(InternalCsprngExecutionEvidence evidence) =>
        HashCanonical(JsonSerializer.Serialize(
            new
            {
                evidence.EntropySourceIdentifier,
                evidence.ProviderVersion,
                evidence.ConfigurationVersion,
                evidence.DrbgInstanceIdentifier,
                evidence.SeedIdentifier,
                evidence.ReseedCounter,
                evidence.RequestIdentifier,
                evidence.GeneratedBytesHash,
                evidence.GeneratedByteCount,
                evidence.GeneratedNumbers,
                evidence.StartedAt,
                evidence.CompletedAt,
                evidence.ExecutionDurationMicroseconds,
                evidence.Health
            },
            CanonicalJsonOptions));

    private static string HashMaterial(params byte[][] inputs)
    {
        var length = inputs.Sum(input => input.Length);
        var material = new byte[length];
        try
        {
            var offset = 0;
            foreach (var input in inputs)
            {
                input.CopyTo(material, offset);
                offset += input.Length;
            }

            return HashCanonicalBytes(material);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(material);
        }
    }

    private static string HashCanonical(string value) =>
        HashCanonicalBytes(Encoding.UTF8.GetBytes(value));

    private static string HashCanonicalBytes(ReadOnlySpan<byte> value) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant()}";

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

    private static void ValidateRequest(InternalCsprngExecutionRequest request)
    {
        if (request.RequestId == Guid.Empty ||
            string.IsNullOrWhiteSpace(request.IdempotencyKey) ||
            string.IsNullOrWhiteSpace(request.CorrelationId))
        {
            throw new ArgumentException(
                "Internal CSPRNG request id, idempotency key, and correlation id are required.");
        }
    }

    private static void ValidateGenerationDefinition(
        NumberOutcomeGenerationDefinition definition)
    {
        if (definition.NumberUniverse.Count == 0 ||
            definition.NumberUniverse.Distinct().Count() != definition.NumberUniverse.Count)
        {
            throw new InvalidOperationException(
                "Game Definition number universe must contain distinct values.");
        }

        if (definition.NumbersRequired <= 0)
        {
            throw new InvalidOperationException(
                "Game Definition numbers required must be positive.");
        }

        if (definition.Unique && definition.WithReplacement)
        {
            throw new InvalidOperationException(
                "A unique Game Definition cannot generate with replacement.");
        }

        if (!definition.WithReplacement &&
            definition.NumbersRequired > definition.NumberUniverse.Count)
        {
            throw new InvalidOperationException(
                "Game Definition requests more numbers than its universe without replacement.");
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
