using GameEngine.Domain.Model;
using GameEngine.Domain.Modules;

namespace GameEngine.Modules.Tests;

public abstract class GameModuleContractTestBase<TModule>
    where TModule :
        IGameModule,
        IGameConfigurationValidator,
        IGameTicketValidator,
        IGameDrawGenerator,
        IGameEvaluator,
        IGameModuleHealthCheck,
        IGameModuleFixtureProvider
{
    protected abstract TModule CreateModule();

    public void RunContractTests()
    {
        var module = CreateModule();
        var manifest = module.GetManifest();

        Assert(!string.IsNullOrWhiteSpace(manifest.ModuleId), "Manifest module id is required.");
        Assert(!string.IsNullOrWhiteSpace(manifest.ModuleName), "Manifest module name is required.");
        Assert(!string.IsNullOrWhiteSpace(manifest.ModuleVersion), "Manifest module version is required.");
        Assert(manifest.GameTypes.Count > 0, "Manifest must declare supported game types.");
        Assert(manifest.SupportedWagerTypes.Count > 0, "Manifest must declare supported wager types.");
        Assert(!string.IsNullOrWhiteSpace(manifest.ConfigurationSchemaVersion), "Configuration schema version is required.");
        Assert(!string.IsNullOrWhiteSpace(manifest.EvaluatorVersion), "Evaluator version is required.");
        Assert(!string.IsNullOrWhiteSpace(manifest.DrawGeneratorVersion), "Draw generator version is required.");
        Assert(!string.IsNullOrWhiteSpace(manifest.MinimumGameEngineVersion), "Minimum Game Engine version is required.");
        Assert(!string.IsNullOrWhiteSpace(manifest.Checksum), "Manifest checksum placeholder is required.");

        var metadata = module.GetVersionMetadata();
        Assert(!string.IsNullOrWhiteSpace(metadata.ModuleVersion), "Version metadata module version is required.");
        Assert(!string.IsNullOrWhiteSpace(metadata.EvaluatorVersion), "Version metadata evaluator version is required.");

        var configuration = module.ValidateConfiguration(new Dictionary<string, object?>());
        Assert(configuration.Accepted, "Default contract configuration must be accepted.");
        Assert(configuration.Validation.IsValid, "Configuration validation result must be valid.");

        var health = module.HealthCheck();
        Assert(health.Status == GameModuleHealthStatus.Healthy, "Health check must be healthy.");

        var fixtures = module.GetDeterministicFixtures();
        Assert(fixtures.Count > 0, "Deterministic fixtures must be discoverable.");

        foreach (var fixture in fixtures)
        {
            var validation = module.ValidateTicket(fixture.InputTicket);
            Assert(validation.Accepted == fixture.ExpectedValidationResult, $"Fixture {fixture.FixtureId} validation mismatch.");
            Assert(validation.Validation.Errors.All(error => error.Code != ValidationCode.None), $"Fixture {fixture.FixtureId} errors must use structured codes.");

            if (!fixture.ExpectedValidationResult) continue;

            var output = module.EvaluateTicket(CreateEvaluationInput(module, manifest, fixture));
            Assert(output.Outcome == fixture.ExpectedOutcome, $"Fixture {fixture.FixtureId} outcome mismatch.");
            Assert(output.Reason == fixture.ExpectedReasonCode, $"Fixture {fixture.FixtureId} reason mismatch.");
            Assert(output.Amount.PayoutAmount == fixture.ExpectedPayout.PayoutAmount, $"Fixture {fixture.FixtureId} payout mismatch.");
        }

        var invalidTicket = module.ValidateTicket(new TicketValidationRequest(
            Guid.NewGuid(),
            Guid.NewGuid(),
            Guid.Empty,
            manifest.GameTypes.First(),
            manifest.SupportedWagerTypes.First(),
            new Dictionary<string, object?>()));
        Assert(!invalidTicket.Accepted, "Invalid tickets must be rejected.");
        Assert(invalidTicket.Validation.Errors.Count > 0, "Invalid tickets must return structured validation errors.");
        Assert(invalidTicket.Validation.Errors.All(error => error.Code != ValidationCode.None), "Invalid ticket errors must use structured codes.");

        var drawRequest = new DrawGenerationRequest(
            Guid.NewGuid(),
            Guid.NewGuid(),
            Guid.NewGuid(),
            DateTimeOffset.UtcNow);
        if (!manifest.SupportsInternalDrawGeneration)
        {
            Assert(!module.CanGenerateDraw(drawRequest), "Unsupported draw generation must be reported as unavailable.");
            var drawResult = module.GenerateDraw(drawRequest);
            Assert(!drawResult.Generated, "Unsupported draw generation must be safely rejected.");
            Assert(!drawResult.Validation.IsValid, "Unsupported draw generation must return a validation failure.");
        }

        var gate = GameModuleLifecycleGate.Evaluate(module, module, module, module, module, module);
        if (manifest.LifecycleStatus is GameModuleLifecycleStatus.Approved or GameModuleLifecycleStatus.ProductionActive)
        {
            Assert(gate.ProductionReady, "Approved modules with passing contracts should be production-ready.");
        }
        else
        {
            Assert(!gate.ProductionReady, "Non-approved modules must not be production-ready.");
        }
    }

    private static GameEvaluationInput CreateEvaluationInput(
        IGameModule module,
        GameModuleManifest manifest,
        GameModuleFixture fixture)
    {
        return new GameEvaluationInput(
            Guid.NewGuid(),
            Guid.NewGuid(),
            fixture.InputTicket.GameType,
            fixture.InputTicket.WagerType,
            fixture.InputTicket.Payload,
            fixture.DrawResult,
            fixture.ExpectedPayout with { PayoutAmount = 0, NetAmount = -fixture.ExpectedPayout.StakeAmount },
            new GameEvaluationMetadata(
                manifest.ModuleId,
                module.GetVersion(),
                manifest.EvaluatorVersion,
                "contract-paytable",
                manifest.DrawGeneratorVersion,
                "contract-game-definition",
                "contract-prng-provider",
                "contract-draw-authority",
                $"contract-{fixture.FixtureId}"));
    }

    protected static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}

