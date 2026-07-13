using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class OutcomeValidationFrameworkService
{
    public CryptographicConformanceReport EvaluateCryptographicConformance(
        CryptographicConformanceSubjectType subjectType,
        string subjectId,
        string subjectVersion,
        string subjectContentHash,
        IReadOnlyCollection<CryptographicConformanceCheckType> checksEvaluated,
        IReadOnlyDictionary<string, object?> testVectors,
        IReadOnlyDictionary<string, object?> providerEvidence,
        ValidationSupplyChainProvenance provenance,
        DateTimeOffset? startedAt = null,
        DateTimeOffset? completedAt = null)
    {
        ValidateSubject(subjectId, subjectVersion, subjectContentHash);
        ValidateProvenance(provenance);

        var blockers = new List<string>();
        var requiredChecks = RequiredConformanceChecks(subjectType).ToArray();
        var missingChecks = requiredChecks.Except(checksEvaluated).ToArray();

        if (missingChecks.Length > 0)
        {
            blockers.Add($"Missing conformance checks: {string.Join(", ", missingChecks)}.");
        }

        if (providerEvidence.TryGetValue("healthTestsPassed", out var healthTestsPassed) &&
            healthTestsPassed is false)
        {
            blockers.Add("Provider health tests did not pass.");
        }

        if (providerEvidence.TryGetValue("knownAnswerTestsPassed", out var knownAnswerTestsPassed) &&
            knownAnswerTestsPassed is false)
        {
            blockers.Add("Known Answer Tests did not pass.");
        }

        if (providerEvidence.TryGetValue("continuousTestsPassed", out var continuousTestsPassed) &&
            continuousTestsPassed is false)
        {
            blockers.Add("Continuous tests did not pass.");
        }

        if (providerEvidence.TryGetValue("algorithmVersionCompatible", out var algorithmVersionCompatible) &&
            algorithmVersionCompatible is false)
        {
            blockers.Add("Provider algorithm version is not compatible.");
        }

        var status = blockers.Count == 0
            ? ValidationEvaluationStatus.Pass
            : ValidationEvaluationStatus.Fail;

        var begin = startedAt ?? DateTimeOffset.UtcNow;
        var end = completedAt ?? begin;
        var canonicalHash = HashCanonical(new SortedDictionary<string, object?>
        {
            ["checksEvaluated"] = checksEvaluated.Select(check => check.ToString()).Order().ToArray(),
            ["providerEvidence"] = providerEvidence,
            ["provenance"] = provenance,
            ["status"] = status.ToString(),
            ["subjectContentHash"] = subjectContentHash,
            ["subjectId"] = subjectId,
            ["subjectType"] = subjectType.ToString(),
            ["subjectVersion"] = subjectVersion,
            ["testVectors"] = testVectors
        });

        return new CryptographicConformanceReport(
            DeterministicGuid($"cryptographic-conformance:{canonicalHash}"),
            subjectType,
            subjectId,
            subjectVersion,
            subjectContentHash,
            checksEvaluated,
            status,
            blockers,
            testVectors,
            providerEvidence,
            provenance,
            begin,
            end,
            canonicalHash,
            PlaceholderSignature(end));
    }

    public StatisticalValidationFrameworkReport EvaluateFrequency(
        ProviderValidationSubjectType targetType,
        string targetId,
        string targetVersion,
        string targetContentHash,
        string? manifestId,
        string? manifestVersion,
        string algorithmVersion,
        IReadOnlyDictionary<string, long> observedCounts,
        IReadOnlyDictionary<string, decimal> expectedDistribution,
        long sampleSize,
        ValidationSupplyChainProvenance provenance)
    {
        ValidateSubject(targetId, targetVersion, targetContentHash);
        ValidateProvenance(provenance);

        if (sampleSize <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(sampleSize), "Sample size must be positive.");
        }

        if (observedCounts.Count == 0 || expectedDistribution.Count == 0)
        {
            throw new ArgumentException("Observed and expected distributions are required.");
        }

        var blockers = new List<string>();
        var expectedSum = expectedDistribution.Values.Sum();
        if (Math.Abs(expectedSum - 1m) > 0.0001m)
        {
            blockers.Add("Expected distribution must sum to 1.");
        }

        var observedTotal = observedCounts.Values.Sum();
        if (observedTotal != sampleSize)
        {
            blockers.Add("Observed count total must equal sample size.");
        }

        decimal maxDeviation = 0m;
        foreach (var expected in expectedDistribution)
        {
            observedCounts.TryGetValue(expected.Key, out var count);
            var observed = sampleSize == 0 ? 0m : count / (decimal)sampleSize;
            maxDeviation = Math.Max(maxDeviation, Math.Abs(observed - expected.Value));
        }

        if (maxDeviation > 0.05m)
        {
            blockers.Add("Frequency deviation exceeds internal validation threshold.");
        }

        return CreateStatisticalReport(
            StatisticalValidationSuiteType.Frequency,
            targetType,
            targetId,
            targetVersion,
            targetContentHash,
            manifestId,
            manifestVersion,
            algorithmVersion,
            sampleSize,
            new SortedDictionary<string, object?>
            {
                ["expectedDistribution"] = expectedDistribution,
                ["threshold"] = 0.05m
            },
            new SortedDictionary<string, object?>
            {
                ["maxDeviation"] = maxDeviation,
                ["observedCounts"] = observedCounts,
                ["observedTotal"] = observedTotal
            },
            blockers.Count == 0 ? ValidationEvaluationStatus.Pass : ValidationEvaluationStatus.Fail,
            blockers,
            provenance);
    }

    public StatisticalValidationFrameworkReport ImportExternalStatisticalReport(
        StatisticalValidationSuiteType suiteType,
        ProviderValidationSubjectType targetType,
        string targetId,
        string targetVersion,
        string targetContentHash,
        string algorithmVersion,
        long sampleSize,
        IReadOnlyDictionary<string, object?> configuration,
        IReadOnlyDictionary<string, object?> summary,
        ValidationEvaluationStatus status,
        IReadOnlyCollection<string> blockers,
        ValidationSupplyChainProvenance provenance)
    {
        ValidateSubject(targetId, targetVersion, targetContentHash);
        ValidateProvenance(provenance);

        if (sampleSize <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(sampleSize), "Sample size must be positive.");
        }

        return CreateStatisticalReport(
            suiteType,
            targetType,
            targetId,
            targetVersion,
            targetContentHash,
            null,
            null,
            algorithmVersion,
            sampleSize,
            configuration,
            summary,
            status,
            blockers,
            provenance);
    }

    public ProviderValidationRegistryEntry CreateRegistryEntry(
        ProviderValidationSubjectType providerType,
        string providerId,
        string providerVersion,
        string validationVersion,
        string implementationHash,
        string configurationHash,
        ValidationEvaluationStatus validationStatus,
        string @operator,
        IReadOnlyCollection<string> evidenceHashes)
    {
        ValidateSubject(providerId, providerVersion, implementationHash);
        RequireHash(configurationHash, nameof(configurationHash));
        RequireText(validationVersion, nameof(validationVersion));
        RequireText(@operator, nameof(@operator));

        if (evidenceHashes.Count == 0)
        {
            throw new ArgumentException("At least one evidence hash is required.", nameof(evidenceHashes));
        }

        foreach (var evidenceHash in evidenceHashes)
        {
            RequireHash(evidenceHash, nameof(evidenceHashes));
        }

        var validationDate = DateTimeOffset.UtcNow;
        var canonicalHash = HashCanonical(new SortedDictionary<string, object?>
        {
            ["configurationHash"] = configurationHash,
            ["evidenceHashes"] = evidenceHashes.Order().ToArray(),
            ["implementationHash"] = implementationHash,
            ["operator"] = @operator,
            ["providerId"] = providerId,
            ["providerType"] = providerType.ToString(),
            ["providerVersion"] = providerVersion,
            ["validationStatus"] = validationStatus.ToString(),
            ["validationVersion"] = validationVersion
        });

        return new ProviderValidationRegistryEntry(
            DeterministicGuid($"provider-validation-registry:{canonicalHash}"),
            providerType,
            providerId,
            providerVersion,
            validationVersion,
            implementationHash,
            configurationHash,
            validationStatus,
            validationDate,
            @operator,
            evidenceHashes,
            canonicalHash);
    }

    public CertificationReadinessEvaluation EvaluateReadiness(
        ProviderValidationSubjectType targetType,
        string targetId,
        string targetVersion,
        bool providerApproved,
        bool guardrailsPassed,
        bool cryptographicConformancePassed,
        bool statisticalValidationPassed,
        bool requiredEvidenceComplete,
        bool providerHealthPassed,
        bool runtimeReadinessPassed,
        bool outcomeAuthorityDisabled,
        IReadOnlyCollection<string> evidenceHashes,
        ValidationSupplyChainProvenance provenance)
    {
        RequireText(targetId, nameof(targetId));
        RequireText(targetVersion, nameof(targetVersion));
        ValidateProvenance(provenance);

        var blockers = new List<string>();
        AddBlocker(blockers, providerApproved, "Provider approval is required.");
        AddBlocker(blockers, guardrailsPassed, "Outcome Authority guardrails must pass.");
        AddBlocker(blockers, cryptographicConformancePassed, "Cryptographic conformance must pass.");
        AddBlocker(blockers, statisticalValidationPassed, "Statistical validation must pass.");
        AddBlocker(blockers, requiredEvidenceComplete, "Required validation evidence must be complete.");
        AddBlocker(blockers, providerHealthPassed, "Provider health must pass.");
        AddBlocker(blockers, runtimeReadinessPassed, "Runtime readiness must pass.");
        AddBlocker(blockers, outcomeAuthorityDisabled, "Outcome Authority must remain disabled during readiness evaluation.");

        foreach (var evidenceHash in evidenceHashes)
        {
            RequireHash(evidenceHash, nameof(evidenceHashes));
        }

        var status = ResolveReadinessStatus(
            statisticalValidationPassed,
            cryptographicConformancePassed,
            requiredEvidenceComplete,
            providerApproved,
            guardrailsPassed,
            providerHealthPassed,
            runtimeReadinessPassed,
            blockers.Count == 0);

        var evaluatedAt = DateTimeOffset.UtcNow;
        var canonicalHash = HashCanonical(new SortedDictionary<string, object?>
        {
            ["blockers"] = blockers.Order().ToArray(),
            ["cryptographicConformancePassed"] = cryptographicConformancePassed,
            ["evidenceHashes"] = evidenceHashes.Order().ToArray(),
            ["guardrailsPassed"] = guardrailsPassed,
            ["outcomeAuthorityDisabled"] = outcomeAuthorityDisabled,
            ["providerApproved"] = providerApproved,
            ["providerHealthPassed"] = providerHealthPassed,
            ["requiredEvidenceComplete"] = requiredEvidenceComplete,
            ["runtimeReadinessPassed"] = runtimeReadinessPassed,
            ["statisticalValidationPassed"] = statisticalValidationPassed,
            ["status"] = status.ToString(),
            ["targetId"] = targetId,
            ["targetType"] = targetType.ToString(),
            ["targetVersion"] = targetVersion
        });

        return new CertificationReadinessEvaluation(
            DeterministicGuid($"certification-readiness:{canonicalHash}"),
            targetType,
            targetId,
            targetVersion,
            status,
            statisticalValidationPassed,
            cryptographicConformancePassed,
            requiredEvidenceComplete,
            providerHealthPassed,
            runtimeReadinessPassed,
            guardrailsPassed,
            providerApproved,
            outcomeAuthorityDisabled,
            blockers,
            evidenceHashes,
            provenance,
            evaluatedAt,
            canonicalHash);
    }

    private StatisticalValidationFrameworkReport CreateStatisticalReport(
        StatisticalValidationSuiteType suiteType,
        ProviderValidationSubjectType targetType,
        string targetId,
        string targetVersion,
        string targetContentHash,
        string? manifestId,
        string? manifestVersion,
        string algorithmVersion,
        long sampleSize,
        IReadOnlyDictionary<string, object?> configuration,
        IReadOnlyDictionary<string, object?> statisticalSummary,
        ValidationEvaluationStatus status,
        IReadOnlyCollection<string> blockers,
        ValidationSupplyChainProvenance provenance)
    {
        var startedAt = DateTimeOffset.UtcNow;
        var completedAt = startedAt;
        var canonicalHash = HashCanonical(new SortedDictionary<string, object?>
        {
            ["algorithmVersion"] = algorithmVersion,
            ["blockers"] = blockers.Order().ToArray(),
            ["configuration"] = configuration,
            ["manifestId"] = manifestId,
            ["manifestVersion"] = manifestVersion,
            ["provenance"] = provenance,
            ["sampleSize"] = sampleSize,
            ["statisticalSummary"] = statisticalSummary,
            ["status"] = status.ToString(),
            ["suiteType"] = suiteType.ToString(),
            ["targetContentHash"] = targetContentHash,
            ["targetId"] = targetId,
            ["targetType"] = targetType.ToString(),
            ["targetVersion"] = targetVersion
        });

        return new StatisticalValidationFrameworkReport(
            DeterministicGuid($"statistical-validation-framework:{canonicalHash}"),
            suiteType,
            targetType,
            targetId,
            targetVersion,
            targetContentHash,
            manifestId,
            manifestVersion,
            algorithmVersion,
            sampleSize,
            configuration,
            statisticalSummary,
            status,
            blockers,
            provenance,
            startedAt,
            completedAt,
            canonicalHash,
            PlaceholderSignature(completedAt));
    }

    private static IReadOnlyCollection<CryptographicConformanceCheckType> RequiredConformanceChecks(
        CryptographicConformanceSubjectType subjectType)
    {
        if (subjectType == CryptographicConformanceSubjectType.CertifiedCsprng)
        {
            return
            [
                CryptographicConformanceCheckType.HmacDrbgInstantiate,
                CryptographicConformanceCheckType.HmacDrbgGenerate,
                CryptographicConformanceCheckType.HmacDrbgReseed,
                CryptographicConformanceCheckType.HmacDrbgUpdate,
                CryptographicConformanceCheckType.HmacDrbgDestroy,
                CryptographicConformanceCheckType.SecurityStrength,
                CryptographicConformanceCheckType.PredictionResistancePolicy,
                CryptographicConformanceCheckType.ReseedIntervalPolicy,
                CryptographicConformanceCheckType.PersonalizationHandling,
                CryptographicConformanceCheckType.AdditionalInputHandling,
                CryptographicConformanceCheckType.KnownAnswerTests,
                CryptographicConformanceCheckType.ContinuousTests,
                CryptographicConformanceCheckType.HealthTests,
                CryptographicConformanceCheckType.ProviderVersionCompatibility,
                CryptographicConformanceCheckType.ProviderConfiguration
            ];
        }

        return
        [
            CryptographicConformanceCheckType.ProviderVersionCompatibility,
            CryptographicConformanceCheckType.ProviderConfiguration,
            CryptographicConformanceCheckType.HealthTests
        ];
    }

    private static CertificationReadinessStatus ResolveReadinessStatus(
        bool statisticalValidationPassed,
        bool cryptographicConformancePassed,
        bool requiredEvidenceComplete,
        bool providerApproved,
        bool guardrailsPassed,
        bool providerHealthPassed,
        bool runtimeReadinessPassed,
        bool productionEligible)
    {
        if (productionEligible)
        {
            return CertificationReadinessStatus.ProductionEligible;
        }

        if (statisticalValidationPassed &&
            cryptographicConformancePassed &&
            requiredEvidenceComplete &&
            providerApproved &&
            guardrailsPassed &&
            providerHealthPassed &&
            runtimeReadinessPassed)
        {
            return CertificationReadinessStatus.CertificationReady;
        }

        if (cryptographicConformancePassed)
        {
            return CertificationReadinessStatus.CryptographicallyConformant;
        }

        if (statisticalValidationPassed)
        {
            return CertificationReadinessStatus.StatisticallyValidated;
        }

        return CertificationReadinessStatus.NotValidated;
    }

    private static void AddBlocker(ICollection<string> blockers, bool passed, string message)
    {
        if (!passed)
        {
            blockers.Add(message);
        }
    }

    private static void ValidateSubject(string subjectId, string subjectVersion, string subjectContentHash)
    {
        RequireText(subjectId, nameof(subjectId));
        RequireText(subjectVersion, nameof(subjectVersion));
        RequireHash(subjectContentHash, nameof(subjectContentHash));
    }

    private static void ValidateProvenance(ValidationSupplyChainProvenance provenance)
    {
        RequireText(provenance.GitCommitSha, nameof(provenance.GitCommitSha));
        RequireText(provenance.SemanticVersion, nameof(provenance.SemanticVersion));
        RequireText(provenance.BuildNumber, nameof(provenance.BuildNumber));
        RequireText(provenance.CompilerRuntimeVersion, nameof(provenance.CompilerRuntimeVersion));
        RequireHash(provenance.ImplementationHash, nameof(provenance.ImplementationHash));
        RequireHash(provenance.ConfigurationHash, nameof(provenance.ConfigurationHash));
    }

    private static void RequireText(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"{field} is required.", field);
        }
    }

    private static void RequireHash(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || !value.StartsWith("sha256:", StringComparison.Ordinal))
        {
            throw new ArgumentException($"{field} must be a sha256 hash.", field);
        }
    }

    private static SignatureMetadata PlaceholderSignature(DateTimeOffset signedAt)
    {
        return new SignatureMetadata(
            "placeholder-validation-signing-key",
            "sha256-v1",
            "placeholder-signature-v1",
            "placeholder-signature",
            signedAt);
    }

    private static string HashCanonical(IReadOnlyDictionary<string, object?> payload)
    {
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
        {
            WriteIndented = false
        });

        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant()}";
    }

    private static Guid DeterministicGuid(string value)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(hash[..16]);
    }
}
