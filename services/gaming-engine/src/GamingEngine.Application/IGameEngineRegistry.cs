using GamingEngine.Domain;

namespace GamingEngine.Application;

public interface IGameEngineRegistry
{
    List<GameEngineDefinition> GetAvailableEngines();

    GameEngineDefinition GetByType(EngineType engineType);
}
