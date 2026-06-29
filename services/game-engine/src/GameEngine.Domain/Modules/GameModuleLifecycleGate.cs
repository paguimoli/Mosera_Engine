using GameEngine.Domain.Model;

namespace GameEngine.Domain.Modules;

public sealed record GameModuleLifecycleGateResult(
    bool ProductionReady,
    IReadOnlyCollection<string> Blockers,
    IReadOnlyCollection<string> Warnings);

public static class GameModuleLifecycleGate
{
    public static GameModuleLifecycleGateResult Evaluate(
        IGameModule module,
        IGameConfigurationValidator configurationValidator,
        IGameTicketValidator ticketValidator,
        IGameEvaluator evaluator,
        IGameModuleHealthCheck healthCheck,
        IGameModuleFixtureProvider fixtureProvider)
    {
        var blockers = new List<string>();
        var warnings = new List<string>();
        var manifest = module.GetManifest();
        var versionMetadata = module.GetVersionMetadata();

        if (manifest.LifecycleStatus is not (GameModuleLifecycleStatus.Approved or GameModuleLifecycleStatus.ProductionActive))
        {
            blockers.Add("Lifecycle status must be Approved or ProductionActive.");
        }

        if (string.IsNullOrWhiteSpace(manifest.ModuleId)) blockers.Add("Module id is required.");
        if (string.IsNullOrWhiteSpace(manifest.ModuleVersion)) blockers.Add("Module version is required.");
        if (string.IsNullOrWhiteSpace(manifest.EvaluatorVersion)) blockers.Add("Evaluator version is required.");
        if (string.IsNullOrWhiteSpace(manifest.ConfigurationSchemaVersion)) blockers.Add("Configuration schema version is required.");
        if (string.IsNullOrWhiteSpace(versionMetadata.MinimumGameEngineVersion)) blockers.Add("Minimum Game Engine version is required.");
        if (manifest.GameTypes.Count == 0) blockers.Add("At least one game type is required.");
        if (manifest.SupportedWagerTypes.Count == 0) blockers.Add("At least one supported wager type is required.");

        var configurationResult = configurationValidator.ValidateConfiguration(new Dictionary<string, object?>());
        if (!configurationResult.Validation.IsValid) blockers.Add("Configuration validation must pass for default contract fixture.");

        var health = healthCheck.HealthCheck();
        if (health.Status != GameModuleHealthStatus.Healthy) blockers.Add("Health check must be healthy.");

        var fixtures = fixtureProvider.GetDeterministicFixtures();
        if (fixtures.Count == 0)
        {
            blockers.Add("At least one deterministic fixture is required.");
        }

        foreach (var fixture in fixtures)
        {
            var validation = ticketValidator.ValidateTicket(fixture.InputTicket);
            if (validation.Accepted != fixture.ExpectedValidationResult)
            {
                blockers.Add($"Fixture {fixture.FixtureId} validation result mismatch.");
            }

            if (!validation.Accepted)
            {
                continue;
            }

            var evaluation = evaluator.EvaluateTicket(CreateEvaluationInput(module, manifest, fixture));
            if (evaluation.Outcome != fixture.ExpectedOutcome)
            {
                blockers.Add($"Fixture {fixture.FixtureId} outcome mismatch.");
            }

            if (evaluation.Reason != fixture.ExpectedReasonCode)
            {
                blockers.Add($"Fixture {fixture.FixtureId} reason mismatch.");
            }

            if (evaluation.Amount.PayoutAmount != fixture.ExpectedPayout.PayoutAmount)
            {
                blockers.Add($"Fixture {fixture.FixtureId} payout mismatch.");
            }
        }

        if (!manifest.SupportsInternalDrawGeneration)
        {
            warnings.Add("Internal draw generation is not supported by this module.");
        }

        return new GameModuleLifecycleGateResult(blockers.Count == 0, blockers, warnings);
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
                "fixture-paytable",
                manifest.DrawGeneratorVersion,
                "fixture-game-definition",
                "fixture-prng-provider",
                "fixture-draw-authority",
                $"fixture-{fixture.FixtureId}"));
    }
}
