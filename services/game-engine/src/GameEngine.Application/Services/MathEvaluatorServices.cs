using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed record MathEvaluatorCompatibility(
    GameManifestV1 Manifest,
    MathModelDefinitionV1 MathModel,
    PaytableDefinitionV1 Paytable,
    string WagerSchema);

public sealed record MathEvaluatorRequest(
    GameManifestV1 Manifest,
    OutcomeCertificate OutcomeCertificate,
    MathModelDefinitionV1 MathModel,
    PaytableDefinitionV1 Paytable,
    string TicketReference,
    string WagerSchema,
    IReadOnlyDictionary<string, object?> WagerPayload,
    IReadOnlyDictionary<string, object?> OutcomePayload);

public sealed record MathEvaluatorResult(
    PrizeFacts PrizeFacts,
    string CanonicalPrizeFactsJson,
    string CanonicalPrizeFactsHash,
    string EvaluatorVersion);

public interface IMathEvaluator
{
    string GameFamily { get; }

    IReadOnlyCollection<string> SupportedWagerSchemas { get; }

    string EvaluatorVersion { get; }

    ValidationResult ValidateCompatibility(MathEvaluatorCompatibility compatibility);

    MathEvaluatorResult Evaluate(MathEvaluatorRequest request);
}

public sealed class MathEvaluatorRegistry
{
    private readonly IReadOnlyCollection<IMathEvaluator> evaluators;

    public MathEvaluatorRegistry(IEnumerable<IMathEvaluator> evaluators)
    {
        this.evaluators = evaluators.ToArray();
    }

    public IMathEvaluator Resolve(string gameFamily, string wagerSchema)
    {
        var matches = evaluators
            .Where(evaluator => string.Equals(evaluator.GameFamily, gameFamily, StringComparison.Ordinal)
                && evaluator.SupportedWagerSchemas.Contains(wagerSchema, StringComparer.Ordinal))
            .ToArray();

        return matches.Length switch
        {
            1 => matches[0],
            0 => throw new InvalidOperationException($"No Math evaluator is registered for game family '{gameFamily}' and wager schema '{wagerSchema}'."),
            _ => throw new InvalidOperationException($"Multiple Math evaluators are registered for game family '{gameFamily}' and wager schema '{wagerSchema}'.")
        };
    }
}

public sealed record MathCertificateEvaluationRequest(
    Guid RequestId,
    string IdempotencyKey,
    MathEvaluationMode Mode,
    GameManifestV1 Manifest,
    OutcomeCertificate OutcomeCertificate,
    MathModelDefinitionV1 MathModel,
    PaytableDefinitionV1 Paytable,
    string TicketReference,
    string WagerSchema,
    IReadOnlyDictionary<string, object?> WagerPayload,
    IReadOnlyDictionary<string, object?> OutcomePayload);

public sealed class MathCertificateEvaluationService(MathEvaluatorRegistry registry)
{
    public MathEvaluationResult Evaluate(MathCertificateEvaluationRequest request)
    {
        ValidateRequest(request);

        var evaluator = registry.Resolve(request.Manifest.GameFamily, request.WagerSchema);
        var compatibility = evaluator.ValidateCompatibility(new MathEvaluatorCompatibility(
            request.Manifest,
            request.MathModel,
            request.Paytable,
            request.WagerSchema));
        if (!compatibility.IsValid)
        {
            throw new InvalidOperationException($"Math evaluator compatibility failed: {string.Join("; ", compatibility.Errors.Select(error => error.Message))}");
        }

        var evaluation = evaluator.Evaluate(new MathEvaluatorRequest(
            request.Manifest,
            request.OutcomeCertificate,
            request.MathModel,
            request.Paytable,
            request.TicketReference,
            request.WagerSchema,
            request.WagerPayload,
            request.OutcomePayload));

        var evaluatedAt = DateTimeOffset.UtcNow;
        var evaluationId = DeterministicGuid($"{request.IdempotencyKey}:math-evaluation:{evaluation.CanonicalPrizeFactsHash}");
        var certificateId = DeterministicGuid($"{request.IdempotencyKey}:math-evaluation-certificate:{evaluation.CanonicalPrizeFactsHash}");
        var certificate = new MathEvaluationCertificate(
            certificateId,
            evaluationId,
            request.OutcomeCertificate.CertificateId,
            request.OutcomeCertificate.CanonicalOutcomeHash,
            request.MathModel.MathModelId,
            request.MathModel.Version,
            request.MathModel.ContentHash,
            request.Paytable.PaytableId,
            request.Paytable.Version,
            request.Paytable.ContentHash,
            request.TicketReference,
            evaluation.CanonicalPrizeFactsHash,
            $"math-model:{request.MathModel.MathModelId}:{request.MathModel.Version}:{request.MathModel.ContentHash}",
            new SignatureMetadata(
                "placeholder-signing-key",
                "sha256-v1",
                "placeholder-signature-v1",
                "placeholder-signature",
                evaluatedAt),
            evaluatedAt,
            evaluation.EvaluatorVersion,
            request.Manifest.Id.ToString("N"),
            request.Manifest.SemanticVersion,
            request.Manifest.ContentHash);

        return new MathEvaluationResult(
            evaluationId,
            request.RequestId,
            request.IdempotencyKey,
            request.Mode,
            evaluation.PrizeFacts,
            evaluation.CanonicalPrizeFactsJson,
            evaluation.CanonicalPrizeFactsHash,
            certificate,
            evaluatedAt);
    }

    private static void ValidateRequest(MathCertificateEvaluationRequest request)
    {
        RequireText(request.IdempotencyKey, nameof(request.IdempotencyKey));
        RequireText(request.TicketReference, nameof(request.TicketReference));
        RequireText(request.WagerSchema, nameof(request.WagerSchema));

        if (request.Mode == MathEvaluationMode.ProductionDisabled)
        {
            throw new InvalidOperationException("Production Math Authority evaluation is disabled for this phase.");
        }

        if (request.Manifest.MathModelReferences.Count > 0 &&
            !request.Manifest.MathModelReferences.Contains($"{request.MathModel.MathModelId}:{request.MathModel.Version}:{request.MathModel.ContentHash}", StringComparer.Ordinal) &&
            !request.Manifest.MathModelReferences.Contains($"{request.MathModel.MathModelId}:{request.MathModel.Version}", StringComparer.Ordinal) &&
            !request.Manifest.MathModelReferences.Contains(request.MathModel.MathModelId, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("Game Manifest does not reference the requested Math Model version.");
        }

        if (request.Manifest.PaytableReferences.Count > 0 &&
            !request.Manifest.PaytableReferences.Contains($"{request.Paytable.PaytableId}:{request.Paytable.Version}:{request.Paytable.ContentHash}", StringComparer.Ordinal) &&
            !request.Manifest.PaytableReferences.Contains($"{request.Paytable.PaytableId}:{request.Paytable.Version}", StringComparer.Ordinal) &&
            !request.Manifest.PaytableReferences.Contains(request.Paytable.PaytableId, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("Game Manifest does not reference the requested Paytable version.");
        }

        var outcomeHash = MathEvaluationCanonicalizer.HashPayload(request.OutcomePayload);
        if (!string.Equals(outcomeHash, request.OutcomeCertificate.CanonicalOutcomeHash, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Outcome payload does not match the verified Outcome Certificate hash.");
        }
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

public sealed class KenoMathEvaluator : IMathEvaluator
{
    private static readonly string[] WagerSchemas =
    [
        nameof(WagerType.KenoSpot),
        nameof(WagerType.KenoBullseye),
        nameof(WagerType.KenoBigSmall),
        nameof(WagerType.KenoOddEven),
        nameof(WagerType.KenoUpDown),
        nameof(WagerType.KenoDragonTiger),
        nameof(WagerType.KenoSumOverUnder),
        nameof(WagerType.KenoElement)
    ];

    public string GameFamily => nameof(GameType.Keno);

    public IReadOnlyCollection<string> SupportedWagerSchemas => WagerSchemas;

    public string EvaluatorVersion => "keno-math-evaluator-1";

    public ValidationResult ValidateCompatibility(MathEvaluatorCompatibility compatibility)
    {
        var errors = new List<ValidationError>();

        if (!string.Equals(compatibility.Manifest.GameFamily, GameFamily, StringComparison.Ordinal))
        {
            errors.Add(Error("manifest.gameFamily", "Keno evaluator requires a Keno Game Manifest."));
        }

        if (!SupportedWagerSchemas.Contains(compatibility.WagerSchema, StringComparer.Ordinal))
        {
            errors.Add(Error("wagerSchema", "Keno evaluator does not support the requested wager schema."));
        }

        if (!compatibility.Manifest.WagerSchemas.Contains(compatibility.WagerSchema, StringComparer.Ordinal))
        {
            errors.Add(Error("manifest.wagerSchemas", "Game Manifest does not allow the requested wager schema."));
        }

        if (!compatibility.MathModel.GameFamilyCompatibility.Contains(GameFamily, StringComparer.Ordinal))
        {
            errors.Add(Error("mathModel.gameFamilyCompatibility", "Math Model is not compatible with Keno."));
        }

        if (!compatibility.MathModel.SupportedWagerSchemas.Contains(compatibility.WagerSchema, StringComparer.Ordinal))
        {
            errors.Add(Error("mathModel.supportedWagerSchemas", "Math Model does not support the requested wager schema."));
        }

        if (compatibility.Paytable.MathModelId != compatibility.MathModel.MathModelId ||
            compatibility.Paytable.MathModelVersion != compatibility.MathModel.Version)
        {
            errors.Add(Error("paytable.mathModel", "Paytable does not reference the exact Math Model version."));
        }

        if (compatibility.Paytable.PrizeMatrixRows.All(row => !string.Equals(row.WagerSchema, compatibility.WagerSchema, StringComparison.Ordinal)))
        {
            errors.Add(Error("paytable.prizeMatrixRows", "Paytable does not contain a row for the requested wager schema."));
        }

        return errors.Count == 0 ? ValidationResult.Success() : new ValidationResult(false, errors, []);
    }

    public MathEvaluatorResult Evaluate(MathEvaluatorRequest request)
    {
        var compatibility = ValidateCompatibility(new MathEvaluatorCompatibility(
            request.Manifest,
            request.MathModel,
            request.Paytable,
            request.WagerSchema));
        if (!compatibility.IsValid)
        {
            throw new InvalidOperationException($"Keno evaluator compatibility failed: {string.Join("; ", compatibility.Errors.Select(error => error.Message))}");
        }

        var selected = ReadIntCollection(request.WagerPayload, "numbers").ToArray();
        var drawn = ReadOutcomeNumbers(request.OutcomePayload);
        ValidateSelections(selected, drawn);

        var matches = selected.Intersect(drawn).Order().ToArray();
        var metrics = BuildDerivedMetrics(drawn);
        var wagerResult = EvaluateWager(request.WagerSchema, request.WagerPayload, request.OutcomePayload, selected, matches, metrics);
        var row = wagerResult.Won
            ? ResolvePaytableRow(request.Paytable, request.WagerSchema, selected.Length, matches.Length, wagerResult)
            : null;
        var prizeFacts = new PrizeFacts(
            wagerResult.Won ? PrizeOutcome.Win : PrizeOutcome.Loss,
            row?.PrizeCode ?? "NO_PRIZE",
            row?.Multiplier ?? 0m,
            row?.PayoutValue ?? 0m,
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["bullseyeMatch"] = wagerResult.BullseyeMatch,
                ["derivedMetrics"] = metrics,
                ["drawnNumbers"] = drawn,
                ["matchedNumbers"] = matches,
                ["selectedNumbers"] = selected,
                ["selection"] = wagerResult.Selection
            },
            matches.Length,
            row?.RowId,
            wagerResult.ReasonCode,
            wagerResult.Notes);

        var canonical = MathEvaluationCanonicalizer.CanonicalizePrizeFacts(prizeFacts);
        var hash = MathEvaluationCanonicalizer.HashJson(canonical);
        var factsWithHash = prizeFacts with
        {
            OutcomeDerivedFacts = MathEvaluationCanonicalizer.CopySorted(prizeFacts.OutcomeDerivedFacts, ("canonicalFactsHash", hash))
        };
        var canonicalWithHash = MathEvaluationCanonicalizer.CanonicalizePrizeFacts(factsWithHash);

        return new MathEvaluatorResult(
            factsWithHash,
            canonicalWithHash,
            MathEvaluationCanonicalizer.HashJson(canonicalWithHash),
            EvaluatorVersion);
    }

    private static KenoMathWagerResult EvaluateWager(
        string wagerSchema,
        IReadOnlyDictionary<string, object?> ticket,
        IReadOnlyDictionary<string, object?> outcome,
        int[] selected,
        int[] matches,
        IReadOnlyDictionary<string, object?> metrics)
    {
        return wagerSchema switch
        {
            nameof(WagerType.KenoSpot) => new KenoMathWagerResult(
                matches.Length == selected.Length,
                matches.Length == selected.Length ? "KenoSpotMatch" : "KenoSpotMiss",
                null,
                null,
                []),
            nameof(WagerType.KenoBullseye) => EvaluateBullseye(ticket, outcome),
            nameof(WagerType.KenoBigSmall) => EvaluateDerived(ticket, metrics, "bigSmall"),
            nameof(WagerType.KenoOddEven) => EvaluateDerived(ticket, metrics, "oddEven"),
            nameof(WagerType.KenoUpDown) => EvaluateDerived(ticket, metrics, "upDown"),
            nameof(WagerType.KenoDragonTiger) => EvaluateDerived(ticket, metrics, "dragonTiger"),
            nameof(WagerType.KenoSumOverUnder) => EvaluateDerived(ticket, metrics, "sumOverUnder"),
            nameof(WagerType.KenoElement) => EvaluateDerived(ticket, metrics, "element"),
            _ => throw new InvalidOperationException($"Unsupported Keno wager schema '{wagerSchema}'.")
        };
    }

    private static KenoMathWagerResult EvaluateBullseye(
        IReadOnlyDictionary<string, object?> ticket,
        IReadOnlyDictionary<string, object?> outcome)
    {
        var ticketBullseye = ReadInt(ticket, "bullseye");
        var outcomeBullseye = ReadInt(outcome, "bullseye");
        var won = ticketBullseye is not null && ticketBullseye == outcomeBullseye;
        return new KenoMathWagerResult(
            won,
            won ? "KenoBullseyeMatch" : "KenoBullseyeMiss",
            won,
            null,
            []);
    }

    private static KenoMathWagerResult EvaluateDerived(
        IReadOnlyDictionary<string, object?> ticket,
        IReadOnlyDictionary<string, object?> metrics,
        string metricKey)
    {
        var selection = ReadString(ticket, "selection")?.ToUpperInvariant();
        var actual = ReadString(metrics, metricKey)?.ToUpperInvariant();
        var won = !string.IsNullOrWhiteSpace(selection) && string.Equals(selection, actual, StringComparison.Ordinal);
        return new KenoMathWagerResult(
            won,
            won ? "KenoDerivedMatch" : "KenoDerivedMiss",
            null,
            selection,
            [$"{metricKey}:{actual}"]);
    }

    private static PrizeMatrixRow? ResolvePaytableRow(
        PaytableDefinitionV1 paytable,
        string wagerSchema,
        int spotCount,
        int hitCount,
        KenoMathWagerResult result)
    {
        return paytable.PrizeMatrixRows
            .Where(row => string.Equals(row.WagerSchema, wagerSchema, StringComparison.Ordinal))
            .OrderByDescending(row => ConditionInt(row, "hitCount") ?? ConditionInt(row, "matchCount") ?? -1)
            .FirstOrDefault(row =>
                MatchesCondition(row, "spotCount", spotCount) &&
                MatchesCondition(row, "hitCount", hitCount) &&
                MatchesCondition(row, "matchCount", hitCount) &&
                MatchesCondition(row, "selection", result.Selection) &&
                MatchesCondition(row, "bullseyeMatch", result.BullseyeMatch) &&
                MatchesCondition(row, "result", result.Won ? "WIN" : "LOSS"));
    }

    private static bool MatchesCondition(PrizeMatrixRow row, string key, object? actual)
    {
        if (!row.Conditions.TryGetValue(key, out var expected) || expected is null)
        {
            return true;
        }

        if (actual is null)
        {
            return false;
        }

        return string.Equals(expected.ToString(), actual.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    private static int? ConditionInt(PrizeMatrixRow row, string key)
    {
        return row.Conditions.TryGetValue(key, out var value) && value is not null
            ? Convert.ToInt32(value)
            : null;
    }

    private static IReadOnlyDictionary<string, object?> BuildDerivedMetrics(int[] drawn)
    {
        const int numberRangeMin = 1;
        const int numberRangeMax = 80;
        var midpoint = numberRangeMin + ((numberRangeMax - numberRangeMin + 1) / 2);
        var odd = drawn.Count(number => number % 2 != 0);
        var even = drawn.Length - odd;
        var big = drawn.Count(number => number >= midpoint);
        var small = drawn.Length - big;
        var firstHalf = drawn.Take(drawn.Length / 2).Sum();
        var secondHalf = drawn.Skip(drawn.Length / 2).Sum();
        var sum = drawn.Sum();
        var threshold = drawn.Length * (numberRangeMin + numberRangeMax) / 2;
        var element = (sum % 4) switch
        {
            0 => "FIRE",
            1 => "WATER",
            2 => "EARTH",
            _ => "AIR"
        };

        return new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["bigCount"] = big,
            ["bigSmall"] = big >= small ? "BIG" : "SMALL",
            ["dragonSum"] = firstHalf,
            ["dragonTiger"] = firstHalf >= secondHalf ? "DRAGON" : "TIGER",
            ["element"] = element,
            ["evenCount"] = even,
            ["oddCount"] = odd,
            ["oddEven"] = odd >= even ? "ODD" : "EVEN",
            ["smallCount"] = small,
            ["sum"] = sum,
            ["sumOverUnder"] = sum >= threshold ? "OVER" : "UNDER",
            ["sumThreshold"] = threshold,
            ["tigerSum"] = secondHalf,
            ["upDown"] = small >= big ? "DOWN" : "UP"
        };
    }

    private static void ValidateSelections(int[] selected, int[] drawn)
    {
        if (selected.Length == 0)
        {
            throw new InvalidOperationException("Keno wager payload must include selected numbers.");
        }

        if (selected.Length != selected.Distinct().Count())
        {
            throw new InvalidOperationException("Keno selected numbers must be unique.");
        }

        if (drawn.Length != 20)
        {
            throw new InvalidOperationException("Keno outcome payload must include exactly 20 drawn numbers.");
        }

        if (drawn.Length != drawn.Distinct().Count())
        {
            throw new InvalidOperationException("Keno outcome numbers must be unique.");
        }

        if (selected.Concat(drawn).Any(number => number is < 1 or > 80))
        {
            throw new InvalidOperationException("Keno numbers must be between 1 and 80.");
        }
    }

    private static int[] ReadOutcomeNumbers(IReadOnlyDictionary<string, object?> payload)
    {
        var direct = ReadIntCollection(payload, "numbers").ToArray();
        if (direct.Length > 0)
        {
            return direct;
        }

        if (payload.TryGetValue("numbers", out var nested) && nested is IReadOnlyDictionary<string, object?> nestedPayload)
        {
            return ReadIntCollection(nestedPayload, "numbers").ToArray();
        }

        return [];
    }

    private static IReadOnlyCollection<int> ReadIntCollection(IReadOnlyDictionary<string, object?> payload, string key)
    {
        if (!payload.TryGetValue(key, out var value) || value is null) return [];
        if (value is int[] intArray) return intArray;
        if (value is IEnumerable<int> intValues) return intValues.ToArray();
        if (value is IEnumerable<object> objectValues) return objectValues.Select(Convert.ToInt32).ToArray();
        if (value is JsonElement { ValueKind: JsonValueKind.Array } element)
        {
            return element.EnumerateArray().Select(item => item.GetInt32()).ToArray();
        }

        return [];
    }

    private static int? ReadInt(IReadOnlyDictionary<string, object?> payload, string key)
    {
        if (!payload.TryGetValue(key, out var value) || value is null) return null;
        if (value is JsonElement element)
        {
            return element.ValueKind == JsonValueKind.Number ? element.GetInt32() : null;
        }

        return Convert.ToInt32(value);
    }

    private static string? ReadString(IReadOnlyDictionary<string, object?> payload, string key)
    {
        if (!payload.TryGetValue(key, out var value) || value is null) return null;
        return value is JsonElement element ? element.ToString() : value.ToString();
    }

    private static ValidationError Error(string field, string message)
    {
        return new ValidationError(ValidationCode.InvalidConfiguration, field, message, ValidationSeverity.Error);
    }
}

public static class MathEvaluationCanonicalizer
{
    public static string CanonicalizePrizeFacts(PrizeFacts prizeFacts)
    {
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["evaluationNotes"] = prizeFacts.EvaluationNotes ?? [],
            ["evaluationReasonCode"] = prizeFacts.EvaluationReasonCode,
            ["hitCount"] = prizeFacts.HitCount,
            ["multiplier"] = prizeFacts.Multiplier,
            ["outcome"] = prizeFacts.Outcome.ToString().ToUpperInvariant(),
            ["outcomeDerivedFacts"] = prizeFacts.OutcomeDerivedFacts,
            ["paytableRowReference"] = prizeFacts.PaytableRowReference,
            ["payoutUnits"] = prizeFacts.PayoutUnits,
            ["prizeTier"] = prizeFacts.PrizeTier
        };

        return JsonSerializer.Serialize(payload);
    }

    public static string HashPayload(IReadOnlyDictionary<string, object?> payload)
    {
        return HashJson(JsonSerializer.Serialize(CopySorted(payload)));
    }

    public static string HashJson(string json)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant()}";
    }

    public static SortedDictionary<string, object?> CopySorted(
        IReadOnlyDictionary<string, object?> values,
        params (string Key, object? Value)[] additionalValues)
    {
        var sorted = new SortedDictionary<string, object?>(StringComparer.Ordinal);
        foreach (var item in values)
        {
            sorted[item.Key] = item.Value;
        }

        foreach (var item in additionalValues)
        {
            sorted[item.Key] = item.Value;
        }

        return sorted;
    }
}

internal sealed record KenoMathWagerResult(
    bool Won,
    string ReasonCode,
    bool? BullseyeMatch,
    string? Selection,
    IReadOnlyCollection<string> Notes);
