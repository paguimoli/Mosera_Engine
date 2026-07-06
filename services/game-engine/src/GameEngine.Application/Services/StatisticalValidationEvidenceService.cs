using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class StatisticalValidationEvidenceService
{
    public StatisticalValidationResult CreateValidationResult(
        StatisticalValidationType validationType,
        StatisticalValidationTargetArtifactType targetArtifactType,
        string targetArtifactId,
        string? targetArtifactVersion,
        string targetArtifactHash,
        long sampleSize,
        IReadOnlyDictionary<string, object?> expectedDistribution,
        IReadOnlyDictionary<string, object?> observedDistribution,
        decimal? pValue,
        decimal? score,
        StatisticalValidationStatus resultStatus)
    {
        ValidateCommon(targetArtifactId, targetArtifactHash, sampleSize);

        var generatedAt = DateTimeOffset.UtcNow;
        var canonicalPayload = JsonSerializer.Serialize(new SortedDictionary<string, object?>
        {
            ["expectedDistribution"] = expectedDistribution,
            ["observedDistribution"] = observedDistribution,
            ["pValue"] = pValue,
            ["resultStatus"] = resultStatus.ToString(),
            ["sampleSize"] = sampleSize,
            ["score"] = score,
            ["targetArtifactHash"] = targetArtifactHash,
            ["targetArtifactId"] = targetArtifactId,
            ["targetArtifactType"] = targetArtifactType.ToString(),
            ["targetArtifactVersion"] = targetArtifactVersion,
            ["validationType"] = validationType.ToString()
        });

        var canonicalResultHash = Sha256(canonicalPayload);
        return new StatisticalValidationResult(
            DeterministicGuid($"statistical-validation:{canonicalResultHash}"),
            validationType,
            targetArtifactType,
            targetArtifactId,
            targetArtifactVersion,
            targetArtifactHash,
            sampleSize,
            expectedDistribution,
            observedDistribution,
            pValue,
            score,
            resultStatus,
            generatedAt,
            canonicalResultHash,
            new SignatureMetadata(
                "placeholder-signing-key",
                "sha256-v1",
                "placeholder-signature-v1",
                "placeholder-signature",
                generatedAt));
    }

    public SimulationEvidence CreateSimulationEvidence(
        SimulationMode simulationMode,
        string outcomeStrategyId,
        string outcomeStrategyVersion,
        string outcomeStrategyHash,
        string mathModelId,
        string mathModelVersion,
        string mathModelHash,
        string paytableId,
        string paytableVersion,
        string paytableHash,
        string rngProviderId,
        string rngProviderVersion,
        string rngProviderHash,
        long iterationCount,
        decimal theoreticalRtp,
        decimal observedRtp,
        decimal variance,
        decimal hitFrequency,
        IReadOnlyDictionary<string, object?> prizeDistribution,
        IReadOnlyDictionary<string, object?> confidenceInterval)
    {
        if (simulationMode == SimulationMode.ProductionDisabled)
        {
            throw new InvalidOperationException("Simulation evidence can never be used as production outcome evidence.");
        }

        ValidateCommon(outcomeStrategyId, outcomeStrategyHash, iterationCount);
        RequireHash(mathModelHash, nameof(mathModelHash));
        RequireHash(paytableHash, nameof(paytableHash));
        RequireHash(rngProviderHash, nameof(rngProviderHash));

        var canonicalPayload = JsonSerializer.Serialize(new SortedDictionary<string, object?>
        {
            ["confidenceInterval"] = confidenceInterval,
            ["hitFrequency"] = hitFrequency,
            ["iterationCount"] = iterationCount,
            ["mathModelHash"] = mathModelHash,
            ["mathModelId"] = mathModelId,
            ["mathModelVersion"] = mathModelVersion,
            ["observedRtp"] = observedRtp,
            ["outcomeStrategyHash"] = outcomeStrategyHash,
            ["outcomeStrategyId"] = outcomeStrategyId,
            ["outcomeStrategyVersion"] = outcomeStrategyVersion,
            ["paytableHash"] = paytableHash,
            ["paytableId"] = paytableId,
            ["paytableVersion"] = paytableVersion,
            ["prizeDistribution"] = prizeDistribution,
            ["rngProviderHash"] = rngProviderHash,
            ["rngProviderId"] = rngProviderId,
            ["rngProviderVersion"] = rngProviderVersion,
            ["simulationMode"] = simulationMode.ToString(),
            ["theoreticalRtp"] = theoreticalRtp,
            ["variance"] = variance
        });

        var canonicalEvidenceHash = Sha256(canonicalPayload);
        return new SimulationEvidence(
            DeterministicGuid($"simulation-evidence:{canonicalEvidenceHash}"),
            simulationMode,
            outcomeStrategyId,
            outcomeStrategyVersion,
            outcomeStrategyHash,
            mathModelId,
            mathModelVersion,
            mathModelHash,
            paytableId,
            paytableVersion,
            paytableHash,
            rngProviderId,
            rngProviderVersion,
            rngProviderHash,
            iterationCount,
            theoreticalRtp,
            observedRtp,
            variance,
            hitFrequency,
            prizeDistribution,
            confidenceInterval,
            canonicalEvidenceHash,
            new SignatureMetadata(
                "placeholder-signing-key",
                "sha256-v1",
                "placeholder-signature-v1",
                "placeholder-signature",
                DateTimeOffset.UtcNow));
    }

    public StatisticalCertificationReadiness EvaluateCertificationReadiness(
        IReadOnlyCollection<StatisticalValidationResult> validationResults)
    {
        var blockers = new List<string>();

        if (validationResults.Count == 0)
        {
            blockers.Add("At least one statistical validation result is required.");
        }

        if (validationResults.Any(result => result.ResultStatus == StatisticalValidationStatus.Fail))
        {
            blockers.Add("Failed statistical validation results cannot certify an artifact.");
        }

        if (validationResults.Any(result => result.ResultStatus == StatisticalValidationStatus.Inconclusive))
        {
            blockers.Add("Inconclusive statistical validation results do not certify an artifact.");
        }

        return new StatisticalCertificationReadiness(blockers.Count == 0, blockers);
    }

    private static void ValidateCommon(string targetArtifactId, string targetArtifactHash, long sampleSize)
    {
        if (string.IsNullOrWhiteSpace(targetArtifactId))
        {
            throw new ArgumentException("Target artifact id is required.", nameof(targetArtifactId));
        }

        RequireHash(targetArtifactHash, nameof(targetArtifactHash));

        if (sampleSize <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(sampleSize), "Sample size must be positive.");
        }
    }

    private static void RequireHash(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || !value.StartsWith("sha256:", StringComparison.Ordinal))
        {
            throw new ArgumentException($"{field} must be a sha256 hash.", field);
        }
    }

    private static string Sha256(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private static Guid DeterministicGuid(string value)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(hash[..16]);
    }
}
