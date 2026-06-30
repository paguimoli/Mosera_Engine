using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using GameEngine.Domain.Modules;
using GameEngine.Modules.TestModule;
using GameEngine.Modules.HotSpot;
using GameEngine.Modules.Keno;
using GameEngine.Modules.Tests;

new TestModuleContractTests().RunContractTests();
new HotSpotModuleContractTests().RunContractTests();
new KenoModuleContractTests().RunContractTests();
RunKenoModuleTests();
RunRegistryTests();

Console.WriteLine("GameEngine.Modules.Tests PASS");

static void RunRegistryTests()
{
    var registry = new GameModuleRegistry();
    var registered = registry.GetRegisteredModules();
    var rejected = registry.GetRejectedModules();

    Assert(registered.Any(module => module.ModuleId == "HOT_SPOT"), "HotSpot module should be discovered.");
    Assert(registered.Any(module => module.ModuleId == "KENO_GENERIC"), "Generic Keno module should be discovered.");
    Assert(registered.Any(module => module.ModuleId == "TEST_MODULE"), "Test module should be discovered.");
    Assert(rejected.Any(module => module.ModuleId == "INVALID_TEST_MODULE"), "Invalid module should be rejected.");
    Assert(rejected.Any(module => module.ModuleId == "TEST_MODULE"), "Duplicate module id/version should be rejected.");
    Assert(registry.GetModuleVersions("TEST_MODULE").Count >= 2, "Module versions endpoint model should include registered and rejected duplicate evidence.");
    Assert(registry.GetActiveModules().Count == 0, "Placeholder modules must not be active.");
    Assert(registry.GetProductionReadyModules().Count == 0, "Placeholder modules must not be production ready.");

    var status = registry.GetRegistryStatus();
    Assert(status.Health == GameModuleRegistryHealth.Warning, "Registry should report warning while modules are non-production placeholders.");

    var binding = registry.CreateProspectiveBinding(new GameBindingRequest(
        "registry-test-binding",
        "Registry Test Binding",
        GameType.Test,
        WagerType.TestWager,
        "TEST_MODULE",
        GameModuleVersionSelectionMode.LatestApproved,
        null,
        DrawProviderType.ManualCertifiedEntry,
        "manual-registry-test-schedule",
        SettlementTriggerPolicy.Manual,
        new Dictionary<string, object?>(),
        new Dictionary<string, object?>()));
    Assert(binding.Versions.Single().Status == GameBindingStatus.Validated, "Prospective binding should validate with compatible module settings.");

    var invalidBinding = registry.CreateProspectiveBinding(new GameBindingRequest(
        "registry-invalid-binding",
        "Registry Invalid Binding",
        GameType.HotSpot,
        WagerType.TestWager,
        "HOT_SPOT",
        GameModuleVersionSelectionMode.SpecificVersion,
        "0.0.0-skeleton",
        DrawProviderType.InternalPrng,
        "",
        SettlementTriggerPolicy.Manual,
        new Dictionary<string, object?>(),
        new Dictionary<string, object?>()));
    Assert(invalidBinding.Versions.Single().Status == GameBindingStatus.Rejected, "Invalid binding configuration should be rejected.");
}

static void RunKenoModuleTests()
{
    var module = new KenoModule();
    var manifest = module.GetManifest();

    Assert(manifest.ModuleName == "Generic Keno Module", "Keno manifest should identify the generic module.");
    Assert(manifest.LifecycleStatus == GameModuleLifecycleStatus.QaCertified, "Keno module should remain non-production.");
    Assert(!manifest.SupportsInternalDrawGeneration, "Keno internal draw generation must be disabled by default.");
    Assert(manifest.SupportedWagerTypes.Contains(WagerType.KenoSpot), "Keno spot wager must be declared.");
    Assert(manifest.SupportedWagerTypes.Contains(WagerType.KenoBullseye), "Keno bullseye wager must be declared.");
    Assert(manifest.SupportedWagerTypes.Contains(WagerType.KenoElement), "Keno element wager must be declared.");

    var validConfiguration = module.ValidateConfiguration(new Dictionary<string, object?>
    {
        ["numberRangeMin"] = 1,
        ["numberRangeMax"] = 80,
        ["numbersDrawn"] = 20,
        ["allowedSpotCounts"] = Enumerable.Range(1, 10).ToArray(),
        ["bullseyeEnabled"] = true,
        ["internalDrawGenerationEnabled"] = false,
        ["paytableVersion"] = "REFERENCE_PAYTABLE_V1",
        ["drawAuthorityMode"] = "OFFICIAL_OR_MANUAL"
    });
    Assert(validConfiguration.Accepted, "Keno reference configuration should validate.");

    var invalidConfiguration = module.ValidateConfiguration(new Dictionary<string, object?>
    {
        ["internalDrawGenerationEnabled"] = true
    });
    Assert(!invalidConfiguration.Accepted, "Keno production draw generation should not be approved.");

    var validTicket = module.ValidateTicket(new TicketValidationRequest(
        Guid.NewGuid(),
        Guid.NewGuid(),
        Guid.Empty,
        GameType.Keno,
        WagerType.KenoSpot,
        new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } }));
    Assert(validTicket.Accepted, "Valid Keno spot ticket should be accepted.");

    var duplicateTicket = module.ValidateTicket(new TicketValidationRequest(
        Guid.NewGuid(),
        Guid.NewGuid(),
        Guid.Empty,
        GameType.Keno,
        WagerType.KenoSpot,
        new Dictionary<string, object?> { ["numbers"] = new[] { 1, 1, 2 } }));
    Assert(!duplicateTicket.Accepted, "Duplicate Keno ticket numbers should be rejected.");

    var outOfRangeTicket = module.ValidateTicket(new TicketValidationRequest(
        Guid.NewGuid(),
        Guid.NewGuid(),
        Guid.Empty,
        GameType.Keno,
        WagerType.KenoSpot,
        new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 81 } }));
    Assert(!outOfRangeTicket.Accepted, "Out-of-range Keno ticket numbers should be rejected.");

    var invalidDraw = module.ValidateDrawResult(new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3 } });
    Assert(!invalidDraw.IsValid, "Invalid Keno draw result should be rejected.");

    foreach (var fixture in module.GetDeterministicFixtures().Where(fixture => fixture.ExpectedValidationResult))
    {
        var output = module.EvaluateTicket(CreateKenoInput(module, fixture));
        Assert(output.Outcome == fixture.ExpectedOutcome, $"Keno fixture {fixture.FixtureId} outcome mismatch.");
        Assert(output.Reason == fixture.ExpectedReasonCode, $"Keno fixture {fixture.FixtureId} reason mismatch.");
        Assert(output.Amount.PayoutAmount == fixture.ExpectedPayout.PayoutAmount, $"Keno fixture {fixture.FixtureId} payout mismatch.");
        Assert(output.SettlementFacts.ContainsKey("reasonCode"), $"Keno fixture {fixture.FixtureId} should emit structured reason code.");
        Assert(output.Metadata.ModuleId == module.ModuleId, $"Keno fixture {fixture.FixtureId} should emit module metadata.");
    }

    var drawRequest = new DrawGenerationRequest(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), DateTimeOffset.UtcNow);
    Assert(!module.CanGenerateDraw(drawRequest), "Keno draw generation should be disabled.");
    Assert(!module.GenerateDraw(drawRequest).Generated, "Keno draw generation should not produce a draw.");
}

static GameEvaluationInput CreateKenoInput(KenoModule module, GameModuleFixture fixture)
{
    var manifest = module.GetManifest();
    return new GameEvaluationInput(
        Guid.NewGuid(),
        Guid.NewGuid(),
        fixture.InputTicket.GameType,
        fixture.InputTicket.WagerType,
        fixture.InputTicket.Payload,
        fixture.DrawResult,
        fixture.ExpectedPayout with { PayoutAmount = 0m, NetAmount = -fixture.ExpectedPayout.StakeAmount },
        new GameEvaluationMetadata(
            module.ModuleId,
            module.GetVersion(),
            manifest.EvaluatorVersion,
            "REFERENCE_PAYTABLE_V1",
            manifest.DrawGeneratorVersion,
            "keno-reference-game-definition",
            "not-approved",
            "official-or-manual",
            $"keno-fixture-{fixture.FixtureId}"));
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

internal sealed class TestModuleContractTests : GameModuleContractTestBase<TestGameModule>
{
    protected override TestGameModule CreateModule() => new();
}

internal sealed class HotSpotModuleContractTests : GameModuleContractTestBase<HotSpotModule>
{
    protected override HotSpotModule CreateModule() => new();
}

internal sealed class KenoModuleContractTests : GameModuleContractTestBase<KenoModule>
{
    protected override KenoModule CreateModule() => new();
}

public sealed class InvalidTestModule : IGameModule
{
    public string ModuleId => "INVALID_TEST_MODULE";

    public GameModuleManifest GetManifest()
    {
        return new GameModuleManifest(
            ModuleId,
            "Invalid Test Module",
            "0.0.0-invalid",
            [],
            [],
            [],
            false,
            false,
            false,
            "",
            "",
            "",
            "",
            GameModuleLifecycleStatus.Development,
            "",
            DateTimeOffset.UnixEpoch,
            "invalid");
    }

    public string GetVersion() => "0.0.0-invalid";

    public GameModuleVersionMetadata GetVersionMetadata()
    {
        return new GameModuleVersionMetadata("", "", "", "", "", "", "");
    }

    public IReadOnlyCollection<GameType> GetSupportedGameTypes() => [];

    public IReadOnlyCollection<WagerType> GetSupportedWagerTypes() => [];
}

public sealed class DuplicateTestModule :
    IGameModule,
    IGameModuleManifestProvider,
    IGameTicketValidator,
    IGameDrawGenerator,
    IGameEvaluator,
    IGameConfigurationValidator,
    IGameModuleHealthCheck,
    IGameModuleFixtureProvider
{
    private readonly TestGameModule inner = new();

    public string ModuleId => inner.ModuleId;

    public GameModuleManifest GetManifest() => inner.GetManifest();

    public string GetVersion() => inner.GetVersion();

    public GameModuleVersionMetadata GetVersionMetadata() => inner.GetVersionMetadata();

    public IReadOnlyCollection<GameType> GetSupportedGameTypes() => inner.GetSupportedGameTypes();

    public IReadOnlyCollection<WagerType> GetSupportedWagerTypes() => inner.GetSupportedWagerTypes();

    public TicketValidationResult ValidateTicket(TicketValidationRequest request) => inner.ValidateTicket(request);

    public bool CanGenerateDraw(DrawGenerationRequest request) => inner.CanGenerateDraw(request);

    public DrawGenerationResult GenerateDraw(DrawGenerationRequest request) => inner.GenerateDraw(request);

    public GameEvaluationOutput EvaluateTicket(GameEvaluationInput input) => inner.EvaluateTicket(input);

    public IReadOnlyCollection<GameEvaluationOutput> EvaluateBatch(IReadOnlyCollection<GameEvaluationInput> inputs) => inner.EvaluateBatch(inputs);

    public ConfigurationValidationResult ValidateConfiguration(IReadOnlyDictionary<string, object?> configuration) => inner.ValidateConfiguration(configuration);

    public GameModuleHealthCheckResult HealthCheck() => inner.HealthCheck();

    public IReadOnlyCollection<GameModuleFixture> GetDeterministicFixtures() => inner.GetDeterministicFixtures();
}
