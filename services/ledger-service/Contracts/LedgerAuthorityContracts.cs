using System.Text.Json.Serialization;

namespace LedgerService.Contracts;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LedgerAuthorityMode
{
    MONOLITH,
    SERVICE_SHADOW,
    SERVICE_DRY_RUN,
    SERVICE
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LedgerPromotionComparisonStatus
{
    MATCH,
    ACCEPTABLE_DIFFERENCE,
    DIVERGENCE,
    INCONCLUSIVE
}

public sealed record LedgerDependencyReadiness(
    bool Configured,
    bool Reachable,
    bool Ready,
    bool DurablePersistenceConfigured,
    bool MutationCapabilityEnabled,
    bool IdempotencySupportConfigured,
    bool ReconciliationReady,
    string? CapabilityMarker,
    IReadOnlyList<string> Blockers);

public sealed record LedgerLegacyPathEvidence(
    string Path,
    string Classification,
    bool AllowedInRequestedMode,
    string Evidence);

public sealed record LedgerAuthorityReadinessReport(
    LedgerAuthorityMode AuthorityMode,
    bool DurablePersistenceReady,
    bool ImmutablePostingReady,
    bool BalancedJournalReady,
    bool ConflictSafeIdempotencyReady,
    bool ReversalOnlyCorrectionsReady,
    bool PostingCatalogReady,
    bool RecoveryReady,
    bool ReplayReady,
    bool ReconciliationReady,
    bool CreditWalletDependencyReady,
    bool LegacyPathsIsolated,
    bool ProductionPostingEnabled,
    bool ExplicitPromotionApprovalPresent,
    bool PassingPromotionRehearsalPresent,
    bool RollbackReady,
    bool PromotionAllowed,
    bool ServiceAuthorityEnabled,
    LedgerDependencyReadiness CreditWalletService,
    IReadOnlyList<LedgerLegacyPathEvidence> LegacyPaths,
    IReadOnlyList<string> CapabilityMarkers,
    IReadOnlyList<string> Blockers,
    string ReadinessReportHash,
    DateTimeOffset GeneratedAt);

public sealed record LedgerPromotionDryRunRequest(
    LedgerAuthorityMode AuthorityMode,
    string OperatorReference = "system",
    IReadOnlyDictionary<string, object?>? ApprovalMetadata = null);

public sealed record LedgerPromotionComparison(
    string InstructionFamily,
    LedgerPromotionComparisonStatus Status,
    int ArtifactCount,
    string ExpectedInvariant,
    string ActualEvidence,
    IReadOnlyList<string> Differences);

public sealed record LedgerPromotionRehearsalDto(
    Guid PromotionRehearsalId,
    LedgerAuthorityMode AuthorityMode,
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
    string CanonicalEvidenceHash,
    DateTimeOffset CreatedAt);

public sealed record LedgerPromotionDryRunResult(
    LedgerAuthorityReadinessReport Readiness,
    LedgerPromotionRehearsalDto Rehearsal,
    IReadOnlyList<LedgerPromotionComparison> Comparisons,
    IReadOnlyList<string> RemainingPromotionBlockers,
    LedgerAuthorityMode RollbackAuthority,
    bool AuthoritySwitched);

public sealed record LedgerRollbackReadiness(
    LedgerAuthorityMode CurrentAuthority,
    LedgerAuthorityMode ProposedAuthority,
    LedgerAuthorityMode RollbackAuthority,
    bool RollbackConfigured,
    bool AutomaticFallbackEnabled,
    IReadOnlyList<string> Prerequisites,
    IReadOnlyList<string> Limitations,
    string EvidenceHash,
    DateTimeOffset GeneratedAt);

public sealed class LedgerAuthorityValidationException(string message) : Exception(message);
