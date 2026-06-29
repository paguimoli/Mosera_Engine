using GameEngine.Domain.Model;
using GameEngine.Domain.Modules;

namespace GameEngine.Modules.HotSpot;

public sealed class HotSpotModule :
    IGameModule,
    IGameModuleManifestProvider,
    IGameTicketValidator,
    IGameDrawGenerator,
    IGameEvaluator,
    IGameConfigurationValidator,
    IGameModuleHealthCheck,
    IGameModuleFixtureProvider
{
    public string ModuleId => "HOT_SPOT";

    public string GetVersion() => "0.0.0-skeleton";

    public GameModuleManifest GetManifest()
    {
        return new GameModuleManifest(
            ModuleId,
            "Hot Spot",
            GetVersion(),
            [GameType.HotSpot],
            [WagerType.Straight],
            [DrawProviderType.ManualCertifiedEntry],
            SupportsInternalDrawGeneration: false,
            SupportsExternalResultEvaluation: false,
            SupportsManualResultEvaluation: true,
            ConfigurationSchemaVersion: "hot-spot-config-schema-0",
            EvaluatorVersion: "hot-spot-evaluator-0",
            DrawGeneratorVersion: "not-supported",
            MinimumGameEngineVersion: "0.1.0",
            GameModuleLifecycleStatus.Development,
            "checksum-placeholder-hot-spot",
            DateTimeOffset.UnixEpoch,
            "build-placeholder");
    }

    public GameModuleVersionMetadata GetVersionMetadata()
    {
        return new GameModuleVersionMetadata(
            GetVersion(),
            "hot-spot-evaluator-0",
            "not-supported",
            "hot-spot-config-schema-0",
            "0.1.0",
            "0.1.0",
            "checksum-placeholder-hot-spot");
    }

    public IReadOnlyCollection<GameType> GetSupportedGameTypes()
    {
        return [GameType.HotSpot];
    }

    public IReadOnlyCollection<WagerType> GetSupportedWagerTypes()
    {
        return [WagerType.Straight];
    }

    public ConfigurationValidationResult ValidateConfiguration(IReadOnlyDictionary<string, object?> configuration)
    {
        return new ConfigurationValidationResult(
            true,
            ValidationResult.Success([new ValidationWarning(
                ValidationCode.None,
                "module",
                "HotSpot is a non-production placeholder.")]),
            "hot-spot-configuration-placeholder");
    }

    public TicketValidationResult ValidateTicket(TicketValidationRequest request)
    {
        if (request.GameType != GameType.HotSpot)
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

        if (request.WagerType != WagerType.Straight)
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

        if (!request.Payload.ContainsKey("spots"))
        {
            return new TicketValidationResult(
                false,
                ValidationResult.Failure(new ValidationError(
                    ValidationCode.InvalidTicket,
                    "payload.spots",
                    "Spot selections are required.",
                    ValidationSeverity.Error)),
                "invalid-hot-spot-ticket");
        }

        return new TicketValidationResult(true, ValidationResult.Success(), "valid-hot-spot-placeholder-ticket");
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
                "not-supported",
                "not-supported",
                "manual-placeholder",
                "not-supported",
                string.Empty),
            ValidationResult.Failure(new ValidationError(
                ValidationCode.DrawGenerationUnsupported,
                "drawGeneration",
                "HotSpot placeholder does not claim internal draw generation support.",
                ValidationSeverity.Error)));
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

        return new GameEvaluationOutput(
            input.TicketId,
            GameEvaluationOutcome.Loss,
            GameEvaluationReason.NoMatch,
            input.Stake with { PayoutAmount = 0, NetAmount = -input.Stake.StakeAmount },
            input.Metadata,
            ValidationResult.Success([new ValidationWarning(
                ValidationCode.None,
                "module",
                "Placeholder evaluator returned deterministic non-production loss.")]),
            new Dictionary<string, object?>
            {
                ["outcome"] = GameEvaluationOutcome.Loss.ToString(),
                ["placeholder"] = true
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
                "hot-spot-placeholder-loss",
                new TicketValidationRequest(
                    Guid.NewGuid(),
                    Guid.NewGuid(),
                    Guid.Empty,
                    GameType.HotSpot,
                    WagerType.Straight,
                    new Dictionary<string, object?> { ["spots"] = new[] { 1, 2, 3 } }),
                new Dictionary<string, object?> { ["draw"] = new[] { 4, 5, 6 } },
                GameEvaluationOutcome.Loss,
                new GameEvaluationAmount("USD", 10m, 0m, -10m),
                true,
                GameEvaluationReason.NoMatch)
        ];
    }

    public GameModuleHealthCheckResult HealthCheck()
    {
        return new GameModuleHealthCheckResult(
            GameModuleHealthStatus.Healthy,
            ModuleId,
            GetVersion(),
            ["Placeholder module only; not approved for production."],
            DateTimeOffset.UtcNow);
    }
}
