using GameEngine.Application.Services;

var statusService = new GameEngineStatusService();
var status = statusService.GetStatus();
var modules = statusService.ListModuleStatuses();

if (status.ProductionGameLogicEnabled)
{
    throw new InvalidOperationException("Skeleton must not enable production game logic.");
}

if (status.ProductionRngEnabled)
{
    throw new InvalidOperationException("Skeleton must not enable production RNG.");
}

if (status.SettlementIntegrationEnabled)
{
    throw new InvalidOperationException("Skeleton must not enable settlement integration.");
}

if (modules.Count != 2)
{
    throw new InvalidOperationException("Expected skeleton HotSpot and TestModule module statuses.");
}

if (modules.Any(module => module.Manifest.SupportedWagerTypes.Count == 0))
{
    throw new InvalidOperationException("Module status must expose supported wager types.");
}

Console.WriteLine("GameEngine.Application.Tests PASS");
