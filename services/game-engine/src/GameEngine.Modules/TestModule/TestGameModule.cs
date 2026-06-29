using GameEngine.Domain.Model;
using GameEngine.Domain.Modules;

namespace GameEngine.Modules.TestModule;

public sealed class TestGameModule :
    IGameModule,
    IGameModuleManifestProvider,
    IGameTicketValidator,
    IGameDrawGenerator,
    IGameEvaluator,
    IGameConfigurationValidator,
    IGameModuleHealthCheck,
    IGameModuleFixtureProvider
{
    public string ModuleId => "TEST_MODULE";

    public string GetVersion() => "0.0.0-skeleton";

    public GameModuleManifest GetManifest()
    {
        return new GameModuleManifest(
            ModuleId,
            "Test Module",
            GetVersion(),
            [GameType.Test],
            [WagerType.TestWager],
            [DrawProviderType.InternalPrng, DrawProviderType.ManualCertifiedEntry],
            SupportsInternalDrawGeneration: true,
            SupportsExternalResultEvaluation: false,
            SupportsManualResultEvaluation: true,
            ConfigurationSchemaVersion: "test-config-schema-0",
            EvaluatorVersion: "test-evaluator-0",
            DrawGeneratorVersion: "test-draw-generator-0",
            MinimumGameEngineVersion: "0.1.0",
            GameModuleLifecycleStatus.InternalTesting,
            "checksum-placeholder-test-module",
            DateTimeOffset.UnixEpoch,
            "build-placeholder");
    }

    public GameModuleVersionMetadata GetVersionMetadata()
    {
        return new GameModuleVersionMetadata(
            GetVersion(),
            "test-evaluator-0",
            "test-draw-generator-0",
            "test-config-schema-0",
            "0.1.0",
            "0.1.0",
            "checksum-placeholder-test-module");
    }

    public IReadOnlyCollection<GameType> GetSupportedGameTypes()
    {
        return [GameType.Test];
    }

    public IReadOnlyCollection<WagerType> GetSupportedWagerTypes()
    {
        return [WagerType.TestWager];
    }

    public ConfigurationValidationResult ValidateConfiguration(IReadOnlyDictionary<string, object?> configuration)
    {
        return new ConfigurationValidationResult(
            true,
            ValidationResult.Success(),
            "test-configuration-hash");
    }

    public TicketValidationResult ValidateTicket(TicketValidationRequest request)
    {
        if (request.GameType != GameType.Test)
        {
            return new TicketValidationResult(
                false,
                ValidationResult.Failure(new ValidationError(
                    ValidationCode.UnsupportedGameType,
                    nameof(request.GameType),
                    "Unsupported game type.",
                    ValidationSeverity.Error)),
                "invalid-game-type");
        }

        if (request.WagerType != WagerType.TestWager)
        {
            return new TicketValidationResult(
                false,
                ValidationResult.Failure(new ValidationError(
                    ValidationCode.UnsupportedWagerType,
                    nameof(request.WagerType),
                    "Unsupported wager type.",
                    ValidationSeverity.Error)),
                "invalid-wager-type");
        }

        if (!request.Payload.TryGetValue("pick", out var pick) || pick?.ToString() != "A")
        {
            return new TicketValidationResult(
                false,
                ValidationResult.Failure(new ValidationError(
                    ValidationCode.InvalidTicket,
                    "payload.pick",
                    "Test fixture pick must be A.",
                    ValidationSeverity.Error)),
                "invalid-ticket");
        }

        return new TicketValidationResult(true, ValidationResult.Success(), "valid-test-ticket");
    }

    public bool CanGenerateDraw(DrawGenerationRequest request) => true;

    public DrawGenerationResult GenerateDraw(DrawGenerationRequest request)
    {
        return new DrawGenerationResult(
            true,
            "test-draw-result-a",
            new Dictionary<string, object?> { ["result"] = "A" },
            new DrawGenerationMetadata(
                GetVersion(),
                "test-draw-generator-0",
                "test-prng-provider-0",
                "test-draw-authority-0",
                "test-algorithm-0",
                "test-payload-hash"),
            ValidationResult.Success());
    }

    public GameEvaluationOutput EvaluateTicket(GameEvaluationInput input)
    {
        var validation = ValidateTicket(new TicketValidationRequest(
            Guid.NewGuid(),
            Guid.NewGuid(),
            Guid.Empty,
            input.GameType,
            input.WagerType,
            input.TicketPayload));

        if (!validation.Accepted)
        {
            return new GameEvaluationOutput(
                input.TicketId,
                GameEvaluationOutcome.Rejected,
                GameEvaluationReason.InvalidTicket,
                input.Stake,
                input.Metadata,
                validation.Validation,
                new Dictionary<string, object?>());
        }

        var matched = input.DrawResultPayload.TryGetValue("result", out var result)
            && result?.ToString() == input.TicketPayload["pick"]?.ToString();
        var payout = matched ? input.Stake.StakeAmount * 2 : 0;
        var outcome = matched ? GameEvaluationOutcome.Win : GameEvaluationOutcome.Loss;
        var reason = matched ? GameEvaluationReason.FixtureMatch : GameEvaluationReason.NoMatch;

        return new GameEvaluationOutput(
            input.TicketId,
            outcome,
            reason,
            new GameEvaluationAmount(input.Stake.Currency, input.Stake.StakeAmount, payout, payout - input.Stake.StakeAmount),
            input.Metadata,
            ValidationResult.Success(),
            new Dictionary<string, object?>
            {
                ["outcome"] = outcome.ToString(),
                ["reason"] = reason.ToString(),
                ["payoutAmount"] = payout
            });
    }

    public IReadOnlyCollection<GameEvaluationOutput> EvaluateBatch(IReadOnlyCollection<GameEvaluationInput> inputs)
    {
        return inputs.Select(EvaluateTicket).ToArray();
    }

    public IReadOnlyCollection<GameModuleFixture> GetDeterministicFixtures()
    {
        return
        [
            new GameModuleFixture(
                "test-win-fixture",
                new TicketValidationRequest(
                    Guid.NewGuid(),
                    Guid.NewGuid(),
                    Guid.Empty,
                    GameType.Test,
                    WagerType.TestWager,
                    new Dictionary<string, object?> { ["pick"] = "A" }),
                new Dictionary<string, object?> { ["result"] = "A" },
                GameEvaluationOutcome.Win,
                new GameEvaluationAmount("USD", 10m, 20m, 10m),
                true,
                GameEvaluationReason.FixtureMatch)
        ];
    }

    public GameModuleHealthCheckResult HealthCheck()
    {
        return new GameModuleHealthCheckResult(
            GameModuleHealthStatus.Healthy,
            ModuleId,
            GetVersion(),
            ["Skeleton module only; no production game logic is implemented."],
            DateTimeOffset.UtcNow);
    }
}
