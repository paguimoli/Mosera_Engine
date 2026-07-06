namespace GameEngine.Domain.Model;

public static class MathGovernanceValidator
{
    private static readonly HashSet<string> ForbiddenFields = new(StringComparer.OrdinalIgnoreCase)
    {
        "rng",
        "random",
        "randomness",
        "entropy",
        "seed",
        "prng",
        "outcome",
        "outcomes",
        "outcomeStrategy",
        "outcomeReference"
    };

    public static ValidationResult Validate(MathModelDefinitionV1 model)
    {
        var errors = new List<ValidationError>();

        RequireText(model.MathModelId, "mathModelId", errors);
        RequireText(model.Version, "version", errors);
        RequireText(model.ContentHash, "contentHash", errors);

        if (model.GameFamilyCompatibility.Count == 0)
        {
            errors.Add(Error("gameFamilyCompatibility", "Math model must declare compatible game families."));
        }

        if (model.SupportedWagerSchemas.Count == 0)
        {
            errors.Add(Error("supportedWagerSchemas", "Math model must declare supported wager schemas."));
        }

        if (model.ExpectedRtp <= 0m || model.ExpectedRtp > 1m)
        {
            errors.Add(Error("expectedRtp", "Expected RTP must be greater than zero and less than or equal to one."));
        }

        if (model.HitFrequency < 0m || model.HitFrequency > 1m)
        {
            errors.Add(Error("hitFrequency", "Hit frequency must be between zero and one."));
        }

        ValidateForbiddenFields(model.PrizeLiabilityProfile, "prizeLiabilityProfile", errors);
        ValidateForbiddenFields(model.JackpotContributionModel, "jackpotContributionModel", errors);
        ValidateForbiddenFields(model.RoundingPolicy, "roundingPolicy", errors);
        ValidateForbiddenFields(model.CurrencyMinorUnitPolicy, "currencyMinorUnitPolicy", errors);
        ValidateForbiddenFields(model.RtpPolicyConstraints ?? new Dictionary<string, object?>(), "rtpPolicyConstraints", errors);

        return errors.Count == 0
            ? ValidationResult.Success()
            : new ValidationResult(false, errors, []);
    }

    public static ValidationResult Validate(PaytableDefinitionV1 paytable)
    {
        var errors = new List<ValidationError>();

        RequireText(paytable.PaytableId, "paytableId", errors);
        RequireText(paytable.Version, "version", errors);
        RequireText(paytable.MathModelId, "mathModelId", errors);
        RequireText(paytable.MathModelVersion, "mathModelVersion", errors);
        RequireText(paytable.ContentHash, "contentHash", errors);

        if (paytable.PrizeMatrixRows.Count == 0)
        {
            errors.Add(Error("prizeMatrixRows", "Paytable must declare at least one prize matrix row."));
        }

        ValidatePrizeRows(paytable.PrizeMatrixRows, "prizeMatrixRows", errors);
        ValidatePrizeRows(paytable.BonusSideBetRows, "bonusSideBetRows", errors);
        ValidateForbiddenFields(paytable.Caps, "caps", errors);

        return errors.Count == 0
            ? ValidationResult.Success()
            : new ValidationResult(false, errors, []);
    }

    private static void ValidatePrizeRows(
        IReadOnlyCollection<PrizeMatrixRow> rows,
        string path,
        ICollection<ValidationError> errors)
    {
        var rowIds = new HashSet<string>(StringComparer.Ordinal);

        foreach (var row in rows)
        {
            if (string.IsNullOrWhiteSpace(row.RowId) || !rowIds.Add(row.RowId))
            {
                errors.Add(Error($"{path}.rowId", "Prize matrix row ids are required and must be unique."));
            }

            RequireText(row.WagerSchema, $"{path}.{row.RowId}.wagerSchema", errors);
            RequireText(row.PrizeCode, $"{path}.{row.RowId}.prizeCode", errors);

            if (row.Multiplier < 0m)
            {
                errors.Add(Error($"{path}.{row.RowId}.multiplier", "Prize multiplier cannot be negative."));
            }

            if (row.PayoutValue < 0m)
            {
                errors.Add(Error($"{path}.{row.RowId}.payoutValue", "Prize payout value cannot be negative."));
            }

            if (row.Multiplier == 0m && row.PayoutValue == 0m)
            {
                errors.Add(Error($"{path}.{row.RowId}.payout", "Prize row must define a positive multiplier or payout value."));
            }

            if (row.MaxPayout is <= 0m)
            {
                errors.Add(Error($"{path}.{row.RowId}.maxPayout", "Prize max payout must be positive when provided."));
            }

            ValidateForbiddenFields(row.Conditions, $"{path}.{row.RowId}.conditions", errors);
        }
    }

    private static void ValidateForbiddenFields(
        IReadOnlyDictionary<string, object?> values,
        string path,
        ICollection<ValidationError> errors)
    {
        foreach (var key in values.Keys)
        {
            if (ForbiddenFields.Contains(key))
            {
                errors.Add(Error($"{path}.{key}", "Math governance contracts cannot declare RNG, entropy, seed, or outcome fields."));
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
