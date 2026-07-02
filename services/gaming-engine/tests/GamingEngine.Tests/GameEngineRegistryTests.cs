using GamingEngine.Application;
using GamingEngine.Domain;
using Xunit;

namespace GamingEngine.Tests;

public sealed class GameEngineRegistryTests
{
    [Fact]
    public void GetAvailableEngines_ReturnsNumberSetEngine()
    {
        var registry = new GameEngineRegistry();

        var engines = registry.GetAvailableEngines();

        var numberSet = Assert.Single(engines);
        Assert.Equal(EngineType.NumberSet, numberSet.EngineType);
        Assert.Equal("Number Set Engine", numberSet.Name);
        Assert.Equal("1.0.0", numberSet.Version);
        Assert.Equal("Generates N unique numbers from an inclusive range.", numberSet.Description);
        Assert.False(numberSet.SupportsMetrics);
        Assert.False(numberSet.SupportsMarketEvaluation);
    }

    [Fact]
    public void GetByType_ReturnsNumberSetEngine()
    {
        var registry = new GameEngineRegistry();

        var numberSet = registry.GetByType(EngineType.NumberSet);

        Assert.Equal(EngineType.NumberSet, numberSet.EngineType);
        Assert.Equal("Number Set Engine", numberSet.Name);
    }
}
