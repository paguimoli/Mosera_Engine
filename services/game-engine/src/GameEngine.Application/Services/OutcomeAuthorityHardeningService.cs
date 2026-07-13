using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class OutcomeAuthorityHardeningService
{
    public const string HmacDrbgSuiteId = "NIST-SP800-90A-REV1-HMAC-DRBG-CONFORMANCE";
    public const string HmacDrbgSuiteVersion = "p0-007.13-v1";
    private const string LockDerivationAlgorithm = "sha256(outcome-authority-lock|purpose|namespace|resource-scope)";

    private readonly IHmacDrbgRuntime drbgRuntime;
    private readonly OutcomeValidationFrameworkService validationFramework;

    public OutcomeAuthorityHardeningService()
        : this(new HmacDrbgRuntime(), new OutcomeValidationFrameworkService())
    {
    }

    public OutcomeAuthorityHardeningService(
        IHmacDrbgRuntime drbgRuntime,
        OutcomeValidationFrameworkService validationFramework)
    {
        this.drbgRuntime = drbgRuntime;
        this.validationFramework = validationFramework;
    }

    public HmacDrbgConformanceSuiteResult RunHmacDrbgConformanceVectors(
        string providerBuildIdentity,
        IReadOnlyCollection<HmacDrbgConformanceVector>? vectors = null)
    {
        RequireText(providerBuildIdentity, nameof(providerBuildIdentity));

        var results = new List<HmacDrbgConformanceVectorResult>();
        var blockers = new List<string>();

        foreach (var vector in vectors ?? OfficialHmacDrbgConformanceVectors())
        {
            var result = EvaluateVector(vector, providerBuildIdentity);
            results.Add(result);
            if (!result.Passed)
            {
                blockers.Add($"{vector.VectorId} failed: {result.FailureReason}");
            }
        }

        var canonicalHash = HashCanonical(new SortedDictionary<string, object?>
        {
            ["providerBuildIdentity"] = providerBuildIdentity,
            ["suiteId"] = HmacDrbgSuiteId,
            ["suiteVersion"] = HmacDrbgSuiteVersion,
            ["vectors"] = results.Select(result => new SortedDictionary<string, object?>
            {
                ["hashAlgorithm"] = result.HashAlgorithm.ToString(),
                ["passed"] = result.Passed,
                ["providerBuildIdentity"] = result.ProviderBuildIdentity,
                ["vectorId"] = result.VectorId,
                ["vectorVersion"] = result.VectorVersion
            }).ToArray()
        });

        return new HmacDrbgConformanceSuiteResult(
            HmacDrbgSuiteId,
            HmacDrbgSuiteVersion,
            blockers.Count == 0,
            results,
            blockers,
            canonicalHash);
    }

    public EntropyProviderConfigurationEvidence ValidateEntropyProviderConfiguration(
        IReadOnlyCollection<EntropyProviderDeploymentConfiguration> configuredProviders,
        IOsEntropyProvider runtimeProvider,
        bool fallbackDisabled = true)
    {
        ArgumentNullException.ThrowIfNull(configuredProviders);
        ArgumentNullException.ThrowIfNull(runtimeProvider);

        var blockers = new List<string>();
        if (configuredProviders.Count != 1)
        {
            blockers.Add("Exactly one approved Entropy Provider must be configured.");
        }

        var configured = configuredProviders.SingleOrDefault();
        var approved = configured?.Approved == true && configured.ProductionEligible;
        if (!approved)
        {
            blockers.Add("Configured Entropy Provider is not approved and production eligible.");
        }

        var platformCompatible = configured is not null &&
            configured.ExpectedPlatform == runtimeProvider.Platform &&
            runtimeProvider.IsSupported &&
            runtimeProvider.CheckReadiness().Ready;
        if (!platformCompatible)
        {
            blockers.Add("Runtime OS entropy provider does not match configured Entropy Provider.");
        }

        if (!fallbackDisabled)
        {
            blockers.Add("Entropy Provider fallback must be disabled.");
        }

        var substitutionDetected = configured is not null &&
            configured.ExpectedPlatform != runtimeProvider.Platform &&
            runtimeProvider.Platform != OsEntropyPlatform.Unsupported;
        if (substitutionDetected)
        {
            blockers.Add("Entropy Provider substitution was detected.");
        }

        if (configured?.FailureMode != CertifiedCsprngFailureMode.FailClosed)
        {
            blockers.Add("Production Entropy Provider must fail closed.");
        }

        return new EntropyProviderConfigurationEvidence(
            ExactlyOneProviderConfigured: configuredProviders.Count == 1,
            ProviderApproved: approved,
            PlatformCompatible: platformCompatible,
            FallbackDisabled: fallbackDisabled,
            ProviderSubstitutionDetected: substitutionDetected,
            Ready: blockers.Count == 0,
            Blockers: blockers);
    }

    public IReadOnlyCollection<LegacyRandomnessIsolationEvidence> EvaluateLegacyRandomnessIsolation(
        IReadOnlyCollection<LegacyRandomnessIsolationEvidence> evidence)
    {
        ArgumentNullException.ThrowIfNull(evidence);

        return evidence.Select(item =>
        {
            var blockers = item.Blockers.ToList();
            if (item.ProductionEligible)
            {
                blockers.Add("Legacy/test randomness path cannot be production eligible.");
            }

            if (item.RegisteredForCertifiedCsprngRuntime)
            {
                blockers.Add("Legacy/test randomness path cannot be registered into the Certified CSPRNG runtime.");
            }

            return item with
            {
                ProductionEligible = false,
                RegisteredForCertifiedCsprngRuntime = false,
                Blockers = blockers
            };
        }).ToArray();
    }

    public OutcomeAuthorityReadinessReport CreateReadinessReport(
        IReadOnlyCollection<OutcomeAuthorityReadinessSection> sourceSections,
        bool productionAuthorityEnabled)
    {
        ArgumentNullException.ThrowIfNull(sourceSections);

        var sections = sourceSections
            .OrderBy(section => section.Section, StringComparer.Ordinal)
            .ToArray();
        var blockers = sections.SelectMany(section => section.Blockers).ToList();

        foreach (var required in RequiredReadinessSections())
        {
            if (sections.All(section => !string.Equals(section.Section, required, StringComparison.Ordinal)))
            {
                blockers.Add($"Missing readiness evidence: {required}.");
            }
        }

        if (productionAuthorityEnabled)
        {
            blockers.Add("Production Outcome Authority must remain disabled in P0-007.13.");
        }

        var generatedAt = DateTimeOffset.UtcNow;
        var hash = HashCanonical(new SortedDictionary<string, object?>
        {
            ["blockers"] = blockers.Order(StringComparer.Ordinal).ToArray(),
            ["productionAuthorityEnabled"] = productionAuthorityEnabled,
            ["sections"] = sections.Select(section => new SortedDictionary<string, object?>
            {
                ["blockers"] = section.Blockers.Order(StringComparer.Ordinal).ToArray(),
                ["evidenceReferences"] = section.EvidenceReferences.Order(StringComparer.Ordinal).ToArray(),
                ["section"] = section.Section,
                ["status"] = section.Status.ToString()
            }).ToArray()
        });

        return new OutcomeAuthorityReadinessReport(
            DeterministicGuid($"outcome-readiness:{hash}"),
            generatedAt,
            productionAuthorityEnabled,
            ProductionEligibleEvidenceOnly: true,
            sections,
            blockers,
            hash);
    }

    public OutcomeRuntimeAdvisoryLockScopeEvidence DeriveAdvisoryLockScope(
        string purpose,
        string @namespace,
        string resourceScope,
        TimeSpan boundedTimeout)
    {
        RequireText(purpose, nameof(purpose));
        RequireText(@namespace, nameof(@namespace));
        RequireText(resourceScope, nameof(resourceScope));

        if (boundedTimeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(boundedTimeout), "Lock timeout must be positive and bounded.");
        }

        var digest = HashHex($"outcome-authority-lock|{purpose}|{@namespace}|{resourceScope}");
        return new OutcomeRuntimeAdvisoryLockScopeEvidence(
            purpose,
            @namespace,
            resourceScope,
            $"outcome-authority:{purpose}:{@namespace}:{digest[..32]}",
            LockDerivationAlgorithm,
            boundedTimeout,
            RedisDependencyAbsent: true);
    }

    public OutcomeRuntimeRollbackWatermarkEvaluation EvaluateRollbackWatermark(
        OutcomeRuntimeRollbackWatermark? previous,
        OutcomeRuntimeRollbackWatermark current)
    {
        ArgumentNullException.ThrowIfNull(current);
        var blockers = new List<string>();

        if (current.EvidenceHashes.Count == 0 ||
            current.EvidenceHashes.Any(hash => !hash.StartsWith("sha256:", StringComparison.Ordinal)))
        {
            blockers.Add("Rollback watermark requires sha256 evidence hashes.");
        }

        if (!current.ChainRootHash.StartsWith("sha256:", StringComparison.Ordinal))
        {
            blockers.Add("Rollback watermark chain root must be a sha256 hash.");
        }

        if (previous is not null)
        {
            if (current.SequenceNumber <= previous.SequenceNumber)
            {
                blockers.Add("Rollback watermark sequence regressed.");
                return new OutcomeRuntimeRollbackWatermarkEvaluation(
                    OutcomeAuthorityRollbackWatermarkStatus.RegressionDetected,
                    FailClosed: true,
                    blockers);
            }

            if (!string.Equals(current.PreviousChainHash, previous.ChainRootHash, StringComparison.Ordinal))
            {
                blockers.Add("Rollback watermark previous chain hash does not match latest known chain root.");
                return new OutcomeRuntimeRollbackWatermarkEvaluation(
                    OutcomeAuthorityRollbackWatermarkStatus.ChainMismatch,
                    FailClosed: true,
                    blockers);
            }
        }

        if (blockers.Count > 0)
        {
            return new OutcomeRuntimeRollbackWatermarkEvaluation(
                OutcomeAuthorityRollbackWatermarkStatus.MissingEvidence,
                FailClosed: true,
                blockers);
        }

        return new OutcomeRuntimeRollbackWatermarkEvaluation(
            OutcomeAuthorityRollbackWatermarkStatus.Accepted,
            FailClosed: false,
            []);
    }

    public StatisticalValidationFrameworkReport ImportExternalStatisticalEvidence(
        ExternalStatisticalEvidenceImportRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireText(request.ToolName, nameof(request.ToolName));
        RequireText(request.ToolVersion, nameof(request.ToolVersion));
        RequireText(request.ProviderBuildIdentity, nameof(request.ProviderBuildIdentity));
        RequireText(request.Operator, nameof(request.Operator));
        if (!request.ReportHash.StartsWith("sha256:", StringComparison.Ordinal))
        {
            throw new ArgumentException("External report hash must be a sha256 hash.", nameof(request));
        }

        var configuration = new SortedDictionary<string, object?>(StringComparer.Ordinal);
        foreach (var item in request.Configuration)
        {
            configuration[item.Key] = item.Value;
        }

        configuration["externalToolName"] = request.ToolName;
        configuration["externalToolVersion"] = request.ToolVersion;
        configuration["providerBuildIdentity"] = request.ProviderBuildIdentity;
        configuration["reportHash"] = request.ReportHash;
        configuration["operator"] = request.Operator;
        configuration["runtimeSuiteBundled"] = false;

        var summary = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["externalReportImported"] = true,
            ["reportHash"] = request.ReportHash,
            ["status"] = request.Status.ToString(),
            ["tool"] = $"{request.ToolName}:{request.ToolVersion}"
        };

        return validationFramework.ImportExternalStatisticalReport(
            request.SuiteType,
            request.TargetType,
            request.TargetId,
            request.TargetVersion,
            request.TargetContentHash,
            "external-suite-import-v1",
            request.SampleSize,
            configuration,
            summary,
            request.Status,
            request.Blockers,
            request.Provenance);
    }

    public ProcessRestartRecoveryHarnessPlan CreateProcessRestartRecoveryHarnessPlan()
    {
        return new ProcessRestartRecoveryHarnessPlan(
            "p0-007.13-process-restart-harness",
            [
                OutcomeRuntimeCrashInjectionStage.LockAcquisition,
                OutcomeRuntimeCrashInjectionStage.ProviderExecution,
                OutcomeRuntimeCrashInjectionStage.CertificatePersistence,
                OutcomeRuntimeCrashInjectionStage.Completion
            ],
            [
                "claim request with durable idempotency key",
                "acquire Postgres advisory lock",
                "kill or restart process at selected checkpoint",
                "restart Game Engine",
                "replay same idempotency key",
                "verify fresh DRBG session evidence and no duplicate outcome/certificate/receipt"
            ],
            RequiresContainerKillApproval: true,
            ProductionAuthorityDisabled: true);
    }

    public static IReadOnlyCollection<HmacDrbgConformanceVector> OfficialHmacDrbgConformanceVectors()
    {
        const string source = "NIST SP 800-90A Rev.1 HMAC_DRBG algorithm conformance fixture; external CAVP/lab import remains evidence-importable.";
        return
        [
            CreateVector(
                "hmac-drbg-sha256-instantiate-generate-reseed-additional",
                CertifiedCsprngHashAlgorithm.Sha256,
                entropyLength: 48,
                nonceLength: 16,
                "85474de646a425b1f4d90a5d03965ff160d80e70062a9cfe9598cf431a8b4bad17c879f4b76c065200b48188125348de01b3dda381f3d99c1bad0d4b4211cf41",
                "9f696ce58a3b1deeb69e1c6a71f8f1f3e20db47fa07bf75bb1ba5c33e460c1d32955a1713a317503ec80ab81276e143238473877648c84e2b8b88f7b999d0fe6",
                "bf41354800e62518857152ceb0111e013454d6b35a60472d80c85eca1d2dca35",
                "4b058b4d8c300d6cfa8d337a197403621620e27140237c684629f482ab91e03b",
                source),
            CreateVector(
                "hmac-drbg-sha384-instantiate-generate-reseed-additional",
                CertifiedCsprngHashAlgorithm.Sha384,
                entropyLength: 64,
                nonceLength: 24,
                "619e9076c12a2e00a869a408bf67f371a6df3c154854bf9327b7e8fc623e7b397f81456fc6b638fc741f40f265000a56ff39d99fb2da6179c422d794087efbea",
                "6afa37d2ea9d048745ff2373a521c24d010ae4c25f9cd6b19527eb6201e495154b56841e586699ed0f8e947a5eb3d3b875c2088603ab6556fb0c3f662222c84f",
                "7aa1ec686a07c85bf4eae60eae3e684ddc5d57b9aed55989012767f244cc0321afab584bf457be0eb7efa38c3e332deb",
                "5e7aaae4c7d167586d4dd7d12215a8b7c9e280926e20dcf30878199ff6add1d33a654de7e8f6f8ff9a73551ce3ac6451",
                source),
            CreateVector(
                "hmac-drbg-sha512-instantiate-generate-reseed-additional",
                CertifiedCsprngHashAlgorithm.Sha512,
                entropyLength: 64,
                nonceLength: 32,
                "232a737ddc59d2cc7fdd98211b15c57de185eb8e6283d045ab94dfe8c490cfebb39ffbfb26754cdafb784823255d45d119b48002e058942dbf28535f452b9ef6",
                "fca5f16b6d6a37ff3f7376b459806602a915281b631f309ad605c5b764def780968e8561ea5a62a6001cc57b70e9fbd2b91cf25e4447b63f609b656c2128880a",
                "5e23d37c107a339b7459d02a04dbaa76fd76a57385be094f4f9dd896b061dd4a7e1fd2af6ce4adffbec386e036bc943b0a80a28379eae286f5fc5f5f05a5d135",
                "2f24989e66aa4fc8259fe9c8233b65caa5fb70333c515252761d8ee2a26fc63542b6e0a365a27edbd41a6698f40494fef23fc3825b39dec760b5560789f4f603",
                source)
        ];
    }

    private HmacDrbgConformanceVectorResult EvaluateVector(
        HmacDrbgConformanceVector vector,
        string providerBuildIdentity)
    {
        HmacDrbgSession? session = null;
        var first = Array.Empty<byte>();
        var second = Array.Empty<byte>();
        try
        {
            var entropy = Convert.FromHexString(vector.EntropyHex);
            var nonce = Convert.FromHexString(vector.NonceHex);
            var personalization = Convert.FromHexString(vector.PersonalizationHex);
            var additionalInput = Convert.FromHexString(vector.AdditionalInputHex);
            var reseedEntropy = Convert.FromHexString(vector.ReseedEntropyHex);
            var reseedAdditionalInput = Convert.FromHexString(vector.ReseedAdditionalInputHex);
            try
            {
                session = drbgRuntime.Instantiate(
                    vector.HashAlgorithm,
                    entropy,
                    nonce,
                    personalization,
                    vector.SecurityStrengthBits);
                first = drbgRuntime.Generate(session, vector.GenerateByteCount, additionalInput);
                drbgRuntime.Reseed(session, reseedEntropy, reseedAdditionalInput);
                second = drbgRuntime.Generate(session, vector.GenerateByteCount, additionalInput);

                var passed =
                    FixedHexEquals(first, vector.ExpectedFirstGenerateHex) &&
                    FixedHexEquals(second, vector.ExpectedPostReseedGenerateHex) &&
                    FixedHexEquals(session.Key, vector.ExpectedFinalKeyHex) &&
                    FixedHexEquals(session.Value, vector.ExpectedFinalValueHex);

                return new HmacDrbgConformanceVectorResult(
                    vector.VectorId,
                    vector.VectorVersion,
                    vector.HashAlgorithm,
                    passed,
                    providerBuildIdentity,
                    passed ? null : "Expected output or final state did not match the immutable vector.");
            }
            finally
            {
                CryptographicOperations.ZeroMemory(entropy);
                CryptographicOperations.ZeroMemory(nonce);
                CryptographicOperations.ZeroMemory(personalization);
                CryptographicOperations.ZeroMemory(additionalInput);
                CryptographicOperations.ZeroMemory(reseedEntropy);
                CryptographicOperations.ZeroMemory(reseedAdditionalInput);
            }
        }
        catch (Exception error) when (error is CryptographicException or ArgumentException or ObjectDisposedException)
        {
            return new HmacDrbgConformanceVectorResult(
                vector.VectorId,
                vector.VectorVersion,
                vector.HashAlgorithm,
                Passed: false,
                providerBuildIdentity,
                error.Message);
        }
        finally
        {
            if (session is not null)
            {
                drbgRuntime.Destroy(session);
            }

            CryptographicOperations.ZeroMemory(first);
            CryptographicOperations.ZeroMemory(second);
        }
    }

    private static HmacDrbgConformanceVector CreateVector(
        string id,
        CertifiedCsprngHashAlgorithm hashAlgorithm,
        int entropyLength,
        int nonceLength,
        string first,
        string second,
        string finalKey,
        string finalValue,
        string source)
    {
        var name = hashAlgorithm.ToString().ToLowerInvariant();
        return new HmacDrbgConformanceVector(
            id,
            HmacDrbgSuiteVersion,
            hashAlgorithm,
            256,
            SequentialHex(0, entropyLength),
            SequentialHex(0xa0, nonceLength),
            ToHex($"mosera-nist-sp800-90a-rev1-hmac-drbg-{name}"),
            ToHex($"additional-input-{name}"),
            SequentialHex(0x80, entropyLength),
            ToHex($"reseed-additional-{name}"),
            64,
            first,
            second,
            finalKey,
            finalValue,
            source);
    }

    private static bool FixedHexEquals(byte[] actual, string expectedHex)
    {
        var expected = Convert.FromHexString(expectedHex);
        try
        {
            return actual.Length == expected.Length &&
                CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(expected);
        }
    }

    private static IReadOnlyCollection<string> RequiredReadinessSections()
    {
        return
        [
            "provider readiness",
            "entropy readiness",
            "DRBG conformance",
            "statistical validation",
            "runtime persistence",
            "advisory locking",
            "recovery/provenance",
            "seed custody status",
            "signing custody status",
            "external suite evidence status",
            "production activation status"
        ];
    }

    private static string SequentialHex(int start, int count)
    {
        return string.Concat(Enumerable.Range(start, count).Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
    }

    private static string ToHex(string value)
    {
        return Convert.ToHexString(Encoding.UTF8.GetBytes(value)).ToLowerInvariant();
    }

    private static Guid DeterministicGuid(string value)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        Span<byte> bytes = stackalloc byte[16];
        hash.AsSpan(0, 16).CopyTo(bytes);
        return new Guid(bytes);
    }

    private static string HashCanonical(object value)
    {
        return $"sha256:{HashHex(JsonSerializer.Serialize(value, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false
        }))}";
    }

    private static string HashHex(string value)
    {
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    }

    private static void RequireText(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"{name} is required.", name);
        }
    }
}
