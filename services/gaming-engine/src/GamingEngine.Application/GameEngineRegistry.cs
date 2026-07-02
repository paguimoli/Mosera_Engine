using GamingEngine.Domain;

namespace GamingEngine.Application;

public sealed class GameEngineRegistry : IGameEngineRegistry
{
    private static readonly IReadOnlyDictionary<EngineType, GameEngineDefinition> Engines =
        new Dictionary<EngineType, GameEngineDefinition>
        {
            [EngineType.NumberSet] = new(
                EngineType.NumberSet,
                "Number Set Engine",
                "1.0.0",
                "Generates N unique numbers from an inclusive range.",
                SupportsMetrics: false,
                SupportsMarketEvaluation: false)
        };

    public List<GameEngineDefinition> GetAvailableEngines()
    {
        return Engines.Values
            .OrderBy(engine => engine.EngineType)
            .ToList();
    }

    public GameEngineDefinition GetByType(EngineType engineType)
    {
        if (Engines.TryGetValue(engineType, out var definition))
        {
            return definition;
        }

        throw new KeyNotFoundException($"Unknown engine type '{engineType}'.");
    }
}
