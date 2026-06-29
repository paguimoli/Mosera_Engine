using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using GameEngine.Domain.Modules;
using GameEngine.Modules.TestModule;
using GameEngine.Modules.HotSpot;
using GameEngine.Modules.Tests;

new TestModuleContractTests().RunContractTests();
new HotSpotModuleContractTests().RunContractTests();
RunRegistryTests();

Console.WriteLine("GameEngine.Modules.Tests PASS");

static void RunRegistryTests()
{
    var registry = new GameModuleRegistry();
    var registered = registry.GetRegisteredModules();
    var rejected = registry.GetRejectedModules();

    Assert(registered.Any(module => module.ModuleId == "HOT_SPOT"), "HotSpot module should be discovered.");
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
