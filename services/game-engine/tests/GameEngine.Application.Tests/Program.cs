using GameEngine.Application.Services;

var statusService = new GameEngineStatusService();
var status = statusService.GetStatus();

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

Console.WriteLine("GameEngine.Application.Tests PASS");
