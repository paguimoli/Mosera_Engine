namespace GamingEngine.Domain;

public sealed record DrawResult(
    EngineType EngineType,
    string EngineVersion,
    ResultType ResultType,
    NumberSetResult NumberSetResult,
    DateTimeOffset GeneratedAtUtc,
    string CorrelationId);
