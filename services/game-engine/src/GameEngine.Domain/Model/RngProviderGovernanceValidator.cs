namespace GameEngine.Domain.Model;

public static class RngProviderGovernanceValidator
{
    public static ValidationResult Validate(RngProviderDefinitionV1 provider)
    {
        var errors = new List<ValidationError>();

        RequireText(provider.ProviderId, "providerId", errors);
        RequireText(provider.ProviderVersion, "providerVersion", errors);
        RequireText(provider.ContentHash, "contentHash", errors);

        if (provider.AlgorithmReferences.Count == 0)
        {
            errors.Add(Error("algorithmReferences", "RNG provider must declare at least one algorithm reference."));
        }

        if (provider.ProviderType is RngProviderType.TestDeterministic or RngProviderType.Simulation
            && provider.ProductionEligible)
        {
            errors.Add(Error("productionEligible", "TEST_DETERMINISTIC and SIMULATION providers can never be production eligible."));
        }

        if (provider.ProductionEligible)
        {
            if (provider.HealthTestCapabilities.Count == 0)
            {
                errors.Add(Error("healthTestCapabilities", "Production-eligible RNG providers require health-test capabilities."));
            }

            if (provider.FailureMode != RngProviderFailureMode.FailClosed)
            {
                errors.Add(Error("failureMode", "Production-eligible RNG providers must fail closed."));
            }
        }

        return errors.Count == 0
            ? ValidationResult.Success()
            : new ValidationResult(false, errors, []);
    }

    public static ValidationResult Validate(RngProviderEvidence evidence)
    {
        var errors = new List<ValidationError>();

        RequireText(evidence.ProviderId, "providerId", errors);
        RequireText(evidence.ProviderVersion, "providerVersion", errors);
        RequireText(evidence.EntropySourceReference, "entropySourceReference", errors);
        RequireText(evidence.CanonicalEvidenceHash, "canonicalEvidenceHash", errors);

        if (evidence.HealthTestResult is RngHealthTestResult.Missing or RngHealthTestResult.Failed)
        {
            errors.Add(Error("healthTestResult", "RNG provider evidence requires passing health-test evidence."));
        }

        if (evidence.ContinuousTestResult is RngHealthTestResult.Missing or RngHealthTestResult.Failed)
        {
            errors.Add(Error("continuousTestResult", "RNG provider evidence requires passing continuous-test evidence."));
        }

        return errors.Count == 0
            ? ValidationResult.Success()
            : new ValidationResult(false, errors, []);
    }

    private static void RequireText(string value, string field, ICollection<ValidationError> errors)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            errors.Add(Error(field, $"{field} is required."));
        }
    }

    private static ValidationError Error(string field, string message)
    {
        return new ValidationError(ValidationCode.InvalidConfiguration, field, message, ValidationSeverity.Error);
    }
}
