using GameEngine.Modules.HotSpot;
using GameEngine.Modules.TestModule;

var hotSpot = new HotSpotModule();
var testModule = new TestGameModule();

if (hotSpot.ModuleCode != "HOT_SPOT")
{
    throw new InvalidOperationException("HotSpot module code changed.");
}

if (!testModule.SupportedWagers().Contains("TEST_WAGER"))
{
    throw new InvalidOperationException("Test module supported wager missing.");
}

Console.WriteLine("GameEngine.Modules.Tests PASS");
