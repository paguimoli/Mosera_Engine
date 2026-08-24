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
        nameof(WagerType.KenoParlay),
        nameof(WagerType.KenoSumOverUnder),
        nameof(WagerType.KenoElement)
    ];

    public string GameFamily => nameof(GameType.Keno);

    public IReadOnlyCollection<string> SupportedWagerSchemas => WagerSchemas;

    public string EvaluatorVersion => "keno-math-evaluator-2";

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
        var row = ResolvePaytableRow(request.Paytable, request.WagerSchema, selected.Length, matches.Length, wagerResult);
        var outcome = wagerResult.Outcome;
        if (outcome == PrizeOutcome.Win && row is null)
        {
            outcome = PrizeOutcome.Loss;
        }

        var multiplier = row?.Multiplier ?? 0m;
        var stakeMinor = ReadInt(request.WagerPayload, "stakeMinor");
        if (outcome == PrizeOutcome.Win && row?.MaxPayout is decimal maxPayout && stakeMinor is > 0)
        {
            var maxPayoutMinor = decimal.Round(maxPayout * 100m, 0, MidpointRounding.AwayFromZero);
            multiplier = Math.Min(multiplier, maxPayoutMinor / stakeMinor.Value);
        }

        var basePayout = ConditionDecimal(row, "basePayoutPerUnit") ?? 0m;
        var combinedPayout = ConditionDecimal(row, "combinedPayoutPerUnit") ?? basePayout;
        var prizeFacts = new PrizeFacts(
            outcome,
            row?.PrizeCode ?? "NO_PRIZE",
            multiplier,
            row?.PayoutValue ?? 0m,
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["basePrizeComponentPerUnit"] = basePayout,
                ["bullseyeMatch"] = wagerResult.BullseyeMatch,
                ["bullseyePurchased"] = wagerResult.BullseyePurchased,
                ["bullseyeSupplementalPerUnit"] = Math.Max(0m, combinedPayout - basePayout),
                ["capApplied"] = row?.MaxPayout is not null && multiplier != row.Multiplier,
                ["combinedPayoutPerUnit"] = combinedPayout,
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
                PrizeOutcome.Win,
                matches.Length > 0 ? "KenoSpotHitCount" : "KenoSpotMiss",
                EvaluateAttachedBullseye(ticket, outcome, selected),
                ReadBool(ticket, "bullseyePurchased") ?? false,
                null,
                []),
            nameof(WagerType.KenoBullseye) => EvaluateBullseye(ticket, outcome),
            nameof(WagerType.KenoBigSmall) => EvaluateDerived(ticket, metrics, "bigSmall"),
            nameof(WagerType.KenoOddEven) => EvaluateDerived(ticket, metrics, "oddEven"),
            nameof(WagerType.KenoUpDown) => EvaluateDerived(ticket, metrics, "upDown"),
            nameof(WagerType.KenoDragonTiger) => EvaluateDerived(ticket, metrics, "dragonTiger"),
            nameof(WagerType.KenoParlay) => EvaluateDerived(ticket, metrics, "parlay"),
            nameof(WagerType.KenoSumOverUnder) => EvaluateDerived(ticket, metrics, "sumOverUnder"),
            nameof(WagerType.KenoElement) => EvaluateDerived(ticket, metrics, "element"),
            _ => throw new InvalidOperationException($"Unsupported Keno wager schema '{wagerSchema}'.")
        };
    }

    private static KenoMathWagerResult EvaluateBullseye(
        IReadOnlyDictionary<string, object?> ticket,
        IReadOnlyDictionary<string, object?> outcome)
    {
        var selected = ReadIntCollection(ticket, "numbers").ToArray();
        var outcomeBullseye = ReadInt(outcome, "bullseye");
        var won = outcomeBullseye is not null && selected.Contains(outcomeBullseye.Value);
        return new KenoMathWagerResult(
            won ? PrizeOutcome.Win : PrizeOutcome.Loss,
            won ? "KenoBullseyeMatch" : "KenoBullseyeMiss",
            won,
            true,
            null,
            []);
    }

    private static bool EvaluateAttachedBullseye(
        IReadOnlyDictionary<string, object?> ticket,
        IReadOnlyDictionary<string, object?> outcome,
        IReadOnlyCollection<int> selected)
    {
        if (ReadBool(ticket, "bullseyePurchased") != true)
        {
            return false;
        }

        var bullseye = ReadInt(outcome, "bullseye");
        return bullseye is not null && selected.Contains(bullseye.Value);
    }

    private static KenoMathWagerResult EvaluateDerived(
        IReadOnlyDictionary<string, object?> ticket,
        IReadOnlyDictionary<string, object?> metrics,
        string metricKey)
    {
        var selection = ReadString(ticket, "selection")?.ToUpperInvariant();
        var actual = ReadString(metrics, metricKey)?.ToUpperInvariant();
        var push = string.Equals(metricKey, "dragonTiger", StringComparison.Ordinal)
            && string.Equals(actual, "DT_TIE", StringComparison.Ordinal)
            && selection is "DRAGON" or "TIGER";
        var won = !string.IsNullOrWhiteSpace(selection) && string.Equals(selection, actual, StringComparison.Ordinal);
        return new KenoMathWagerResult(
            push ? PrizeOutcome.Push : won ? PrizeOutcome.Win : PrizeOutcome.Loss,
            push ? "KenoDerivedPush" : won ? "KenoDerivedMatch" : "KenoDerivedMiss",
            null,
            false,
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
                MatchesCondition(row, "bullseyePurchased", result.BullseyePurchased) &&
                MatchesCondition(row, "result", result.Outcome.ToString().ToUpperInvariant()));
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

    private static decimal? ConditionDecimal(PrizeMatrixRow? row, string key)
    {
        return row is not null && row.Conditions.TryGetValue(key, out var value) && value is not null
            ? Convert.ToDecimal(value)
            : null;
    }

    private static IReadOnlyDictionary<string, object?> BuildDerivedMetrics(int[] drawn)
    {
        const int numberRangeMin = 1;
        const int numberRangeMax = 80;
        var midpoint = numberRangeMin + ((numberRangeMax - numberRangeMin + 1) / 2);
        var odd = drawn.Count(number => number % 2 != 0);
        var even = drawn.Length - odd;
        var lowerHalf = drawn.Count(number => number < midpoint);
        var upperHalf = drawn.Length - lowerHalf;
        var sum = drawn.Sum();
        var threshold = drawn.Length * (numberRangeMin + numberRangeMax) / 2;
        var tensDigit = (sum / 10) % 10;
        var unitsDigit = sum % 10;
        var bigSmall = sum >= 811 ? "BIG" : "SMALL";
        var oddEven = sum % 2 == 0 ? "EVEN" : "ODD";
        var dragonTiger = tensDigit > unitsDigit ? "DRAGON" : unitsDigit > tensDigit ? "TIGER" : "DT_TIE";
        var upDown = lowerHalf > 10 ? "UP" : upperHalf > 10 ? "DOWN" : "UD_TIE";
        var element = sum switch
        {
            <= 695 => "GOLD",
            <= 763 => "WOOD",
            <= 855 => "WATER",
            <= 923 => "FIRE",
            _ => "EARTH"
        };

        return new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["bigSmall"] = bigSmall,
            ["dragonTiger"] = dragonTiger,
            ["element"] = element,
            ["evenCount"] = even,
            ["lastDigit"] = unitsDigit,
            ["lowerHalfCount"] = lowerHalf,
            ["oddCount"] = odd,
            ["oddEven"] = oddEven,
            ["parlay"] = $"{bigSmall}_{oddEven}",
            ["secondToLastDigit"] = tensDigit,
            ["sum"] = sum,
            ["sumOverUnder"] = sum >= 811 ? "OVER" : "UNDER",
            ["sumThreshold"] = threshold,
            ["upDown"] = upDown,
            ["upperHalfCount"] = upperHalf
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

    private static bool? ReadBool(IReadOnlyDictionary<string, object?> payload, string key)
    {
        if (!payload.TryGetValue(key, out var value) || value is null) return null;
        if (value is JsonElement element)
        {
            return element.ValueKind is JsonValueKind.True or JsonValueKind.False ? element.GetBoolean() : null;
        }

        return Convert.ToBoolean(value);
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
    PrizeOutcome Outcome,
    string ReasonCode,
    bool? BullseyeMatch,
    bool BullseyePurchased,
    string? Selection,
    IReadOnlyCollection<string> Notes);
