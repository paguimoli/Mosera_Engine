namespace GameEngine.Domain.Model;

public static class ProvablyFairProviderValidator
{
    private static readonly string[] ForbiddenSeedFields =
    [
        "serverSeed",
        "plaintextSeed",
        "rawSeed",
        "seedMaterial",
        "secretSeed"
    ];

    public static ValidationResult Validate(ProvablyFairProviderDefinitionV1 provider)
    {
        var errors = new List<ValidationError>();

        RequireText(provider.ProviderId, "providerId", errors);
        RequireText(provider.ProviderVersion, "providerVersion", errors);
        RequireText(provider.OutcomeProviderId, "outcomeProviderId", errors);
        RequireText(provider.OutcomeProviderVersion, "outcomeProviderVersion", errors);
        RequireHash(provider.ContentHash, "contentHash", errors);

        if (!provider.ReceiptSupport)
        {
            errors.Add(Error("receiptSupport", "Provably Fair providers must support player verification receipts."));
        }

        if (provider.CommitmentLifetime <= TimeSpan.Zero)
        {
            errors.Add(Error("commitmentLifetime", "Commitment lifetime must be positive."));
        }

        ValidateClientSeedPolicy(provider.ClientSeedPolicy, errors);
        ValidatePolicy(provider.ServerSeedPolicy, "serverSeedPolicy", errors);
        ValidatePolicy(provider.NoncePolicy, "noncePolicy", errors);
        ValidateRevealPolicy(provider.RevealPolicy, errors);

        return ToResult(errors);
    }

    public static ValidationResult Validate(ProvablyFairServerSeedCommitment commitment)
    {
        var errors = new List<ValidationError>();

        RequireText(commitment.ProviderId, "providerId", errors);
        RequireText(commitment.ProviderVersion, "providerVersion", errors);
        RequireHash(commitment.CommitmentHash, "commitmentHash", errors);
        RequireHash(commitment.ContentHash, "contentHash", errors);
        ValidatePolicy(commitment.RotationPolicy, "rotationPolicy", errors);

        if (commitment.ActivationTimestamp is not null &&
            commitment.ActivationTimestamp < commitment.SeedGenerationTimestamp)
        {
            errors.Add(Error("activationTimestamp", "Seed activation cannot precede seed generation."));
        }

        if (commitment.RetirementTimestamp is not null &&
            commitment.ActivationTimestamp is not null &&
            commitment.RetirementTimestamp < commitment.ActivationTimestamp)
        {
            errors.Add(Error("retirementTimestamp", "Seed retirement cannot precede activation."));
        }

        return ToResult(errors);
    }

    public static ValidationResult Validate(ProvablyFairNonceSequence nonce)
    {
        var errors = new List<ValidationError>();

        RequireText(nonce.ProviderId, "providerId", errors);
        RequireText(nonce.ProviderVersion, "providerVersion", errors);
        RequireText(nonce.ProviderScope, "providerScope", errors);
        RequireText(nonce.UniquenessScope, "uniquenessScope", errors);
        RequireHash(nonce.ContentHash, "contentHash", errors);

        if (nonce.Nonce < 0)
        {
            errors.Add(Error("nonce", "Nonce cannot be negative."));
        }

        ValidatePolicy(nonce.NoncePolicy, "noncePolicy", errors);

        return ToResult(errors);
    }

    public static ValidationResult Validate(ProvablyFairVerificationReceipt receipt)
    {
        var errors = new List<ValidationError>();

        RequireText(receipt.WagerReference, "wagerReference", errors);
        RequireHash(receipt.OutcomeCertificateHash, "outcomeCertificateHash", errors);
        RequireText(receipt.ProviderId, "providerId", errors);
        RequireText(receipt.ProviderVersion, "providerVersion", errors);
        RequireHash(receipt.ServerCommitment, "serverCommitment", errors);
        RequireText(receipt.ClientSeed, "clientSeed", errors);
        RequireHash(receipt.ReceiptHash, "receiptHash", errors);

        if (receipt.Nonce < 0)
        {
            errors.Add(Error("nonce", "Nonce cannot be negative."));
        }

        if (receipt.RevealedServerSeedPlaceholder is not null &&
            LooksLikePlaintextSeed(receipt.RevealedServerSeedPlaceholder))
        {
            errors.Add(Error("revealedServerSeedPlaceholder", "Receipts must not expose unrevealed server seed material."));
        }

        ValidatePolicy(receipt.CanonicalVerificationPayload, "canonicalVerificationPayload", errors);
        ValidatePolicy(receipt.QrExportPayload, "qrExportPayload", errors);

        return ToResult(errors);
    }

    private static void ValidateClientSeedPolicy(
        ProvablyFairClientSeedPolicy policy,
        ICollection<ValidationError> errors)
    {
        if (policy.MaximumLength <= 0)
        {
            errors.Add(Error("clientSeedPolicy.maximumLength", "Client seed maximum length must be positive."));
        }

        if (policy.ValidationRules.Count == 0)
        {
            errors.Add(Error("clientSeedPolicy.validationRules", "Client seed policy requires validation rules."));
        }

        if (policy.CanonicalizationRules.Count == 0)
        {
            errors.Add(Error("clientSeedPolicy.canonicalizationRules", "Client seed policy requires canonicalization rules."));
        }
    }

    private static void ValidateRevealPolicy(
        IReadOnlyDictionary<string, object?> policy,
        ICollection<ValidationError> errors)
    {
        ValidatePolicy(policy, "revealPolicy", errors);

        if (TryGetNumber(policy, "revealWindowSeconds", out var revealWindowSeconds) &&
            revealWindowSeconds < 0)
        {
            errors.Add(Error("revealPolicy.revealWindowSeconds", "Reveal window cannot be negative."));
        }

        if (TryGetNumber(policy, "revealDelaySeconds", out var revealDelaySeconds) &&
            revealDelaySeconds < 0)
        {
            errors.Add(Error("revealPolicy.revealDelaySeconds", "Reveal delay cannot be negative."));
        }
    }

    private static void ValidatePolicy(
        IReadOnlyDictionary<string, object?> policy,
        string field,
        ICollection<ValidationError> errors)
    {
        if (policy.Count == 0)
        {
            errors.Add(Error(field, $"{field} is required."));
            return;
        }

        foreach (var key in FlattenKeys(policy))
        {
            if (ForbiddenSeedFields.Any(forbidden => key.Contains(forbidden, StringComparison.OrdinalIgnoreCase)))
            {
                errors.Add(Error(field, "Provably Fair governance must not persist plaintext server seed material."));
                return;
            }
        }
    }

    private static bool LooksLikePlaintextSeed(string value)
    {
        return value.Contains("plaintext", StringComparison.OrdinalIgnoreCase) ||
               value.Contains("serverSeed", StringComparison.OrdinalIgnoreCase) ||
               value.Contains("rawSeed", StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryGetNumber(IReadOnlyDictionary<string, object?> policy, string key, out decimal value)
    {
        value = 0;

        if (!policy.TryGetValue(key, out var rawValue) || rawValue is null)
        {
            return false;
        }

        return rawValue switch
        {
            int intValue => Set(intValue, out value),
            long longValue => Set(longValue, out value),
            decimal decimalValue => Set(decimalValue, out value),
            double doubleValue => Set((decimal)doubleValue, out value),
            string stringValue when decimal.TryParse(stringValue, out var parsed) => Set(parsed, out value),
            _ => false
        };
    }

    private static bool Set(decimal input, out decimal output)
    {
        output = input;
        return true;
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
