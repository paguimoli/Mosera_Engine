namespace SettlementService.Contracts;

public sealed record SettlementHealthResponse(
    string Status,
    string Service,
    string Version,
    DateTimeOffset Timestamp,
    IReadOnlyDictionary<string, string> Dependencies,
    SettlementPersistenceCapabilityDto Capabilities,
    SettlementIngestionReadiness SettlementInputIngestion,
    SettlementExecutionReadiness SettlementExecution,
    FinancialInstructionReadiness FinancialInstructions,
    SettlementRecoveryReadiness SettlementRecovery,
    ResettlementReadiness Resettlement,
    SettlementAuthorityReadinessReport SettlementAuthority,
    string CorrelationId);
