namespace GamingEngine.Domain;

public sealed record EngineDrawResponse<TPayload>(
    EngineType EngineType,
    string EngineVersion,
    ResultType ResultType,
    TPayload ResultPayload,
    DateTimeOffset GeneratedAtUtc,
    string CorrelationId);
