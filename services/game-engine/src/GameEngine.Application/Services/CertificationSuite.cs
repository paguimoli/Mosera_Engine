using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;
using GameEngine.Domain.Randomness;

namespace GameEngine.Application.Services;

public sealed class CertificationSuite : ICertificationSuite, ICertificationPackageBuilder
{
    private readonly RandomnessRegistry randomnessRegistry;
    private readonly ValidationSuite validationSuite;
    private readonly List<CertificationPackage> packages = [];

    public CertificationSuite(RandomnessRegistry randomnessRegistry, ValidationSuite validationSuite)
    {
        this.randomnessRegistry = randomnessRegistry;
        this.validationSuite = validationSuite;
        packages.Add(BuildPackage("default-framework-profile"));
    }

    public CertificationSuiteStatus GetStatus()
    {
        return new CertificationSuiteStatus(
            CertificationStatus.Generated,
            packages.Count,
            validationSuite.DiscoverValidators().Count,
            packages.Sum(package => package.Evidence.Count),
            ["Certification package export and external laboratory automation are deferred."],
            DateTimeOffset.UtcNow);
    }

    public IReadOnlyCollection<CertificationPackage> GetPackages() => packages.ToArray();

    public CertificationPackage BuildPackage(string profileId)
    {
        var provider = randomnessRegistry
            .GetProviders()
            .Single(provider => provider.Metadata.ProviderId == "secure-rng-placeholder")
            .Metadata;
        var validationResults = validationSuite.DiscoverValidators();
        var metadata = new CertificationMetadata(
            $"certification-{profileId}",
            profileId,
            "FRAMEWORK_ONLY",
            DateTimeOffset.UnixEpoch,
            new Dictionary<string, object?>
            {
                ["approvalMetadata"] = "placeholder",
                ["archiveGeneration"] = false
            });

        var evidenceFile = BuildEvidenceFile(profileId, provider, validationResults);
        var artifact = new CertificationArtifact(
            "artifact-structured-metadata",
            CertificationArtifactType.StructuredMetadata,
            new EvidenceHash(evidenceFile.Checksum.Algorithm, evidenceFile.Checksum.Value),
            new Dictionary<string, object?>
            {
                ["format"] = "structured-json",
                ["pdfGenerated"] = false
            });

        return new CertificationPackage(
            $"package-{profileId}",
            CertificationStatus.Generated,
            new Dictionary<string, object?>
            {
                ["gameRules"] = "placeholder",
                ["drawRules"] = "placeholder",
                ["productionGameLogicEnabled"] = false
            },
            new Dictionary<string, object?>
            {
                ["moduleVersion"] = "0.0.0-skeleton",
                ["drawGeneratorOwner"] = "game-module"
            },
            provider,
            new Dictionary<string, object?>
            {
                ["drawGeneratorVersion"] = "0.0.0-framework",
                ["samplingWithoutReplacementSupported"] = true,
                ["samplingWithReplacementSupported"] = true
            },
            new Dictionary<string, object?>
            {
                ["providerVersion"] = provider.ProviderVersion,
                ["evaluatorVersion"] = "0.0.0-framework",
                ["configurationVersion"] = "0.0.0-framework"
            },
            new Dictionary<string, object?>
            {
                ["range"] = "placeholder",
                ["selectionCount"] = "placeholder",
                ["replacementRules"] = "placeholder"
            },
            BuildBuildMetadata(),
            new Dictionary<string, object?>
            {
                ["os"] = RuntimeInformation.OSDescription,
                ["runtime"] = RuntimeInformation.FrameworkDescription
            },
            new Dictionary<string, object?>
            {
                ["processorCount"] = Environment.ProcessorCount,
                ["machineNamePresent"] = !string.IsNullOrWhiteSpace(Environment.MachineName)
            },
            [evidenceFile.Checksum],
            validationResults,
            metadata,
            [new CertificationEvidence("evidence-framework-package", evidenceFile, [artifact])],
            [artifact]);
    }

    private static EvidenceFile BuildEvidenceFile(
        string profileId,
        RandomnessProviderMetadata provider,
        IReadOnlyCollection<ValidationSuiteResult> validationResults)
    {
        var payload = JsonSerializer.Serialize(new
        {
            profileId,
            provider,
            validationResults,
            productionAlgorithmsImplemented = false
        });
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payload))).ToLowerInvariant();

        return new EvidenceFile(
            "certification-framework-evidence.json",
            EvidenceSource.GameEngine,
            EvidenceCategory.Validation,
            new EvidenceVersion("certification-evidence-v1", "game-engine-0.0.0-framework"),
            new EvidenceChecksum(EvidenceHashAlgorithm.Sha256, hash, DateTimeOffset.UnixEpoch),
            new EvidenceTimestamp(DateTimeOffset.UnixEpoch, "reproducible-framework-clock"),
            new EvidenceProducer("game-engine", "Game Engine", "0.0.0-framework"),
            new Dictionary<string, object?>
            {
                ["reproducible"] = true,
                ["productionRngImplemented"] = false
            },
            []);
    }

    private static IReadOnlyDictionary<string, object?> BuildBuildMetadata()
    {
        return new Dictionary<string, object?>
        {
            ["containerVersion"] = "placeholder",
            ["runtimeVersion"] = RuntimeInformation.FrameworkDescription,
            ["gitCommit"] = Environment.GetEnvironmentVariable("GIT_COMMIT") ?? "unknown",
            ["buildId"] = Environment.GetEnvironmentVariable("BUILD_ID") ?? "local",
            ["assemblyVersion"] = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "unknown"
        };
    }
}
