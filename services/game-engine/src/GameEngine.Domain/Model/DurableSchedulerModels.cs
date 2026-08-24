namespace GameEngine.Domain.Model;

public enum DurableSchedulerProductKind
{
    FastKeno,
    HotSpot
}

public enum DurableSchedulerDrawState
{
    Scheduled,
    Accepting,
    Cutoff,
    ExecutionDue,
    Executing,
    AwaitingCertification,
    AuthoritativeResult,
    SettlementTriggered,
    Completed,
    RecoveryRequired,
    SkippedNoWagers,
    Failed,
    Cancelled
}

public enum DurableSchedulerClaimStatus
{
    Acquired,
    Duplicate,
    Unavailable
}

public sealed record DurableSchedulerProductDefinition(
    DurableSchedulerProductKind ProductKind,
    Guid ProductId,
    Guid ProductVersionId,
    string ProductCode,
    Guid ScheduleId,
    Guid ScheduleVersionId,
    Guid DrawAuthorityAssignmentId,
    string TimeZoneId,
    int IntervalSeconds,
    int CutoffSeconds,
    TimeOnly AnchorLocalTime,
    TimeOnly? ServiceWindowStart,
    TimeOnly? ServiceWindowEnd,
    IReadOnlyCollection<int> MultiDrawCounts,
    bool Published,
    bool Active,
    bool Assigned,
    DateTimeOffset? EffectiveFrom,
    DateTimeOffset? EffectiveTo,
    string ScheduleHash,
    string ProductVersionHash);

public sealed record AuthoritativeDrawSlot(
    Guid DrawId,
    Guid ProductId,
    Guid ProductVersionId,
    string ProductCode,
    Guid ScheduleVersionId,
    Guid DrawAuthorityAssignmentId,
    DateTimeOffset SalesOpenAt,
    DateTimeOffset CutoffAt,
    DateTimeOffset ScheduledExecutionAt,
    string DrawIdentityHash,
    string ScheduleHash);

public sealed record DurableScheduledDraw(
    AuthoritativeDrawSlot Slot,
    long PublicDrawNumber,
    DurableSchedulerDrawState State,
    DateTimeOffset RecoveryDeadlineAt,
    DateTimeOffset MaterializedAt,
    DateTimeOffset? AuthoritativeResultAt,
    DateTimeOffset? SettlementRequestedAt,
    DateTimeOffset? WalletAvailableAt);

public sealed record DurableSchedulerExecutionClaim(
    Guid DrawId,
    Guid ClaimId,
    string OwnerId,
    DurableSchedulerClaimStatus Status,
    DateTimeOffset ClaimedAt,
    DateTimeOffset LeaseExpiresAt,
    int AttemptNumber,
    string EvidenceHash);

public sealed record DurableSchedulerCycleResult(
    int EligibleScheduleCount,
    int MaterializedDrawCount,
    int DueDrawCount,
    int ClaimedDrawCount,
    int DuplicateClaimCount,
    int RecoveryRequiredCount,
    bool ProductionExecutionEnabled,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    IReadOnlyCollection<string> Blockers);

public sealed record HotSpotQuickPickRequest(
    Guid TicketRequestId,
    string IdempotencyKey,
    int SpotCount,
    string ProductVersionHash,
    string ActorReference);

public sealed record HotSpotQuickPickSelection(
    Guid SelectionId,
    Guid TicketRequestId,
    string IdempotencyKey,
    int SpotCount,
    IReadOnlyList<int> Numbers,
    string PurposeDomain,
    string ProductVersionHash,
    string SelectionHash,
    DateTimeOffset GeneratedAt,
    bool Duplicate);

public sealed record HotSpotBullseyeEvidence(
    Guid EvidenceId,
    Guid DrawId,
    Guid ExecutionManifestId,
    int BullseyeNumber,
    string PurposeDomain,
    string PrimaryResultHash,
    string ProviderConfigurationHash,
    string CanonicalEvidenceHash,
    DateTimeOffset GeneratedAt,
    bool Duplicate);

public sealed record HotSpotMultiDrawBinding(
    Guid BindingId,
    Guid PurchaseId,
    Guid TicketId,
    Guid DrawId,
    int Sequence,
    long PublicDrawNumber,
    string DrawIdentityHash,
    string BindingHash,
    DateTimeOffset BoundAt);

public sealed record HotSpotMultiDrawPlan(
    Guid PurchaseId,
    Guid TicketId,
    int DrawCount,
    long StakePerDrawMinor,
    long TotalReservationMinor,
    HotSpotQuickPickSelection? QuickPick,
    IReadOnlyCollection<HotSpotMultiDrawBinding> Bindings,
    string CanonicalPlanHash,
    bool Duplicate);

public sealed record DurableSchedulerOperationalStatus(
    bool DurablePersistenceReady,
    bool AdvisoryLockingReady,
    bool HostedRuntimeEnabled,
    bool ProductionExecutionEnabled,
    int MaterializedDrawCount,
    int AcceptingDrawCount,
    int DueButUnexecutedCount,
    int RecoveryRequiredCount,
    int UnsettledDrawCount,
    TimeSpan SchedulerLag,
    TimeSpan? OldestUnsettledAge,
    DateTimeOffset ObservedAt,
    IReadOnlyCollection<string> Blockers);
