namespace GamingEngine.Domain;

public sealed record GameEngineDefinition(
    EngineType EngineType,
    string Name,
    string Version,
    string Description,
    bool SupportsMetrics,
    bool SupportsMarketEvaluation);
