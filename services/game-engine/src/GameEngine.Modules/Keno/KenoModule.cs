using GameEngine.Domain.Model;
using GameEngine.Domain.Modules;

namespace GameEngine.Modules.Keno;

public sealed class KenoModule :
    IGameModule,
    IGameModuleManifestProvider,
    IGameTicketValidator,
    IGameDrawGenerator,
    IGameEvaluator,
    IGameConfigurationValidator,
    IGameModuleHealthCheck,
    IGameModuleFixtureProvider
{
    private static readonly WagerType[] SupportedWagers =
    [
        WagerType.KenoSpot,
        WagerType.KenoBullseye,
        WagerType.KenoBigSmall,
        WagerType.KenoOddEven,
        WagerType.KenoUpDown,
        WagerType.KenoDragonTiger,
        WagerType.KenoSumOverUnder,
        WagerType.KenoElement
    ];

    private static readonly KenoConfiguration DefaultConfiguration = new(
        1,
        80,
        20,
        Enumerable.Range(1, 10).ToArray(),
        BullseyeEnabled: true,
        InternalDrawGenerationEnabled: false,
        "REFERENCE_PAYTABLE_V1",
        "OFFICIAL_OR_MANUAL",
        SupportedWagers);

    public string ModuleId => "KENO_GENERIC";

    public string GetVersion() => "0.1.0-reference";

    public GameModuleManifest GetManifest()
    {
        return new GameModuleManifest(
            ModuleId,
            "Generic Keno Module",
            GetVersion(),
            [GameType.Keno],
            SupportedWagers,
            [DrawProviderType.ManualCertifiedEntry, DrawProviderType.OfficialFeed, DrawProviderType.InternalTestPrng],
            SupportsInternalDrawGeneration: false,
            SupportsExternalResultEvaluation: true,
            SupportsManualResultEvaluation: true,
            ConfigurationSchemaVersion: "keno-config-schema-1",
            EvaluatorVersion: "keno-evaluator-1",
            DrawGeneratorVersion: "disabled",
            MinimumGameEngineVersion: "0.1.0",
            GameModuleLifecycleStatus.QaCertified,
            "checksum-reference-keno-v1",
            DateTimeOffset.UnixEpoch,
            "reference-module");
    }

    public GameModuleVersionMetadata GetVersionMetadata()
    {
        return new GameModuleVersionMetadata(
            GetVersion(),
            "keno-evaluator-1",
            "disabled",
            "keno-config-schema-1",
            "0.1.0",
            "0.1.0",
            "checksum-reference-keno-v1");
    }

    public IReadOnlyCollection<GameType> GetSupportedGameTypes() => [GameType.Keno];

    public IReadOnlyCollection<WagerType> GetSupportedWagerTypes() => SupportedWagers;

    public ConfigurationValidationResult ValidateConfiguration(IReadOnlyDictionary<string, object?> configuration)
    {
        var parsed = ParseConfiguration(configuration);
        if (!parsed.Validation.IsValid)
        {
            return new ConfigurationValidationResult(false, parsed.Validation, "invalid-keno-configuration");
        }

        return new ConfigurationValidationResult(
            true,
            ValidationResult.Success([new ValidationWarning(
                ValidationCode.None,
                "configuration.production",
                "Generic Keno reference configuration is not production active.")]),
            $"keno:{parsed.Configuration.NumberRangeMin}:{parsed.Configuration.NumberRangeMax}:{parsed.Configuration.NumbersDrawn}:{parsed.Configuration.PaytableVersion}");
    }

    public TicketValidationResult ValidateTicket(TicketValidationRequest request)
    {
        var errors = new List<ValidationError>();
        var configuration = ParseConfiguration(ReadDictionary(request.Payload, "configuration") ?? new Dictionary<string, object?>()).Configuration;

        if (request.GameType != GameType.Keno)
        {
            errors.Add(Error(ValidationCode.UnsupportedGameType, nameof(request.GameType), "Unsupported game type."));
        }

        if (!SupportedWagers.Contains(request.WagerType))
        {
            errors.Add(Error(ValidationCode.UnsupportedWagerType, nameof(request.WagerType), "Unsupported wager type."));
        }

        var numbers = ReadIntCollection(request.Payload, "numbers");
        if (numbers.Count == 0)
        {
            errors.Add(Error(ValidationCode.InvalidTicket, "payload.numbers", "Keno selections are required."));
        }
        else
        {
            ValidateNumbers(numbers, configuration, "payload.numbers", errors);
            if (!configuration.AllowedSpotCounts.Contains(numbers.Count))
            {
                errors.Add(Error(ValidationCode.InvalidTicket, "payload.numbers", "Unsupported Keno spot count."));
            }
        }

        if (request.WagerType == WagerType.KenoBullseye)
        {
            if (!configuration.BullseyeEnabled)
            {
                errors.Add(Error(ValidationCode.InvalidTicket, "payload.bullseye", "Bullseye wager is disabled by configuration."));
            }

            var bullseye = ReadInt(request.Payload, "bullseye");
            if (bullseye is null)
            {
                errors.Add(Error(ValidationCode.InvalidTicket, "payload.bullseye", "Bullseye selection is required."));
            }
            else if (!numbers.Contains(bullseye.Value))
            {
                errors.Add(Error(ValidationCode.InvalidTicket, "payload.bullseye", "Bullseye selection must be one of the selected numbers."));
            }
        }

        ValidateWagerParameters(request.WagerType, request.Payload, errors);

        return errors.Count == 0
            ? new TicketValidationResult(true, ValidationResult.Success(), $"keno-ticket:{request.WagerType}:{string.Join("-", numbers.Order())}")
            : new TicketValidationResult(false, new ValidationResult(false, errors, []), "invalid-keno-ticket");
    }

    public bool CanGenerateDraw(DrawGenerationRequest request) => false;

    public DrawGenerationResult GenerateDraw(DrawGenerationRequest request)
    {
        return new DrawGenerationResult(
            false,
            string.Empty,
            new Dictionary<string, object?>(),
            new DrawGenerationMetadata(
                GetVersion(),
                "disabled",
                "not-approved",
                "official-or-manual",
                "not-enabled",
                string.Empty),
            ValidationResult.Failure(Error(
                ValidationCode.DrawGenerationUnsupported,
                "drawGeneration",
                "Internal Keno draw generation is disabled by default.")));
    }

    public GameEvaluationOutput EvaluateTicket(GameEvaluationInput input)
    {
        var ticketValidation = ValidateTicket(new TicketValidationRequest(
            Guid.Empty,
            Guid.Empty,
            Guid.Empty,
            input.GameType,
            input.WagerType,
            input.TicketPayload));
        if (!ticketValidation.Accepted)
        {
            return Rejected(input, ticketValidation.Validation, GameEvaluationReason.InvalidTicket);
        }

        var configuration = ParseConfiguration(ReadDictionary(input.TicketPayload, "configuration") ?? new Dictionary<string, object?>()).Configuration;
        var drawValidation = ValidateDrawResult(input.DrawResultPayload, configuration);
        if (!drawValidation.IsValid)
        {
            return Rejected(input, drawValidation, GameEvaluationReason.InvalidDrawResult);
        }

        var selected = ReadIntCollection(input.TicketPayload, "numbers").ToArray();
        var drawn = ReadIntCollection(input.DrawResultPayload, "numbers").ToArray();
        var matches = selected.Intersect(drawn).Order().ToArray();
        var metrics = BuildDerivedMetrics(drawn, configuration);
        var result = EvaluateWager(input.WagerType, input.TicketPayload, input.DrawResultPayload, selected, matches, metrics);
        var payout = LookupPayout(input.TicketPayload, configuration, input.WagerType, selected.Length, matches.Length, result.Won, result.Selection);
        var amount = input.Stake with
        {
            PayoutAmount = payout,
            NetAmount = payout - input.Stake.StakeAmount
        };

        var facts = new Dictionary<string, object?>
        {
            ["outcome"] = result.Won ? GameEvaluationOutcome.Win.ToString() : GameEvaluationOutcome.Loss.ToString(),
            ["reasonCode"] = result.Reason.ToString(),
            ["hitCount"] = matches.Length,
            ["matchedNumbers"] = matches,
            ["bullseyeMatch"] = result.BullseyeMatch,
            ["derivedMetrics"] = metrics,
            ["payoutAmount"] = payout,
            ["moduleVersion"] = GetVersion(),
            ["evaluatorVersion"] = GetManifest().EvaluatorVersion,
            ["paytableVersion"] = configuration.PaytableVersion
        };

        return new GameEvaluationOutput(
            input.TicketId,
            result.Won ? GameEvaluationOutcome.Win : GameEvaluationOutcome.Loss,
            result.Reason,
            amount,
            input.Metadata with
            {
                ModuleId = ModuleId,
                ModuleVersion = GetVersion(),
                EvaluatorVersion = GetManifest().EvaluatorVersion,
                PaytableVersion = configuration.PaytableVersion
            },
            ValidationResult.Success(),
            facts);
    }

    public IReadOnlyCollection<GameEvaluationOutput> EvaluateBatch(IReadOnlyCollection<GameEvaluationInput> inputs)
    {
        return inputs.Select(EvaluateTicket).ToArray();
    }

    public IReadOnlyCollection<GameModuleFixture> GetDeterministicFixtures()
    {
        return
        [
            Fixture("keno-spot-win", WagerType.KenoSpot, [1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 21, 22, 23, 24, 25, 31, 32, 33, 34, 35], GameEvaluationOutcome.Win, GameEvaluationReason.KenoSpotMatch, 50m),
            Fixture("keno-spot-loss", WagerType.KenoSpot, [1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 21, 22, 23, 24, 25, 31, 32, 33, 34, 35], GameEvaluationOutcome.Loss, GameEvaluationReason.KenoSpotMiss, 0m),
            Fixture("keno-bullseye-win", WagerType.KenoBullseye, [1, 2, 3], [1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 21, 22, 23, 24, 25, 31, 32, 33, 34, 35], GameEvaluationOutcome.Win, GameEvaluationReason.KenoBullseyeMatch, 25m, new Dictionary<string, object?> { ["bullseye"] = 1 }, new Dictionary<string, object?> { ["bullseye"] = 1 }),
            Fixture("keno-bullseye-miss", WagerType.KenoBullseye, [1, 2, 3], [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 21, 22, 23, 24, 25, 31, 32, 33, 34, 35], GameEvaluationOutcome.Loss, GameEvaluationReason.KenoBullseyeMiss, 0m, new Dictionary<string, object?> { ["bullseye"] = 1 }, new Dictionary<string, object?> { ["bullseye"] = 2 }),
            Fixture("keno-odd-even", WagerType.KenoOddEven, [1], [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40], GameEvaluationOutcome.Win, GameEvaluationReason.KenoDerivedMatch, 18m, new Dictionary<string, object?> { ["selection"] = "ODD" }),
            Fixture("keno-big-small", WagerType.KenoBigSmall, [1], [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], GameEvaluationOutcome.Win, GameEvaluationReason.KenoDerivedMatch, 18m, new Dictionary<string, object?> { ["selection"] = "BIG" }),
            Fixture("keno-up-down", WagerType.KenoUpDown, [1], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50], GameEvaluationOutcome.Win, GameEvaluationReason.KenoDerivedMatch, 18m, new Dictionary<string, object?> { ["selection"] = "DOWN" }),
            Fixture("keno-dragon-tiger", WagerType.KenoDragonTiger, [1], [80, 79, 78, 77, 76, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], GameEvaluationOutcome.Win, GameEvaluationReason.KenoDerivedMatch, 18m, new Dictionary<string, object?> { ["selection"] = "DRAGON" }),
            Fixture("keno-sum-over-under", WagerType.KenoSumOverUnder, [1], [80, 79, 78, 77, 76, 75, 74, 73, 72, 71, 70, 69, 68, 67, 66, 65, 64, 63, 62, 61], GameEvaluationOutcome.Win, GameEvaluationReason.KenoDerivedMatch, 18m, new Dictionary<string, object?> { ["selection"] = "OVER", ["threshold"] = 810 }),
            Fixture("keno-element", WagerType.KenoElement, [1], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 22], GameEvaluationOutcome.Win, GameEvaluationReason.KenoDerivedMatch, 18m, new Dictionary<string, object?> { ["selection"] = "FIRE" }),
            InvalidFixture("keno-invalid-duplicate-ticket", new Dictionary<string, object?> { ["numbers"] = new[] { 1, 1, 2 } }),
            InvalidFixture("keno-invalid-out-of-range-ticket", new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 81 } }),
            Fixture("keno-invalid-draw-result", WagerType.KenoSpot, [1, 2, 3], [1, 2, 3], GameEvaluationOutcome.Rejected, GameEvaluationReason.InvalidDrawResult, 0m)
        ];
    }

    public GameModuleHealthCheckResult HealthCheck()
    {
        return new GameModuleHealthCheckResult(
            GameModuleHealthStatus.Healthy,
            ModuleId,
            GetVersion(),
            ["Reference Keno module only; not production active.", "Internal draw generation is disabled by default."],
            DateTimeOffset.UtcNow);
    }

    public ValidationResult ValidateDrawResult(IReadOnlyDictionary<string, object?> drawResult, KenoConfiguration? configuration = null)
    {
        var config = configuration ?? DefaultConfiguration;
        var errors = new List<ValidationError>();
        var drawn = ReadIntCollection(drawResult, "numbers");
        if (drawn.Count != config.NumbersDrawn)
        {
            errors.Add(Error(ValidationCode.InvalidDrawResult, "drawResult.numbers", "Draw result contains the wrong number count."));
        }

        ValidateNumbers(drawn, config, "drawResult.numbers", errors);

        if (config.BullseyeEnabled && drawResult.ContainsKey("bullseye"))
        {
            var bullseye = ReadInt(drawResult, "bullseye");
            if (bullseye is null || !drawn.Contains(bullseye.Value))
            {
                errors.Add(Error(ValidationCode.InvalidDrawResult, "drawResult.bullseye", "Bullseye must be one of the drawn numbers when supplied."));
            }
        }

        return errors.Count == 0 ? ValidationResult.Success() : new ValidationResult(false, errors, []);
    }

    private static GameModuleFixture Fixture(
        string id,
        WagerType wagerType,
        int[] selected,
        int[] drawn,
        GameEvaluationOutcome expectedOutcome,
        GameEvaluationReason expectedReason,
        decimal expectedPayout,
        IReadOnlyDictionary<string, object?>? ticketExtras = null,
        IReadOnlyDictionary<string, object?>? drawExtras = null)
    {
        var ticketPayload = new Dictionary<string, object?>
        {
            ["numbers"] = selected,
            ["paytable"] = ReferencePaytable()
        };
        foreach (var item in ticketExtras ?? new Dictionary<string, object?>()) ticketPayload[item.Key] = item.Value;

        var drawPayload = new Dictionary<string, object?> { ["numbers"] = drawn };
        foreach (var item in drawExtras ?? new Dictionary<string, object?>()) drawPayload[item.Key] = item.Value;

        return new GameModuleFixture(
            id,
            new TicketValidationRequest(Guid.NewGuid(), Guid.NewGuid(), Guid.Empty, GameType.Keno, wagerType, ticketPayload),
            drawPayload,
            expectedOutcome,
            new GameEvaluationAmount("USD", 10m, expectedPayout, expectedPayout - 10m),
            true,
            expectedReason);
    }

    private static GameModuleFixture InvalidFixture(string id, IReadOnlyDictionary<string, object?> payload)
    {
        return new GameModuleFixture(
            id,
            new TicketValidationRequest(Guid.NewGuid(), Guid.NewGuid(), Guid.Empty, GameType.Keno, WagerType.KenoSpot, payload),
            new Dictionary<string, object?> { ["numbers"] = Enumerable.Range(1, 20).ToArray() },
            GameEvaluationOutcome.Rejected,
            new GameEvaluationAmount("USD", 10m, 0m, -10m),
            false,
            GameEvaluationReason.InvalidTicket);
    }

    private static Dictionary<string, object?> ReferencePaytable()
    {
        return new Dictionary<string, object?>
        {
            ["KenoSpot:5:5"] = 50m,
            ["KenoBullseye:WIN"] = 25m,
            ["KenoBigSmall:WIN"] = 18m,
            ["KenoOddEven:WIN"] = 18m,
            ["KenoUpDown:WIN"] = 18m,
            ["KenoDragonTiger:WIN"] = 18m,
            ["KenoSumOverUnder:WIN"] = 18m,
            ["KenoElement:WIN"] = 18m
        };
    }

    private static ParsedConfiguration ParseConfiguration(IReadOnlyDictionary<string, object?> configuration)
    {
        var errors = new List<ValidationError>();
        var min = ReadInt(configuration, "numberRangeMin") ?? DefaultConfiguration.NumberRangeMin;
        var max = ReadInt(configuration, "numberRangeMax") ?? DefaultConfiguration.NumberRangeMax;
        var drawn = ReadInt(configuration, "numbersDrawn") ?? DefaultConfiguration.NumbersDrawn;
        var allowed = ReadIntCollection(configuration, "allowedSpotCounts");
        if (allowed.Count == 0) allowed = DefaultConfiguration.AllowedSpotCounts.ToArray();
        var bullseye = ReadBool(configuration, "bullseyeEnabled") ?? DefaultConfiguration.BullseyeEnabled;
        var internalDraw = ReadBool(configuration, "internalDrawGenerationEnabled") ?? DefaultConfiguration.InternalDrawGenerationEnabled;
        var paytable = ReadString(configuration, "paytableVersion") ?? DefaultConfiguration.PaytableVersion;
        var authority = ReadString(configuration, "drawAuthorityMode") ?? DefaultConfiguration.DrawAuthorityMode;

        if (min < 1) errors.Add(Error(ValidationCode.InvalidConfiguration, "numberRangeMin", "Number range min must be positive."));
        if (max <= min) errors.Add(Error(ValidationCode.InvalidConfiguration, "numberRangeMax", "Number range max must be greater than min."));
        if (drawn <= 0 || drawn > (max - min + 1)) errors.Add(Error(ValidationCode.InvalidConfiguration, "numbersDrawn", "Numbers drawn must fit the configured range."));
        if (allowed.Any(count => count <= 0 || count > drawn)) errors.Add(Error(ValidationCode.InvalidConfiguration, "allowedSpotCounts", "Allowed spot counts must be positive and no larger than numbers drawn."));
        if (internalDraw) errors.Add(Error(ValidationCode.InvalidConfiguration, "internalDrawGenerationEnabled", "Internal draw generation is not approved in the reference module."));

        return new ParsedConfiguration(
            new KenoConfiguration(min, max, drawn, allowed, bullseye, internalDraw, paytable, authority, SupportedWagers),
            errors.Count == 0 ? ValidationResult.Success() : new ValidationResult(false, errors, []));
    }

    private static void ValidateWagerParameters(WagerType wagerType, IReadOnlyDictionary<string, object?> payload, List<ValidationError> errors)
    {
        if (wagerType is WagerType.KenoSpot or WagerType.KenoBullseye) return;

        var selection = ReadString(payload, "selection");
        if (string.IsNullOrWhiteSpace(selection))
        {
            errors.Add(Error(ValidationCode.InvalidTicket, "payload.selection", "Derived Keno wager selection is required."));
            return;
        }

        var allowed = wagerType switch
        {
            WagerType.KenoBigSmall => new[] { "BIG", "SMALL" },
            WagerType.KenoOddEven => ["ODD", "EVEN"],
            WagerType.KenoUpDown => ["UP", "DOWN"],
            WagerType.KenoDragonTiger => ["DRAGON", "TIGER"],
            WagerType.KenoSumOverUnder => ["OVER", "UNDER"],
            WagerType.KenoElement => ["FIRE", "WATER", "EARTH", "AIR"],
            _ => []
        };

        if (!allowed.Contains(selection, StringComparer.OrdinalIgnoreCase))
        {
            errors.Add(Error(ValidationCode.InvalidTicket, "payload.selection", "Derived Keno wager selection is invalid."));
        }

        if (wagerType == WagerType.KenoSumOverUnder && ReadInt(payload, "threshold") is null)
        {
            errors.Add(Error(ValidationCode.InvalidTicket, "payload.threshold", "Sum over/under threshold is required."));
        }
    }

    private static KenoWagerResult EvaluateWager(
        WagerType wagerType,
        IReadOnlyDictionary<string, object?> ticket,
        IReadOnlyDictionary<string, object?> draw,
        int[] selected,
        int[] matches,
        IReadOnlyDictionary<string, object?> metrics)
    {
        return wagerType switch
        {
            WagerType.KenoSpot => new KenoWagerResult(matches.Length == selected.Length, matches.Length == selected.Length ? GameEvaluationReason.KenoSpotMatch : GameEvaluationReason.KenoSpotMiss, null, null),
            WagerType.KenoBullseye => EvaluateBullseye(ticket, draw),
            WagerType.KenoBigSmall => EvaluateDerived(ticket, metrics, "bigSmall"),
            WagerType.KenoOddEven => EvaluateDerived(ticket, metrics, "oddEven"),
            WagerType.KenoUpDown => EvaluateDerived(ticket, metrics, "upDown"),
            WagerType.KenoDragonTiger => EvaluateDerived(ticket, metrics, "dragonTiger"),
            WagerType.KenoSumOverUnder => EvaluateDerived(ticket, metrics, "sumOverUnder"),
            WagerType.KenoElement => EvaluateDerived(ticket, metrics, "element"),
            _ => new KenoWagerResult(false, GameEvaluationReason.UnsupportedWagerType, null, null)
        };
    }

    private static KenoWagerResult EvaluateBullseye(IReadOnlyDictionary<string, object?> ticket, IReadOnlyDictionary<string, object?> draw)
    {
        var ticketBullseye = ReadInt(ticket, "bullseye");
        var drawBullseye = ReadInt(draw, "bullseye");
        var won = ticketBullseye is not null && ticketBullseye == drawBullseye;
        return new KenoWagerResult(won, won ? GameEvaluationReason.KenoBullseyeMatch : GameEvaluationReason.KenoBullseyeMiss, won, null);
    }

    private static KenoWagerResult EvaluateDerived(IReadOnlyDictionary<string, object?> ticket, IReadOnlyDictionary<string, object?> metrics, string metricKey)
    {
        var selection = ReadString(ticket, "selection")?.ToUpperInvariant();
        var actual = ReadString(metrics, metricKey)?.ToUpperInvariant();
        var won = !string.IsNullOrWhiteSpace(selection) && string.Equals(selection, actual, StringComparison.OrdinalIgnoreCase);
        return new KenoWagerResult(won, won ? GameEvaluationReason.KenoDerivedMatch : GameEvaluationReason.KenoDerivedMiss, null, selection);
    }

    private static IReadOnlyDictionary<string, object?> BuildDerivedMetrics(int[] drawn, KenoConfiguration configuration)
    {
        var midpoint = configuration.NumberRangeMin + ((configuration.NumberRangeMax - configuration.NumberRangeMin + 1) / 2);
        var odd = drawn.Count(number => number % 2 != 0);
        var even = drawn.Length - odd;
        var big = drawn.Count(number => number >= midpoint);
        var small = drawn.Length - big;
        var firstHalf = drawn.Take(drawn.Length / 2).Sum();
        var secondHalf = drawn.Skip(drawn.Length / 2).Sum();
        var sum = drawn.Sum();
        var threshold = configuration.NumbersDrawn * (configuration.NumberRangeMin + configuration.NumberRangeMax) / 2;
        var element = (sum % 4) switch
        {
            0 => "FIRE",
            1 => "WATER",
            2 => "EARTH",
            _ => "AIR"
        };

        return new Dictionary<string, object?>
        {
            ["oddCount"] = odd,
            ["evenCount"] = even,
            ["oddEven"] = odd >= even ? "ODD" : "EVEN",
            ["bigCount"] = big,
            ["smallCount"] = small,
            ["bigSmall"] = big >= small ? "BIG" : "SMALL",
            ["upDown"] = small >= big ? "DOWN" : "UP",
            ["dragonSum"] = firstHalf,
            ["tigerSum"] = secondHalf,
            ["dragonTiger"] = firstHalf >= secondHalf ? "DRAGON" : "TIGER",
            ["sum"] = sum,
            ["sumThreshold"] = threshold,
            ["sumOverUnder"] = sum >= threshold ? "OVER" : "UNDER",
            ["element"] = element
        };
    }

    private static decimal LookupPayout(
        IReadOnlyDictionary<string, object?> ticket,
        KenoConfiguration configuration,
        WagerType wagerType,
        int spotCount,
        int hitCount,
        bool won,
        string? selection)
    {
        if (!won) return 0m;
        var paytable = ReadDictionary(ticket, "paytable") ?? new Dictionary<string, object?>();
        var keys = new[]
        {
            $"{wagerType}:{spotCount}:{hitCount}",
            string.IsNullOrWhiteSpace(selection) ? string.Empty : $"{wagerType}:{selection}:WIN",
            $"{wagerType}:WIN",
            $"{configuration.PaytableVersion}:{wagerType}:{spotCount}:{hitCount}",
            $"{configuration.PaytableVersion}:{wagerType}:WIN"
        };

        foreach (var key in keys.Where(key => !string.IsNullOrWhiteSpace(key)))
        {
            if (paytable.TryGetValue(key, out var value) && TryDecimal(value, out var payout))
            {
                return payout;
            }
        }

        return 0m;
    }

    private static GameEvaluationOutput Rejected(GameEvaluationInput input, ValidationResult validation, GameEvaluationReason reason)
    {
        return new GameEvaluationOutput(
            input.TicketId,
            GameEvaluationOutcome.Rejected,
            reason,
            input.Stake with { PayoutAmount = 0m, NetAmount = -input.Stake.StakeAmount },
            input.Metadata,
            validation,
            new Dictionary<string, object?> { ["reasonCode"] = reason.ToString(), ["moduleVersion"] = "0.1.0-reference" });
    }

    private static void ValidateNumbers(IReadOnlyCollection<int> numbers, KenoConfiguration configuration, string field, List<ValidationError> errors)
    {
        if (numbers.Count != numbers.Distinct().Count())
        {
            errors.Add(Error(ValidationCode.InvalidTicket, field, "Keno numbers must be unique."));
        }

        if (numbers.Any(number => number < configuration.NumberRangeMin || number > configuration.NumberRangeMax))
        {
            errors.Add(Error(ValidationCode.InvalidTicket, field, "Keno numbers are outside the configured range."));
        }
    }

    private static ValidationError Error(ValidationCode code, string field, string message)
    {
        return new ValidationError(code, field, message, ValidationSeverity.Error);
    }

    private static IReadOnlyDictionary<string, object?>? ReadDictionary(IReadOnlyDictionary<string, object?> payload, string key)
    {
        return payload.TryGetValue(key, out var value) ? value as IReadOnlyDictionary<string, object?> : null;
    }

    private static IReadOnlyCollection<int> ReadIntCollection(IReadOnlyDictionary<string, object?> payload, string key)
    {
        if (!payload.TryGetValue(key, out var value) || value is null) return [];
        if (value is int[] intArray) return intArray;
        if (value is IEnumerable<int> intValues) return intValues.ToArray();
        if (value is IEnumerable<object> objectValues)
        {
            return objectValues.Select(item => Convert.ToInt32(item)).ToArray();
        }

        return [];
    }

    private static int? ReadInt(IReadOnlyDictionary<string, object?> payload, string key)
    {
        if (!payload.TryGetValue(key, out var value) || value is null) return null;
        return Convert.ToInt32(value);
    }

    private static bool? ReadBool(IReadOnlyDictionary<string, object?> payload, string key)
    {
        if (!payload.TryGetValue(key, out var value) || value is null) return null;
        return value is bool boolean ? boolean : bool.Parse(value.ToString() ?? "false");
    }

    private static string? ReadString(IReadOnlyDictionary<string, object?> payload, string key)
    {
        return payload.TryGetValue(key, out var value) ? value?.ToString() : null;
    }

    private static bool TryDecimal(object? value, out decimal parsed)
    {
        if (value is decimal decimalValue)
        {
            parsed = decimalValue;
            return true;
        }

        return decimal.TryParse(value?.ToString(), out parsed);
    }
}

public sealed record KenoConfiguration(
    int NumberRangeMin,
    int NumberRangeMax,
    int NumbersDrawn,
    IReadOnlyCollection<int> AllowedSpotCounts,
    bool BullseyeEnabled,
    bool InternalDrawGenerationEnabled,
    string PaytableVersion,
    string DrawAuthorityMode,
    IReadOnlyCollection<WagerType> SupportedWagerTypes);

internal sealed record ParsedConfiguration(KenoConfiguration Configuration, ValidationResult Validation);

internal sealed record KenoWagerResult(bool Won, GameEvaluationReason Reason, bool? BullseyeMatch, string? Selection);
