namespace SettlementService.Contracts;

public sealed record SettlementHealthResponse(
    string Status,
    string Service,
    string Version,
    DateTimeOffset Timestamp,
    IReadOnlyDictionary<string, string> Dependencies,
    string CorrelationId);
