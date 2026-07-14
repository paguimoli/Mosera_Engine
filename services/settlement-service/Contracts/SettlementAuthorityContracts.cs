using System.Text.Json.Serialization;

namespace SettlementService.Contracts;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SettlementAuthorityMode
{
    MONOLITH,
    SERVICE_SHADOW,
    SERVICE_DRY_RUN,
    SERVICE
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SettlementPromotionComparisonStatus
{
    MATCH,
    ACCEPTABLE_DIFFERENCE,
    DIVERGENCE,
    INCONCLUSIVE
}

public sealed record SettlementTargetServiceReadiness(
    bool Configured,
    bool Reachable,
    bool Ready,
    bool MutationCapabilityEnabled,
    bool DurablePersistenceConfigured,
    bool IdempotencySupportConfigured,
    bool QaCapabilityMarkerPresent,
    string? CapabilityMarker,
    IReadOnlyList<string> Blockers);

public sealed record SettlementAuthorityReadinessReport(
    SettlementAuthorityMode AuthorityMode,
    bool SettlementInputIngestionReady,
    bool FinancialContextValidationReady,
    bool AuthoritativeSettlementExecutionReady,
    bool SettlementPolicyReady,
    bool DurableSettlementPersistenceReady,
    bool IdempotencyReady,
    bool ReplayReady,
    bool BatchRecoveryReady,
    bool FinancialInstructionGenerationReady,
    bool LedgerExecutionReady,
    bool CreditWalletExecutionReady,
    bool PartialFailureRecoveryReady,
    bool InstructionReconciliationReady,
    bool ResettlementReversalReady,
    bool LegacyPathIsolated,
    bool ProductionPostingEnabled,
    bool AuthorityActivationEnabled,
    bool ServiceAuthorityPromotionAllowed,
    string LegacyPathIsolationStatus,
    string ProductionPostingStatus,
    string AuthorityActivationStatus,
    SettlementTargetServiceReadiness LedgerService,
    SettlementTargetServiceReadiness CreditWalletService,
    IReadOnlyList<string> CapabilityMarkers,
    IReadOnlyList<string> Blockers,
    string ReadinessReportHash,
    DateTimeOffset GeneratedAt);

public sealed record SettlementPromotionDryRunRequest(
    SettlementAuthorityMode AuthorityMode,
    IReadOnlyList<Guid>? SettlementRequestIds = null,
    string OperatorReference = "system",
    IReadOnlyDictionary<string, object?>? ApprovalMetadata = null,
    IReadOnlyDictionary<string, object?>? WaiverMetadata = null);

public sealed record SettlementPromotionComparisonResult(
    Guid? SettlementRequestId,
    SettlementPromotionComparisonStatus Status,
    string ExpectedHash,
    string ActualHash,
    IReadOnlyList<string> Differences);

public sealed record SettlementPromotionRehearsalDto(
    Guid PromotionRehearsalId,
    SettlementAuthorityMode AuthorityMode,
    string ServiceBuildVersion,
    string ConfigurationHash,
    string ReadinessReportHash,
    string TestRequestSetHash,
    string ResultSummary,
    string ComparisonSummary,
    int UnresolvedBlockerCount,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    string OperatorReference,
    IReadOnlyDictionary<string, object?> ApprovalMetadata,
    string CanonicalEvidenceHash);

public sealed record SettlementPromotionDryRunResult(
    SettlementAuthorityReadinessReport Readiness,
    SettlementPromotionRehearsalDto Rehearsal,
    IReadOnlyList<SettlementPromotionComparisonResult> Comparisons,
    IReadOnlyList<string> RemainingPromotionBlockers,
    string RollbackAuthority,
    bool AuthoritySwitched);

public sealed record SettlementRollbackReadiness(
    SettlementAuthorityMode CurrentAuthority,
    SettlementAuthorityMode ProposedAuthority,
    SettlementAuthorityMode RollbackAuthority,
    bool RollbackConfigured,
    IReadOnlyList<string> RollbackPrerequisites,
    IReadOnlyList<string> CompatibilityLimitations,
    string EvidenceHash,
    DateTimeOffset GeneratedAt);
