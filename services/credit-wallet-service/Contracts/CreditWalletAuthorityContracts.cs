using System.Text.Json.Serialization;

namespace CreditWalletService.Contracts;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CreditWalletAuthorityMode
{
    MONOLITH,
    SERVICE_SHADOW,
    SERVICE_DRY_RUN,
    SERVICE
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CreditWalletAuthorityFindingClassification
{
    READY,
    BLOCKED,
    WARNING,
    INFORMATION
}

public sealed record CreditWalletAuthorityFinding(
    string Code,
    CreditWalletAuthorityFindingClassification Classification,
    string Reason,
    string Authority,
    string RequiredAction,
    string EvidenceReference);

public sealed record CreditWalletAuthorityOperationalSnapshot(
    int ReserveCount,
    int ReleaseCount,
    int CancelCount,
    int CaptureCount,
    int SettlementCount,
    int ReversalCount,
    int CorrectionCount,
    int RecoveryEvidenceCount,
    int ReplayMatchCount,
    int IncompleteOperationCount,
    int ConflictOperationCount,
    int ProjectionDriftCount,
    int LedgerMismatchCount,
    int SettlementMismatchCount,
    int InvalidLedgerReferenceCount,
    int AuthenticatedSettlementCount);

public sealed record CreditWalletAuthorityEvidenceReference(
    string EvidenceType,
    CreditWalletAuthorityMode AuthorityMode,
    string Result,
    string EvidencePayloadHash);

public sealed record CreditWalletAuthorityReadinessReport(
    CreditWalletAuthorityMode ConfiguredAuthorityMode,
    CreditWalletAuthorityMode EvaluatedAuthorityMode,
    bool AuthorityModeValid,
    bool DurablePersistenceReady,
    bool CanonicalOperationsReady,
    bool WalletInstrumentsReady,
    bool ScopeValidationReady,
    bool ConflictSafeIdempotencyReady,
    bool ReservationLifecycleReady,
    bool SettlementAuthenticationReady,
    bool LedgerCoordinationReady,
    bool RecoveryReady,
    bool ReplayReady,
    bool ReconciliationReady,
    bool ImmutableEvidenceReady,
    bool InternalAuthenticationReady,
    bool ProductionCredentialReady,
    bool DatabaseInvariantsReady,
    bool PromotionRehearsalReady,
    bool RollbackValidationReady,
    bool NoSilentFallback,
    bool PromotionAllowed,
    bool ServiceAuthorityEnabled,
    bool ProductionAuthorityActivationEnabled,
    string ProjectionRepairPolicy,
    IReadOnlyList<string> CapabilityMarkers,
    IReadOnlyList<CreditWalletAuthorityFinding> Findings,
    CreditWalletAuthorityOperationalSnapshot Snapshot,
    string MigrationVersion,
    string RehearsalEnvironmentClassification,
    CreditWalletAuthorityEvidenceReference? LatestPromotionRehearsal,
    CreditWalletAuthorityEvidenceReference? LatestRollbackRehearsal,
    string ReadinessFingerprint,
    DateTimeOffset GeneratedAt);

public sealed record CreditWalletPromotionRehearsalRequest(
    CreditWalletAuthorityMode AuthorityMode,
    string OperatorReference = "system");

public sealed record CreditWalletRollbackRehearsalRequest(
    CreditWalletAuthorityMode SourceAuthority = CreditWalletAuthorityMode.SERVICE,
    CreditWalletAuthorityMode TargetAuthority = CreditWalletAuthorityMode.MONOLITH,
    string OperatorReference = "system");

public sealed record CreditWalletAuthorityEvidenceDto(
    Guid EvidenceId,
    string EvidenceType,
    CreditWalletAuthorityMode AuthorityMode,
    string Result,
    string ConfigurationHash,
    string ReadinessFingerprint,
    string EvidencePayloadHash,
    IReadOnlyDictionary<string, object?> EvidencePayload,
    string OperatorReference,
    DateTimeOffset CreatedAt);

public sealed record CreditWalletPromotionRehearsalResult(
    CreditWalletAuthorityReadinessReport Readiness,
    CreditWalletAuthorityEvidenceDto Evidence,
    IReadOnlyList<CreditWalletAuthorityFinding> Findings,
    CreditWalletAuthorityMode RollbackAuthority,
    bool AuthoritySwitched);

public sealed record CreditWalletRollbackRehearsalResult(
    CreditWalletAuthorityMode SimulatedSourceAuthority,
    CreditWalletAuthorityMode RollbackAuthority,
    bool DuplicateOperationsDetected,
    bool LostOperationsDetected,
    bool BalanceDriftDetected,
    bool ReservationDriftDetected,
    bool ReconciliationDriftDetected,
    bool AutomaticFallbackEnabled,
    string Result,
    CreditWalletAuthorityEvidenceDto Evidence,
    bool AuthoritySwitched);

public sealed record CreditWalletAuthorityVerificationResult(
    CreditWalletAuthorityReadinessReport Readiness,
    CreditWalletAuthorityEvidenceDto ReadinessEvidence,
    CreditWalletAuthorityEvidenceDto GuardrailEvidence,
    CreditWalletAuthorityEvidenceDto BlockerEvidence,
    bool AuthoritySwitched);

public sealed class CreditWalletAuthorityValidationException(string message) : Exception(message);
