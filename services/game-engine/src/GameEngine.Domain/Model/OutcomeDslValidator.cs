namespace GameEngine.Domain.Model;

public static class OutcomeDslValidator
{
    private static readonly HashSet<string> ForbiddenFields = new(StringComparer.OrdinalIgnoreCase)
    {
        "math",
        "mathModel",
        "mathModelReference",
        "rtp",
        "returnToPlayer",
        "paytable",
        "paytableReference",
        "payout",
        "payouts",
        "odds"
    };

    public static ValidationResult Validate(OutcomeStrategyDefinitionV1 strategy)
    {
        var errors = new List<ValidationError>();

        RequireText(strategy.StrategyId, "strategyId", errors);
        RequireText(strategy.StrategyVersion, "strategyVersion", errors);
        RequireText(strategy.ContentHash, "contentHash", errors);

        if (strategy.PrimitiveGraph.Count == 0)
        {
            errors.Add(Error("primitiveGraph", "Outcome strategy must declare at least one primitive."));
        }

        ValidateForbiddenFields(strategy.InputSchema, "inputSchema", errors);
        ValidateForbiddenFields(strategy.OutputSchema, "outputSchema", errors);
        ValidateForbiddenFields(strategy.Constraints, "constraints", errors);

        var nodeIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var primitive in strategy.PrimitiveGraph)
        {
            if (string.IsNullOrWhiteSpace(primitive.NodeId))
            {
                errors.Add(Error("primitive.nodeId", "Primitive node id is required."));
                continue;
            }

            if (!nodeIds.Add(primitive.NodeId))
            {
                errors.Add(Error($"primitiveGraph.{primitive.NodeId}", "Primitive node ids must be unique."));
            }

            ValidatePrimitive(primitive, errors);
        }

        ValidateAcyclic(strategy.PrimitiveGraph, errors);

        return errors.Count == 0
            ? ValidationResult.Success()
            : new ValidationResult(false, errors, []);
    }

    private static void ValidatePrimitive(OutcomeDslPrimitive primitive, ICollection<ValidationError> errors)
    {
        ValidateForbiddenFields(primitive.Parameters, $"primitiveGraph.{primitive.NodeId}.parameters", errors);

        switch (primitive.PrimitiveType)
        {
            case OutcomePrimitiveType.UniqueNumberSet:
                ValidateNumberRange(primitive, errors, requireUniqueNumbers: true);
                break;
            case OutcomePrimitiveType.OrderedNumberSequence:
                ValidateNumberRange(primitive, errors, requireUniqueNumbers: false);
                break;
            case OutcomePrimitiveType.UniqueSymbolSet:
                ValidateSymbols(primitive, errors, requireUniqueSymbols: true);
                break;
            case OutcomePrimitiveType.OrderedSymbolSequence:
                ValidateSymbols(primitive, errors, requireUniqueSymbols: false);
                break;
            case OutcomePrimitiveType.WeightedSelection:
                ValidateWeightedSelection(primitive, errors);
                break;
            case OutcomePrimitiveType.ShufflePermutation:
            case OutcomePrimitiveType.DrawFromUrnDeckBag:
                ValidateSymbols(primitive, errors, requireUniqueSymbols: true);
                break;
            case OutcomePrimitiveType.CompositeOutcomeGraph:
            case OutcomePrimitiveType.ConstraintValidation:
                break;
            default:
                errors.Add(Error($"primitiveGraph.{primitive.NodeId}.primitiveType", "Unsupported primitive type."));
                break;
        }
    }

    private static void ValidateNumberRange(
        OutcomeDslPrimitive primitive,
        ICollection<ValidationError> errors,
        bool requireUniqueNumbers)
    {
        if (primitive.Count is null or <= 0)
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.count", "Number primitive count must be greater than zero."));
        }

        if (primitive.MinNumber is null || primitive.MaxNumber is null || primitive.MinNumber >= primitive.MaxNumber)
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.range", "Number primitive requires minNumber less than maxNumber."));
            return;
        }

        var rangeSize = primitive.MaxNumber.Value - primitive.MinNumber.Value + 1;
        if (primitive.Count > rangeSize)
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.count", "Number primitive count cannot exceed inclusive range size."));
        }

        if (primitive.Numbers.Count > 0)
        {
            if (primitive.Numbers.Any(number => number < primitive.MinNumber || number > primitive.MaxNumber))
            {
                errors.Add(Error($"primitiveGraph.{primitive.NodeId}.numbers", "Number primitive contains values outside the configured range."));
            }

            if (requireUniqueNumbers && primitive.Numbers.Count != primitive.Numbers.Distinct().Count())
            {
                errors.Add(Error($"primitiveGraph.{primitive.NodeId}.numbers", "Unique number set cannot contain duplicate numbers."));
            }
        }
    }

    private static void ValidateSymbols(
        OutcomeDslPrimitive primitive,
        ICollection<ValidationError> errors,
        bool requireUniqueSymbols)
    {
        if (primitive.Symbols.Count == 0)
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.symbols", "Symbol primitive requires at least one symbol."));
            return;
        }

        if (primitive.Symbols.Any(string.IsNullOrWhiteSpace))
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.symbols", "Symbol primitive cannot contain empty symbols."));
        }

        if (primitive.Count is <= 0)
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.count", "Symbol primitive count must be greater than zero when provided."));
        }

        if (primitive.Count > primitive.Symbols.Count && requireUniqueSymbols)
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.count", "Unique symbol count cannot exceed symbol population."));
        }

        if (requireUniqueSymbols && primitive.Symbols.Count != primitive.Symbols.Distinct(StringComparer.Ordinal).Count())
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.symbols", "Unique symbol set cannot contain duplicate symbols."));
        }
    }

    private static void ValidateWeightedSelection(OutcomeDslPrimitive primitive, ICollection<ValidationError> errors)
    {
        if (primitive.WeightedOptions.Count == 0)
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.weightedOptions", "Weighted selection requires at least one option."));
            return;
        }

        if (primitive.WeightedOptions.Any(option => string.IsNullOrWhiteSpace(option.Symbol)))
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.weightedOptions", "Weighted selection option symbols are required."));
        }

        if (primitive.WeightedOptions.Any(option => option.Weight <= 0m))
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.weightedOptions", "Weighted selection weights must be positive."));
        }

        if (primitive.WeightedOptions.Select(option => option.Symbol).Distinct(StringComparer.Ordinal).Count() != primitive.WeightedOptions.Count)
        {
            errors.Add(Error($"primitiveGraph.{primitive.NodeId}.weightedOptions", "Weighted selection option symbols must be unique."));
        }
    }

    private static void ValidateAcyclic(
        IReadOnlyCollection<OutcomeDslPrimitive> primitives,
        ICollection<ValidationError> errors)
    {
        var nodes = primitives.ToDictionary(primitive => primitive.NodeId, primitive => primitive, StringComparer.Ordinal);
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        var visited = new HashSet<string>(StringComparer.Ordinal);

        foreach (var primitive in primitives.Where(primitive => !string.IsNullOrWhiteSpace(primitive.NodeId)))
        {
            Visit(primitive.NodeId);
        }

        void Visit(string nodeId)
        {
            if (visited.Contains(nodeId) || !nodes.TryGetValue(nodeId, out var primitive))
            {
                return;
            }

            if (!visiting.Add(nodeId))
            {
                errors.Add(Error($"primitiveGraph.{nodeId}.dependsOn", "Composite outcome graph must be acyclic."));
                return;
            }

            foreach (var dependency in primitive.DependsOn)
            {
                if (!nodes.ContainsKey(dependency))
                {
                    errors.Add(Error($"primitiveGraph.{nodeId}.dependsOn", $"Dependency '{dependency}' is not declared in the primitive graph."));
                    continue;
                }

                Visit(dependency);
            }

            visiting.Remove(nodeId);
            visited.Add(nodeId);
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
                errors.Add(Error($"{path}.{key}", "Outcome DSL cannot declare math, RTP, paytable, odds, or payout fields."));
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
