namespace GameEngine.Domain.Model;

public static class ExternalOfficialResultValidator
{
    private static readonly StringComparer Ordinal = StringComparer.Ordinal;

    public static ValidationResult ValidateSource(ExternalResultSourceDefinition source)
    {
        var errors = new List<ValidationError>();

        RequireText(source.SourceId, "sourceId", errors);
        RequireText(source.SourceVersion, "sourceVersion", errors);
        RequireText(source.SourceName, "sourceName", errors);
        RequireText(source.SourceTimezone, "sourceTimezone", errors);
        RequireHash(source.ContentHash, "contentHash", errors);

        if (source.ProductionEligible && source.FailureMode != ExternalResultFailureMode.FailClosed)
        {
            errors.Add(Error("failureMode", "Production-eligible external result sources must fail closed."));
        }

        if (source.ProductionEligible && source.LifecycleState != ExternalResultSourceLifecycleState.Active)
        {
            errors.Add(Error("lifecycleState", "Production-eligible external result sources must be active."));
        }

        if (source.SupportedGameIdentifiers.Count == 0)
        {
            errors.Add(Error("supportedGameIdentifiers", "External result source must support at least one game identifier."));
        }

        if (source.SupportedResultSchemas.Count == 0)
        {
            errors.Add(Error("supportedResultSchemas", "External result source must support at least one result schema."));
        }

        if (source.SignatureRequirement != ExternalResultSignatureRequirement.NotRequired &&
            string.IsNullOrWhiteSpace(source.VerificationKeyId))
        {
            errors.Add(Error("verificationKeyId", "Signature-required sources must declare a verification key reference."));
        }

        if (source.SourceType == ExternalResultSourceType.OfficialApi &&
            source.TransportSecurityRequirement == ExternalResultTransportSecurityRequirement.OfflineSignedFile)
        {
            errors.Add(Error("transportSecurityRequirement", "OFFICIAL_API sources cannot use offline signed-file transport."));
        }

        if (source.SourceType == ExternalResultSourceType.SignedFileFeed &&
            source.SignatureRequirement == ExternalResultSignatureRequirement.NotRequired)
        {
            errors.Add(Error("signatureRequirement", "SIGNED_FILE_FEED sources must require signatures."));
        }

        if (HasForbiddenField(source.EndpointReferenceMetadata))
        {
            errors.Add(Error("endpointReferenceMetadata", "External result source metadata must not contain RTP, paytable, payout, settlement, ledger, or financial logic."));
        }

        if (HasSecretField(source.EndpointReferenceMetadata))
        {
            errors.Add(Error("endpointReferenceMetadata", "External result source metadata must not persist credentials or secrets."));
        }

        return errors.Count == 0 ? ValidationResult.Success() : ValidationResult.Failure(errors.ToArray());
    }

    public static ValidationResult ValidateEnvelope(
        ExternalOfficialResultEnvelope envelope,
        ExternalResultSourceDefinition? source,
        OutcomeProviderDefinitionV1 provider,
        OutcomeProviderRuntimeRequest request,
        DateTimeOffset now)
    {
        var errors = new List<ValidationError>();

        if (source is null)
        {
            errors.Add(Error("source", "External result source is unknown."));
            return ValidationResult.Failure(errors.ToArray());
        }

        var sourceValidation = ValidateSource(source);
        errors.AddRange(sourceValidation.Errors);

        if (source.LifecycleState != ExternalResultSourceLifecycleState.Active)
        {
            errors.Add(Error("source.lifecycleState", "External result source is not active."));
        }

        if (source.VerificationKeyRevokedAt is not null && source.VerificationKeyRevokedAt <= envelope.ReceivedTimestamp)
        {
            errors.Add(Error("source.verificationKey", "External result source verification key is revoked."));
        }

        if (envelope.ProviderId != provider.ProviderId || envelope.ProviderVersion != provider.ProviderVersion)
        {
            errors.Add(Error("provider", "External result provider envelope does not match the manifest-bound provider."));
        }

        if (envelope.ManifestId != request.GameManifestId || envelope.ManifestVersion != request.GameManifestVersion)
        {
            errors.Add(Error("manifest", "External result manifest identity does not match the runtime request."));
        }

        if (!source.SupportedGameIdentifiers.Contains(envelope.GameIdentifier, Ordinal))
        {
            errors.Add(Error("gameIdentifier", "External result source does not support the supplied game identifier."));
        }

        if (!source.SupportedResultSchemas.Contains(envelope.SchemaType))
        {
            errors.Add(Error("schemaType", "External result source does not support the supplied result schema."));
        }

        if (string.IsNullOrWhiteSpace(envelope.DrawingId) || string.IsNullOrWhiteSpace(envelope.ExternalDrawId))
        {
            errors.Add(Error("drawingId", "External result envelope must include drawing identity."));
        }

        if (!LooksLikeHash(envelope.SourcePayloadHash))
        {
            errors.Add(Error("sourcePayloadHash", "External result source payload hash must use a supported hash prefix."));
        }

        if (source.SignatureRequirement != ExternalResultSignatureRequirement.NotRequired &&
            string.IsNullOrWhiteSpace(envelope.SourceSignature))
        {
            errors.Add(Error("sourceSignature", "External result envelope is unsigned but the source requires signatures."));
        }

        if (source.SignatureRequirement == ExternalResultSignatureRequirement.SignedEnvelopeRequired &&
            source.AuthenticationMethod != ExternalResultAuthenticationMethod.SignedPayload)
        {
            errors.Add(Error("authenticationMethod", "Signed envelope requirements must use signed-payload authentication."));
        }

        if (source.PublicationDelayPolicy.FutureTimestampsRejected &&
            (envelope.SourceTimestamp - now) > source.PublicationDelayPolicy.MaxClockSkew)
        {
            errors.Add(Error("sourceTimestamp", "External result source timestamp is future-dated beyond policy."));
        }

        if (source.PublicationDelayPolicy.MaxResultAge is { } maxAge &&
            (now - envelope.SourceTimestamp) > maxAge)
        {
            errors.Add(Error("sourceTimestamp", "External result is stale under the source publication policy."));
        }

        if (HasForbiddenField(envelope.ResultPayload))
        {
            errors.Add(Error("resultPayload", "External result payload must not contain RTP, paytable, payout, settlement, ledger, or financial logic."));
        }

        if (HasSecretField(envelope.ResultPayload))
        {
            errors.Add(Error("resultPayload", "External result payload must not contain credentials or secrets."));
        }

        return errors.Count == 0 ? ValidationResult.Success() : ValidationResult.Failure(errors.ToArray());
    }

    public static ValidationResult ValidateProviderCompatibility(OutcomeProviderDefinitionV1 provider)
    {
        var errors = new List<ValidationError>();

        if (provider.ProviderType != OutcomeProviderType.ExternalOfficialResult)
        {
            errors.Add(Error("providerType", "External Official Result runtime requires an ExternalOfficialResult provider."));
        }

        if (!provider.CapabilityMarkers.IngestsExternalOutcomes ||
            !provider.CapabilityMarkers.SupportsExternalSourceEvidence ||
            provider.CapabilityMarkers.GeneratesOutcomes)
        {
            errors.Add(Error("capabilityMarkers", "External Official Result providers must ingest external outcomes, provide source evidence, and never generate outcomes."));
        }

        return errors.Count == 0 ? ValidationResult.Success() : ValidationResult.Failure(errors.ToArray());
    }

    public static bool HasForbiddenField(IReadOnlyDictionary<string, object?> payload)
    {
        return payload.Any(pair =>
            ContainsForbiddenToken(pair.Key) ||
            (pair.Value is IReadOnlyDictionary<string, object?> nested && HasForbiddenField(nested)));
    }

    public static bool HasSecretField(IReadOnlyDictionary<string, object?> payload)
    {
        return payload.Any(pair =>
            ContainsSecretToken(pair.Key) ||
            (pair.Value is IReadOnlyDictionary<string, object?> nested && HasSecretField(nested)));
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
        if (!LooksLikeHash(value))
        {
            errors.Add(Error(field, $"{field} must use sha256, sha384, or sha512 prefix."));
        }
    }

    private static bool LooksLikeHash(string value)
    {
        return value.StartsWith("sha256:", StringComparison.Ordinal) ||
            value.StartsWith("sha384:", StringComparison.Ordinal) ||
            value.StartsWith("sha512:", StringComparison.Ordinal);
    }

    private static bool ContainsForbiddenToken(string key)
    {
        return key.Contains("rtp", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("paytable", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("payout", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("settlement", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("ledger", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("financial", StringComparison.OrdinalIgnoreCase);
    }

    private static bool ContainsSecretToken(string key)
    {
        return key.Contains("secret", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("credential", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("password", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("token", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("apiKey", StringComparison.OrdinalIgnoreCase);
    }

    private static ValidationError Error(string field, string message)
    {
        return new ValidationError(ValidationCode.InvalidConfiguration, field, message, ValidationSeverity.Error);
    }
}
