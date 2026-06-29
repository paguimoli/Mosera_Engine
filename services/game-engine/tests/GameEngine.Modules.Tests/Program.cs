using GameEngine.Modules.TestModule;
using GameEngine.Modules.HotSpot;
using GameEngine.Modules.Tests;

new TestModuleContractTests().RunContractTests();
new HotSpotModuleContractTests().RunContractTests();

Console.WriteLine("GameEngine.Modules.Tests PASS");

internal sealed class TestModuleContractTests : GameModuleContractTestBase<TestGameModule>
{
    protected override TestGameModule CreateModule() => new();
}

internal sealed class HotSpotModuleContractTests : GameModuleContractTestBase<HotSpotModule>
{
    protected override HotSpotModule CreateModule() => new();
}
