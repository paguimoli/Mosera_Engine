using System.Text.Json.Serialization;

namespace CreditWalletService.Contracts;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WalletRecoveryClassification
{
    COMMITTED,
    FAILED,
    INCOMPLETE,
    UNKNOWN,
    CONFLICT,
    BLOCKED
}

public sealed record WalletOperationRecoverySnapshot(
    Guid OperationId,
    string IdempotencyKey,
    string CanonicalRequestHash,
    WalletOperationType Operation,
    string? TerminalStatus,
    int EffectCount,
    string? EffectReferenceType,
    string? EffectReferenceId,
    WalletRecoveryClassification Classification,
    DateTimeOffset CreatedAt);

public sealed record WalletRecoveryResult(
    Guid OperationId,
    WalletRecoveryClassification Classification,
    string Action,
    string ReasonCode,
    string? ResultHash,
    string EvidenceHash,
    string CorrelationId);

public sealed record WalletStartupRecoveryReport(
    Guid RecoveryRunId,
    string Status,
    int Scanned,
    int Recovered,
    int Blocked,
    int Conflicts,
    DateTimeOffset CompletedAt);

public sealed record WalletReplayResult(
    Guid OperationId,
    string ReplayResult,
    string OriginalRequestHash,
    string? OriginalResultHash,
    IReadOnlyList<string> Mismatches,
    string EvidenceHash,
    string CorrelationId);

public sealed record WalletProjectionVerificationResult(
    Guid WalletId,
    string Result,
    long ExpectedBalance,
    long ObservedBalance,
    long ExpectedExposure,
    long ObservedExposure,
    IReadOnlyList<string> Findings,
    string EvidenceHash,
    string CorrelationId);

public sealed record WalletReconciliationResult(
    string ReconciliationType,
    string Result,
    int CheckedCount,
    int MismatchCount,
    IReadOnlyList<string> Findings,
    string EvidenceHash,
    string CorrelationId,
    DateTimeOffset VerifiedAt);

public sealed record WalletRecoveryReadiness(
    bool DurableRecoveryRepositoryReady,
    bool StartupRecoveryReady,
    bool RecoveryEngineReady,
    bool ReplayEngineReady,
    bool BalanceReconstructionReady,
    bool LedgerReconciliationReady,
    bool SettlementReconciliationReady,
    bool ProjectionVerificationReady,
    bool RetryGovernanceReady,
    bool AppendOnlyEvidenceReady,
    bool UnsafeAutomaticReplayDisabled,
    bool ProductionReady);

public sealed record WalletRecoveryOperationalReport(
    int IncompleteOperations,
    int UnknownOperations,
    int ConflictOperations,
    int ReplayBacklog,
    int ProjectionDriftFindings,
    int LedgerMismatchFindings,
    int SettlementMismatchFindings,
    int RecoveryRunCount,
    DateTimeOffset GeneratedAt);

public sealed record WalletRecoveryRequest(bool AllowRetry = false);
