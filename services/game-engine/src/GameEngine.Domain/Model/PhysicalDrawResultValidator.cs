namespace GameEngine.Domain.Model;

public static class PhysicalDrawResultValidator
{
    private static readonly string[] ForbiddenFields =
    [
        "rtp",
        "paytable",
        "payout",
        "settlement",
        "ledger",
        "wallet",
        "cashier",
        "stake",
        "odds",
        "prizeAmount",
        "money"
    ];

    public static ValidationResult ValidateAuthority(PhysicalDrawAuthorityDefinition authority)
    {
        var errors = new List<ValidationError>();
        RequireText(authority.AuthorityId, "authorityId", errors);
        RequireText(authority.AuthorityVersion, "authorityVersion", errors);
        RequireText(authority.AuthorityName, "authorityName", errors);
        RequireText(authority.Country, "country", errors);
        RequireText(authority.Operator, "operator", errors);
        RequireText(authority.Facility, "facility", errors);
        RequireText(authority.DrawMachineIdentifier, "drawMachineIdentifier", errors);
        RequireText(authority.BallSetIdentifier, "ballSetIdentifier", errors);
        RequireText(authority.ApprovedProceduresVersion, "approvedProceduresVersion", errors);
        RequireText(authority.ContentHash, "contentHash", errors);

        if (authority.SupportedGameIdentifiers.Count == 0)
        {
            errors.Add(Error("supportedGames", "Physical draw authority must support at least one game."));
        }

        if (authority.SupportedResultSchemas.Count == 0)
        {
            errors.Add(Error("supportedResultSchemas", "Physical draw authority must support at least one result schema."));
        }

        if (authority.ProductionEligible && authority.FailureMode != PhysicalDrawFailureMode.FailClosed)
        {
            errors.Add(Error("failureMode", "Production-eligible physical draw authorities must fail closed."));
        }

        if (authority.ProductionEligible && authority.LifecycleState != PhysicalDrawAuthorityLifecycleState.Active)
        {
            errors.Add(Error("lifecycleState", "Production-eligible physical draw authorities must be active."));
        }

        if (authority.WitnessPolicy.MinimumWitnessCount < 1)
        {
            errors.Add(Error("witnessPolicy", "Physical draw witness policy must require at least one witness."));
        }

        return errors.Count == 0 ? ValidationResult.Success() : ValidationResult.Failure(errors.ToArray());
    }

    public static ValidationResult ValidateProviderCompatibility(OutcomeProviderDefinitionV1 provider)
    {
        var errors = new List<ValidationError>();
        if (provider.ProviderType != OutcomeProviderType.PhysicalDrawResult)
        {
            errors.Add(Error("providerType", "Physical Draw runtime requires a PhysicalDrawResult provider."));
        }

        if (provider.CapabilityMarkers.GeneratesOutcomes ||
            !provider.CapabilityMarkers.IngestsExternalOutcomes ||
            !provider.CapabilityMarkers.SupportsPhysicalDrawEvidence)
        {
            errors.Add(Error("capabilityMarkers", "Physical Draw providers must ingest physical outcomes and provide physical draw evidence."));
        }

        if (provider.CapabilityMarkers.SupportsExternalSourceEvidence)
        {
            errors.Add(Error("capabilityMarkers", "Physical Draw providers must not masquerade as external official source providers."));
        }

        ValidateNoForbiddenFields(provider.EvidenceRequirements, "evidenceRequirements", errors);
        ValidateNoForbiddenFields(provider.SigningRequirements, "signingRequirements", errors);
        return errors.Count == 0 ? ValidationResult.Success() : ValidationResult.Failure(errors.ToArray());
    }

    public static ValidationResult ValidateEnvelope(
        PhysicalDrawResultEnvelope envelope,
        PhysicalDrawAuthorityDefinition? authority,
        OutcomeProviderDefinitionV1 provider,
        OutcomeProviderRuntimeRequest request,
        DateTimeOffset now)
    {
        var errors = new List<ValidationError>();
        if (authority is null)
        {
            errors.Add(Error("authority", "Physical draw authority is unknown."));
        }
        else
        {
            if (authority.LifecycleState != PhysicalDrawAuthorityLifecycleState.Active)
            {
                errors.Add(Error("authority", "Physical draw authority is not active."));
            }

            if (authority.FailureMode != PhysicalDrawFailureMode.FailClosed)
            {
                errors.Add(Error("failureMode", "Physical draw authority must fail closed."));
            }

            if (!authority.SupportedGameIdentifiers.Contains(envelope.GameIdentifier, StringComparer.Ordinal))
            {
                errors.Add(Error("gameIdentifier", "Physical draw authority does not support the supplied game identifier."));
            }

            if (!authority.SupportedResultSchemas.Contains(envelope.SchemaType))
            {
                errors.Add(Error("schemaType", "Physical draw authority does not support the supplied result schema."));
            }

            if (!string.Equals(authority.DrawMachineIdentifier, envelope.MachineId, StringComparison.Ordinal))
            {
                errors.Add(Error("machineId", "Physical draw machine does not match approved authority equipment."));
            }

            if (!string.Equals(authority.BallSetIdentifier, envelope.BallSetId, StringComparison.Ordinal))
            {
                errors.Add(Error("ballSetId", "Physical draw ball set does not match approved authority equipment."));
            }

            ValidateWitnesses(envelope.WitnessEvidence, authority.WitnessPolicy, errors);
            ValidateTimestamps(envelope, authority.TimestampPolicy, now, errors);
        }

        if (provider.ProviderType != OutcomeProviderType.PhysicalDrawResult ||
            envelope.ProviderId != provider.ProviderId ||
            envelope.ProviderVersion != provider.ProviderVersion)
        {
            errors.Add(Error("provider", "Physical draw event provider does not match the manifest-bound provider."));
        }

        if (envelope.ManifestId != request.GameManifestId ||
            envelope.ManifestVersion != request.GameManifestVersion)
        {
            errors.Add(Error("manifest", "Physical draw event manifest does not match the runtime request."));
        }

        if (envelope.AuthorityId.Length == 0 || envelope.AuthorityVersion.Length == 0)
        {
            errors.Add(Error("authority", "Physical draw event must reference an authority id and version."));
        }

        if (envelope.DrawIdentifier.Length == 0 || envelope.OfficialReportReference.Length == 0)
        {
            errors.Add(Error("drawIdentifier", "Physical draw event must include draw and official report references."));
        }

        ValidateEquipment(envelope.EquipmentReferences, errors);
        ValidateNoForbiddenFields(envelope.ResultPayload, "resultPayload", errors);
        return errors.Count == 0 ? ValidationResult.Success() : ValidationResult.Failure(errors.ToArray());
    }

    private static void ValidateWitnesses(
        PhysicalDrawWitnessEvidence witnesses,
        PhysicalDrawWitnessPolicy policy,
        ICollection<ValidationError> errors)
    {
        var count = 0;
        if (!string.IsNullOrWhiteSpace(witnesses.OperatorIdentity))
        {
            count++;
        }

        if (!string.IsNullOrWhiteSpace(witnesses.PrimaryWitness))
        {
            count++;
        }

        if (!string.IsNullOrWhiteSpace(witnesses.SecondaryWitness))
        {
            count++;
        }

        if (!string.IsNullOrWhiteSpace(witnesses.RegulatorWitness))
        {
            count++;
        }

        if (policy.OperatorRequired && string.IsNullOrWhiteSpace(witnesses.OperatorIdentity))
        {
            errors.Add(Error("witnesses", "Physical draw operator witness is required."));
        }

        if (policy.PrimaryWitnessRequired && string.IsNullOrWhiteSpace(witnesses.PrimaryWitness))
        {
            errors.Add(Error("witnesses", "Physical draw primary witness is required."));
        }

        if (policy.SecondaryWitnessRequired && string.IsNullOrWhiteSpace(witnesses.SecondaryWitness))
        {
            errors.Add(Error("witnesses", "Physical draw secondary witness is required."));
        }

        if (policy.RegulatorWitnessRequired && string.IsNullOrWhiteSpace(witnesses.RegulatorWitness))
        {
            errors.Add(Error("witnesses", "Physical draw regulator witness is required."));
        }

        if (count < policy.MinimumWitnessCount)
        {
            errors.Add(Error("witnesses", "Physical draw event does not satisfy minimum witness count."));
        }
    }

    private static void ValidateEquipment(
        IReadOnlyCollection<PhysicalDrawEquipmentReference> equipment,
        ICollection<ValidationError> errors)
    {
        if (equipment.Count == 0)
        {
            errors.Add(Error("equipment", "Physical draw event requires equipment evidence."));
            return;
        }

        foreach (var item in equipment)
        {
            if (!item.Approved || item.LifecycleState != PhysicalDrawEquipmentLifecycleState.Active)
            {
                errors.Add(Error("equipment", "Physical draw equipment must be approved and active."));
            }

            RequireText(item.EquipmentId, "equipmentId", errors);
            RequireText(item.InspectionReference, "inspectionReference", errors);
            RequireText(item.MaintenanceReference, "maintenanceReference", errors);
            RequireText(item.CalibrationReference, "calibrationReference", errors);
            RequireText(item.SealReference, "sealReference", errors);
        }
    }

    private static void ValidateTimestamps(
        PhysicalDrawResultEnvelope envelope,
        PhysicalDrawTimestampPolicy policy,
        DateTimeOffset now,
        ICollection<ValidationError> errors)
    {
        if (policy.FutureTimestampsRejected && envelope.DrawTimestamp > now.Add(policy.MaxClockSkew))
        {
            errors.Add(Error("drawTimestamp", "Physical draw timestamp is future-dated beyond policy."));
        }

        if (policy.MaxDrawAge is not null && envelope.DrawTimestamp < now.Subtract(policy.MaxDrawAge.Value))
        {
            errors.Add(Error("drawTimestamp", "Physical draw timestamp is stale under policy."));
        }

        if (envelope.ReceivedTimestamp < envelope.DrawTimestamp)
        {
            errors.Add(Error("receivedTimestamp", "Physical draw received timestamp cannot precede draw timestamp."));
        }
    }

    private static void ValidateNoForbiddenFields(
        IReadOnlyDictionary<string, object?> payload,
        string field,
        ICollection<ValidationError> errors)
    {
        foreach (var key in payload.Keys)
        {
            if (ForbiddenFields.Any(forbidden => key.Contains(forbidden, StringComparison.OrdinalIgnoreCase)))
            {
                errors.Add(Error(field, "Physical draw evidence must not contain RTP, paytable, payout, settlement, ledger, wallet, cashier, or money fields."));
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
