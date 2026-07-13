namespace GameEngine.Domain.Model;

public static class CertifiedCsprngProviderValidator
{
    private static readonly CertifiedSamplingCapability[] RequiredSamplingCapabilities =
    [
        CertifiedSamplingCapability.RejectionSampling,
        CertifiedSamplingCapability.FisherYatesShuffle,
        CertifiedSamplingCapability.UniqueNumberSelection,
        CertifiedSamplingCapability.IntegerRationalWeightedSelection
    ];

    private static readonly string[] ForbiddenSecretFields =
    [
        "rawSeed",
        "seedMaterial",
        "rawEntropy",
        "entropyBytes",
        "drbgState",
        "internalState",
        "secretState",
        "unreducedSecret"
    ];

    public static ValidationResult Validate(EntropyProviderDefinitionV1 provider)
    {
        var errors = new List<ValidationError>();

        RequireText(provider.ProviderId, "providerId", errors);
        RequireText(provider.ProviderVersion, "providerVersion", errors);
        RequireText(provider.PlatformRuntimeReference, "platformRuntimeReference", errors);
        RequireHash(provider.ContentHash, "contentHash", errors);

        if (provider.MinimumEntropyBits < 128)
        {
            errors.Add(Error("minimumEntropyBits", "Entropy providers require at least 128 bits of declared entropy."));
        }

        if (provider.ProductionEligible && provider.ProviderType == EntropyProviderType.TestSimulation)
        {
            errors.Add(Error("productionEligible", "TEST/SIMULATION entropy providers can never be production eligible."));
        }

        if (provider.ProductionEligible && provider.FailureMode != CertifiedCsprngFailureMode.FailClosed)
        {
            errors.Add(Error("failureMode", "Production entropy providers must fail closed."));
        }

        if (provider.ProductionEligible && provider.HealthTestCapabilities.Count == 0)
        {
            errors.Add(Error("healthTestCapabilities", "Production entropy providers require health-test capabilities."));
        }

        RejectForbiddenSecretFields(provider.EntropySourceMetadata, "entropySourceMetadata", errors);

        return ToResult(errors);
    }

    public static ValidationResult Validate(CertifiedCsprngProviderDefinitionV1 provider)
    {
        var errors = new List<ValidationError>();

        RequireText(provider.ProviderId, "providerId", errors);
        RequireText(provider.ProviderVersion, "providerVersion", errors);
        RequireText(provider.OutcomeProviderId, "outcomeProviderId", errors);
        RequireText(provider.OutcomeProviderVersion, "outcomeProviderVersion", errors);
        RequireText(provider.LinkedRngProviderId, "linkedRngProviderId", errors);
        RequireText(provider.LinkedRngProviderVersion, "linkedRngProviderVersion", errors);
        RequireHash(provider.ContentHash, "contentHash", errors);

        if (provider.SecurityStrengthBits < 128)
        {
            errors.Add(Error("securityStrengthBits", "Certified CSPRNG providers require at least 128-bit security strength."));
        }

        if (provider.ProductionEligible && provider.FailureMode != CertifiedCsprngFailureMode.FailClosed)
        {
            errors.Add(Error("failureMode", "Production Certified CSPRNG providers must fail closed."));
        }

        if (provider.ProductionEligible &&
            (!provider.StartupSelfTestSupported || !provider.KnownAnswerTestSupported || !provider.ContinuousHealthTestSupported))
        {
            errors.Add(Error("healthTests", "Production Certified CSPRNG providers require startup, known-answer, and continuous health tests."));
        }

        var missingSampling = RequiredSamplingCapabilities
            .Except(provider.SamplingCapabilities)
            .ToArray();
        if (provider.ProductionEligible && missingSampling.Length > 0)
        {
            errors.Add(Error(
                "samplingCapabilities",
                $"Production Certified CSPRNG providers require unbiased sampling capabilities: {string.Join(", ", missingSampling)}."));
        }

        RejectForbiddenSecretFields(provider.ReseedPolicy, "reseedPolicy", errors);
        RejectForbiddenSecretFields(provider.SessionIsolationPolicy, "sessionIsolationPolicy", errors);
        RejectForbiddenSecretFields(provider.ZeroizationPolicy, "zeroizationPolicy", errors);

        return ToResult(errors);
    }

    public static ValidationResult Validate(DrbgSessionEvidence evidence)
    {
        var errors = new List<ValidationError>();

        RequireText(evidence.DrawRequestScope, "drawRequestScope", errors);
        RequireText(evidence.ProviderId, "providerId", errors);
        RequireText(evidence.ProviderVersion, "providerVersion", errors);
        RequireText(evidence.EntropyProviderId, "entropyProviderId", errors);
        RequireText(evidence.EntropyProviderVersion, "entropyProviderVersion", errors);
        RequireHash(evidence.PersonalizationStringHash, "personalizationStringHash", errors);
        RequireHash(evidence.NonceHash, "nonceHash", errors);
        RequireHash(evidence.SeedCommitmentHash, "seedCommitmentHash", errors);
        RequireHash(evidence.CanonicalEvidenceHash, "canonicalEvidenceHash", errors);

        if (evidence.ReseedCounter < 0)
        {
            errors.Add(Error("reseedCounter", "Reseed counter cannot be negative."));
        }

        if (evidence.DestroyedZeroizedAt < evidence.GeneratedAt)
        {
            errors.Add(Error("destroyedZeroizedAt", "DRBG session evidence must show destruction/zeroization after generation."));
        }

        if (evidence.StartupSelfTestResult is DrbgEvidenceTestResult.Failed or DrbgEvidenceTestResult.Missing ||
            evidence.KnownAnswerTestResult is DrbgEvidenceTestResult.Failed or DrbgEvidenceTestResult.Missing ||
            evidence.ContinuousTestResult is DrbgEvidenceTestResult.Failed or DrbgEvidenceTestResult.Missing)
        {
            errors.Add(Error("healthTestResults", "DRBG session evidence requires passing startup, KAT, and continuous health tests."));
        }

        return ToResult(errors);
    }

    private static void RejectForbiddenSecretFields(
        IReadOnlyDictionary<string, object?> values,
        string field,
        ICollection<ValidationError> errors)
    {
        foreach (var key in FlattenKeys(values))
        {
            if (ForbiddenSecretFields.Any(secret => key.Contains(secret, StringComparison.OrdinalIgnoreCase)))
            {
                errors.Add(Error(field, "Raw entropy, raw seed material, and internal DRBG state must never be persisted."));
                return;
            }
        }
    }

    private static IEnumerable<string> FlattenKeys(IReadOnlyDictionary<string, object?> values)
    {
        foreach (var (key, value) in values)
        {
            yield return key;

            if (value is IReadOnlyDictionary<string, object?> nested)
            {
                foreach (var nestedKey in FlattenKeys(nested))
                {
                    yield return nestedKey;
                }
            }
        }
    }

    private static void RequireText(string value, string field, ICollection<ValidationError> errors)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            errors.Add(Error(field, $"{field} is required."));
        }
    }

    private static void RequireHash(string value, string field, ICollection<ValidationError> errors)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            !(value.StartsWith("sha256:", StringComparison.Ordinal) ||
              value.StartsWith("sha384:", StringComparison.Ordinal) ||
              value.StartsWith("sha512:", StringComparison.Ordinal)))
        {
            errors.Add(Error(field, $"{field} must use a sha256:, sha384:, or sha512: prefix."));
        }
    }

    private static ValidationResult ToResult(IReadOnlyCollection<ValidationError> errors)
    {
        return errors.Count == 0
            ? ValidationResult.Success()
            : new ValidationResult(false, errors, []);
    }

    private static ValidationError Error(string field, string message)
    {
        return new ValidationError(ValidationCode.InvalidConfiguration, field, message, ValidationSeverity.Error);
    }
}
