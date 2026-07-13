namespace GameEngine.Domain.Model;

public static class OutcomeProviderValidator
{
    private static readonly string[] ForbiddenProviderFields =
    [
        "rtp",
        "paytable",
        "payout",
        "settlement",
        "ledger"
    ];

    public static ValidationResult Validate(OutcomeProviderDefinitionV1 provider)
    {
        var errors = new List<ValidationError>();

        RequireText(provider.ProviderId, "providerId", errors);
        RequireText(provider.ProviderVersion, "providerVersion", errors);
        RequireText(provider.ContentHash, "contentHash", errors);

        if (provider.SupportedOutcomePrimitiveTypes.Count == 0)
        {
            errors.Add(Error("supportedOutcomePrimitiveTypes", "Outcome provider must support at least one Outcome DSL primitive."));
        }

        if (provider.CustodySupport.Count == 0)
        {
            errors.Add(Error("custodySupport", "Outcome provider must declare supported custody states."));
        }

        if (provider.ProviderType == OutcomeProviderType.SimulationTest && provider.ProductionEligible)
        {
            errors.Add(Error("productionEligible", "SIMULATION_TEST providers can never be production eligible."));
        }

        if (provider.ProductionEligible && provider.FailureMode != OutcomeProviderFailureMode.FailClosed)
        {
            errors.Add(Error("failureMode", "Production-eligible Outcome Providers must fail closed."));
        }

        ValidateCapabilityConsistency(provider, errors);
        ValidateForbiddenProviderFields(provider.EvidenceRequirements, "evidenceRequirements", errors);
        ValidateForbiddenProviderFields(provider.SigningRequirements, "signingRequirements", errors);

        return errors.Count == 0
            ? ValidationResult.Success()
            : new ValidationResult(false, errors, []);
    }

    public static ValidationResult ValidateManifestBinding(
        OutcomeProviderManifestBinding? binding,
        OutcomeProviderDefinitionV1? provider,
        bool productionMode)
    {
        var errors = new List<ValidationError>();

        if (binding is null)
        {
            errors.Add(Error("outcomeProviderBinding", "Game Manifest activation requires one exact Outcome Provider binding."));
            return new ValidationResult(false, errors, []);
        }

        RequireText(binding.ProviderId, "outcomeProviderId", errors);
        RequireText(binding.ProviderVersion, "outcomeProviderVersion", errors);
        ValidateForbiddenProviderFields(binding.ProviderEvidenceRequirements, "providerEvidenceRequirements", errors);
        ValidateForbiddenProviderFields(binding.ProviderEligibilityProfile, "providerEligibilityProfile", errors);

        if (provider is null)
        {
            errors.Add(Error("outcomeProviderBinding", "Manifest-bound Outcome Provider version was not found."));
            return new ValidationResult(false, errors, []);
        }

        if (!string.Equals(binding.ProviderId, provider.ProviderId, StringComparison.Ordinal) ||
            !string.Equals(binding.ProviderVersion, provider.ProviderVersion, StringComparison.Ordinal))
        {
            errors.Add(Error("outcomeProviderBinding", "Manifest binding must reference the exact Outcome Provider version."));
        }

        var providerValidation = Validate(provider);
        errors.AddRange(providerValidation.Errors);

        if (provider.LifecycleState != OutcomeProviderLifecycleState.Active)
        {
            errors.Add(Error("lifecycleState", "Manifest-bound Outcome Provider must be active."));
        }

        if (productionMode && !provider.ProductionEligible)
        {
            errors.Add(Error("productionEligible", "Manifest-bound Outcome Provider must be production eligible."));
        }

        if (productionMode && provider.ProviderType == OutcomeProviderType.SimulationTest)
        {
            errors.Add(Error("providerType", "SIMULATION_TEST providers cannot be production authority."));
        }

        var missingPrimitives = binding.ProviderCapabilityRequirements
            .Except(provider.SupportedOutcomePrimitiveTypes)
            .ToArray();
        if (missingPrimitives.Length > 0)
        {
            errors.Add(Error(
                "providerCapabilityRequirements",
                $"Outcome Provider does not support required primitives: {string.Join(", ", missingPrimitives)}."));
        }

        if (binding.PlayerVerificationReceiptRequired && !provider.CapabilityMarkers.SupportsPlayerVerificationReceipt)
        {
            errors.Add(Error(
                "playerVerificationReceiptRequired",
                "Manifest cannot require player verification receipts unless the Outcome Provider supports them."));
        }

        return errors.Count == 0
            ? ValidationResult.Success()
            : new ValidationResult(false, errors, []);
    }

    private static void ValidateCapabilityConsistency(OutcomeProviderDefinitionV1 provider, ICollection<ValidationError> errors)
    {
        var capabilities = provider.CapabilityMarkers;

        if (capabilities.GeneratesOutcomes && capabilities.IngestsExternalOutcomes)
        {
            errors.Add(Error("capabilityMarkers", "An Outcome Provider cannot both generate outcomes and ingest external outcomes."));
        }

        switch (provider.ProviderType)
        {
            case OutcomeProviderType.CertifiedCsprng:
            case OutcomeProviderType.ProvablyFair:
            case OutcomeProviderType.SimulationTest:
                if (!capabilities.GeneratesOutcomes || capabilities.IngestsExternalOutcomes)
                {
                    errors.Add(Error("capabilityMarkers", $"{provider.ProviderType} providers must generate outcomes and must not be external-ingestion-only."));
                }
                break;
            case OutcomeProviderType.ExternalOfficialResult:
                if (!capabilities.IngestsExternalOutcomes || capabilities.GeneratesOutcomes || !capabilities.SupportsExternalSourceEvidence)
                {
                    errors.Add(Error("capabilityMarkers", "External official result providers must ingest external outcomes and provide external source evidence."));
                }
                break;
            case OutcomeProviderType.PhysicalDrawResult:
                if (!capabilities.IngestsExternalOutcomes || capabilities.GeneratesOutcomes || !capabilities.SupportsPhysicalDrawEvidence)
                {
                    errors.Add(Error("capabilityMarkers", "Physical draw result providers must ingest physical draw outcomes and provide physical draw evidence."));
                }
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(provider.ProviderType), provider.ProviderType, "Unsupported Outcome Provider type.");
        }

        if (capabilities.SupportsPlayerVerificationReceipt && provider.ProviderType != OutcomeProviderType.ProvablyFair)
        {
            errors.Add(Error("capabilityMarkers", "Player verification receipts are only valid for Provably Fair providers in v1."));
        }
    }

    private static void ValidateForbiddenProviderFields(
        IReadOnlyDictionary<string, object?> values,
        string field,
        ICollection<ValidationError> errors)
    {
        foreach (var key in FlattenKeys(values))
        {
            if (ForbiddenProviderFields.Any(forbidden => key.Contains(forbidden, StringComparison.OrdinalIgnoreCase)))
            {
                errors.Add(Error(field, "Outcome Provider contracts must not contain RTP, paytable, payout, settlement, or ledger fields."));
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

    private static ValidationError Error(string field, string message)
    {
        return new ValidationError(ValidationCode.InvalidConfiguration, field, message, ValidationSeverity.Error);
    }
}
