namespace GamingEngine.Domain;

public sealed record DrawRequest(
    int MinNumber,
    int MaxNumber,
    int NumbersToDraw,
    string CorrelationId);
