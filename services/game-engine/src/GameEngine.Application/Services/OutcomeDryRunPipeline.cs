using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class OutcomeDryRunPipeline
{
    private readonly Dictionary<string, OutcomeAuthorityResult> idempotencyCache = new(StringComparer.Ordinal);

    public OutcomeAuthorityResult Execute(
        OutcomeAuthorityRequest request,
        OutcomeStrategyDefinitionV1 strategy,
        RngProviderDefinitionV1 rngProvider,
        RngProviderEvidence evidence)
    {
        ValidateRequest(request, strategy, rngProvider, evidence);

        if (idempotencyCache.TryGetValue(request.IdempotencyKey, out var existing))
        {
            return existing;
        }

        var random = new Random(CreateDeterministicSeed(request, strategy, rngProvider, evidence));
        var generatedAt = DateTimeOffset.UtcNow;
        var payload = ExecuteStrategy(strategy, random);
        var canonicalJson = JsonSerializer.Serialize(payload);
        var outcomeHash = $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalJson))).ToLowerInvariant()}";
        var outcomeId = DeterministicGuid($"{request.IdempotencyKey}:outcome:{outcomeHash}");
        var certificateId = DeterministicGuid($"{request.IdempotencyKey}:certificate:{outcomeHash}");

        var certificate = new OutcomeCertificate(
            certificateId,
            outcomeId,
            request.DrawId,
            strategy.StrategyId,
            strategy.StrategyVersion,
            rngProvider.ProviderId,
            rngProvider.ProviderVersion,
            outcomeHash,
            evidence.CanonicalEvidenceHash,
            [],
            new SignatureMetadata(
                "placeholder-signing-key",
                "sha256-v1",
                "placeholder-signature-v1",
                "placeholder-signature",
                generatedAt),
            OutcomeCustodyState.Generated,
            generatedAt);

        var result = new OutcomeAuthorityResult(
            outcomeId,
            request.RequestId,
            request.DrawId,
            request.IdempotencyKey,
            request.Mode,
            payload,
            canonicalJson,
            outcomeHash,
            certificate,
            generatedAt);

        idempotencyCache.Add(request.IdempotencyKey, result);
        return result;
    }

    private static void ValidateRequest(
        OutcomeAuthorityRequest request,
        OutcomeStrategyDefinitionV1 strategy,
        RngProviderDefinitionV1 rngProvider,
        RngProviderEvidence evidence)
    {
        RequireText(request.GameManifestReference, nameof(request.GameManifestReference));
        RequireText(request.OutcomeStrategyId, nameof(request.OutcomeStrategyId));
        RequireText(request.OutcomeStrategyVersion, nameof(request.OutcomeStrategyVersion));
        RequireText(request.RngProviderId, nameof(request.RngProviderId));
        RequireText(request.RngProviderVersion, nameof(request.RngProviderVersion));
        RequireText(request.RngEvidenceHash, nameof(request.RngEvidenceHash));
        RequireText(request.IdempotencyKey, nameof(request.IdempotencyKey));

        if (request.Mode == OutcomeAuthorityMode.ProductionDisabled)
        {
            throw new InvalidOperationException("Production outcome authority is disabled for this phase.");
        }

        if (strategy.StrategyId != request.OutcomeStrategyId || strategy.StrategyVersion != request.OutcomeStrategyVersion)
        {
            throw new InvalidOperationException("Outcome strategy reference does not match the requested strategy.");
        }

        if (rngProvider.ProviderId != request.RngProviderId || rngProvider.ProviderVersion != request.RngProviderVersion)
        {
            throw new InvalidOperationException("RNG provider reference does not match the requested provider.");
        }

        if (evidence.ProviderId != request.RngProviderId ||
            evidence.ProviderVersion != request.RngProviderVersion ||
            evidence.CanonicalEvidenceHash != request.RngEvidenceHash)
        {
            throw new InvalidOperationException("RNG evidence reference does not match the requested provider.");
        }

        if (!OutcomeDslValidator.Validate(strategy).IsValid)
        {
            throw new InvalidOperationException("Outcome strategy is invalid.");
        }

        if (!RngProviderGovernanceValidator.Validate(rngProvider).IsValid)
        {
            throw new InvalidOperationException("RNG provider definition is invalid.");
        }

        if (!RngProviderGovernanceValidator.Validate(evidence).IsValid)
        {
            throw new InvalidOperationException("RNG provider evidence is invalid.");
        }

        if (rngProvider.ProductionEligible)
        {
            throw new InvalidOperationException("Dry-run outcome generation requires a non-production RNG provider.");
        }

        if (request.Mode == OutcomeAuthorityMode.DryRun && rngProvider.ProviderType != RngProviderType.TestDeterministic)
        {
            throw new InvalidOperationException("Dry-run outcome generation requires a deterministic test RNG provider.");
        }

        if (request.Mode == OutcomeAuthorityMode.Simulation &&
            rngProvider.ProviderType is not (RngProviderType.TestDeterministic or RngProviderType.Simulation))
        {
            throw new InvalidOperationException("Simulation outcome generation requires a deterministic test or simulation RNG provider.");
        }
    }

    private static IReadOnlyDictionary<string, object?> ExecuteStrategy(OutcomeStrategyDefinitionV1 strategy, Random random)
    {
        var results = new SortedDictionary<string, object?>(StringComparer.Ordinal);

        foreach (var primitive in strategy.PrimitiveGraph)
        {
            results[primitive.NodeId] = ExecutePrimitive(primitive, random, results);
        }

        return results;
    }

    private static object? ExecutePrimitive(
        OutcomeDslPrimitive primitive,
        Random random,
        IReadOnlyDictionary<string, object?> previousResults)
    {
        return primitive.PrimitiveType switch
        {
            OutcomePrimitiveType.UniqueNumberSet => DrawNumbers(primitive, random, unique: true),
            OutcomePrimitiveType.OrderedNumberSequence => DrawNumbers(primitive, random, unique: false),
            OutcomePrimitiveType.UniqueSymbolSet => DrawSymbols(primitive, random, unique: true, shuffleAll: false),
            OutcomePrimitiveType.OrderedSymbolSequence => DrawSymbols(primitive, random, unique: false, shuffleAll: false),
            OutcomePrimitiveType.WeightedSelection => DrawWeighted(primitive, random),
            OutcomePrimitiveType.ShufflePermutation => DrawSymbols(primitive, random, unique: true, shuffleAll: true),
            OutcomePrimitiveType.DrawFromUrnDeckBag => DrawSymbols(primitive, random, unique: true, shuffleAll: false),
            OutcomePrimitiveType.CompositeOutcomeGraph => BuildComposite(primitive, previousResults),
            OutcomePrimitiveType.ConstraintValidation => new SortedDictionary<string, object?> { ["validated"] = true },
            _ => throw new InvalidOperationException($"Unsupported primitive type {primitive.PrimitiveType}.")
        };
    }

    private static int[] DrawNumbers(OutcomeDslPrimitive primitive, Random random, bool unique)
    {
        var minimum = primitive.MinNumber ?? throw new InvalidOperationException("Number primitive requires minNumber.");
        var maximum = primitive.MaxNumber ?? throw new InvalidOperationException("Number primitive requires maxNumber.");
        var count = primitive.Count ?? throw new InvalidOperationException("Number primitive requires count.");

        if (unique)
        {
            var available = Enumerable.Range(minimum, maximum - minimum + 1).ToList();
            var selected = new List<int>();
            for (var index = 0; index < count; index += 1)
            {
                var selectedIndex = random.Next(0, available.Count);
                selected.Add(available[selectedIndex]);
                available.RemoveAt(selectedIndex);
            }

            return selected.ToArray();
        }

        return Enumerable.Range(0, count).Select(_ => random.Next(minimum, maximum + 1)).ToArray();
    }

    private static string[] DrawSymbols(OutcomeDslPrimitive primitive, Random random, bool unique, bool shuffleAll)
    {
        var symbols = primitive.Symbols.ToList();
        var count = shuffleAll ? symbols.Count : primitive.Count ?? symbols.Count;

        if (unique || shuffleAll)
        {
            var selected = new List<string>();
            for (var index = 0; index < count; index += 1)
            {
                var selectedIndex = random.Next(0, symbols.Count);
                selected.Add(symbols[selectedIndex]);
                symbols.RemoveAt(selectedIndex);
            }

            return selected.ToArray();
        }

        return Enumerable.Range(0, count).Select(_ => symbols[random.Next(0, symbols.Count)]).ToArray();
    }

    private static string DrawWeighted(OutcomeDslPrimitive primitive, Random random)
    {
        var totalWeight = primitive.WeightedOptions.Sum(option => option.Weight);
        var selectedWeight = (decimal)random.NextDouble() * totalWeight;
        var cumulative = 0m;

        foreach (var option in primitive.WeightedOptions)
        {
            cumulative += option.Weight;
            if (selectedWeight <= cumulative)
            {
                return option.Symbol;
            }
        }

        return primitive.WeightedOptions.Last().Symbol;
    }

    private static IReadOnlyDictionary<string, object?> BuildComposite(
        OutcomeDslPrimitive primitive,
        IReadOnlyDictionary<string, object?> previousResults)
    {
        var composite = new SortedDictionary<string, object?>(StringComparer.Ordinal);
        foreach (var dependency in primitive.DependsOn)
        {
            if (previousResults.TryGetValue(dependency, out var value))
            {
                composite[dependency] = value;
            }
        }

        return composite;
    }

    private static int CreateDeterministicSeed(
        OutcomeAuthorityRequest request,
        OutcomeStrategyDefinitionV1 strategy,
        RngProviderDefinitionV1 rngProvider,
        RngProviderEvidence evidence)
    {
        var seedMaterial = string.Join(
            "|",
            request.IdempotencyKey,
            request.DrawId,
            strategy.ContentHash,
            rngProvider.ContentHash,
            evidence.CanonicalEvidenceHash);
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(seedMaterial));
        return BitConverter.ToInt32(hash, 0);
    }

    private static Guid DeterministicGuid(string value)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(hash[..16]);
    }

    private static void RequireText(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"{field} is required.", field);
        }
    }
}
