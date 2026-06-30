namespace GameEngine.Domain.Model;

public enum DrawScheduleKind
{
    FixedInterval,
    FixedDailyTime
}

public enum DrawResultSource
{
    InternalGenerated,
    OfficialFeed,
    ManualCertified
}

public enum DrawSchedulerHealth
{
    Healthy,
    Warning,
    Error
}

public enum DrawRecoveryPolicy
{
    ManualReview,
    AwaitOfficialResult,
    FutureAutomatedRetry
}

public sealed record DrawScheduleDefinition(
    Guid Id,
    string Code,
    string DisplayName,
    Guid GameBindingId,
    DrawScheduleKind ScheduleKind,
    DrawResultSource ResultSource,
    DrawProviderType DrawProviderType,
    Guid DrawAuthorityId,
    string TimeZoneId,
    int? IntervalMinutes,
    IReadOnlyCollection<TimeOnly> DailyDrawTimes,
    TimeSpan SalesOpenBeforeDraw,
    TimeSpan SalesCutoffBeforeDraw,
    TimeSpan ResultExpectedAfterDraw,
    DrawRecoveryPolicy RecoveryPolicy,
    bool ProductionActivationEnabled,
    DateTimeOffset CreatedAt);

public sealed record DrawLifecycleRecord(
    Guid DrawId,
    Guid DrawScheduleId,
    Guid GameBindingId,
    long DrawNumber,
    DrawResultSource ResultSource,
    DateTimeOffset SalesOpenAt,
    DateTimeOffset SalesCutoffAt,
    DateTimeOffset SalesCloseAt,
    DateTimeOffset DrawAt,
    DateTimeOffset ResultExpectedAt,
    DrawLifecycleStatus Status,
    bool SalesAllowed,
    bool InternalGenerationEligible,
    bool MissedDrawWindow,
    bool ManualRecoveryMarked,
    IReadOnlyCollection<string> Reasons,
    DateTimeOffset UpdatedAt);

public sealed record DrawSchedulePreview(
    Guid ScheduleId,
    string ScheduleCode,
    IReadOnlyCollection<DrawLifecycleRecord> UpcomingDraws,
    DateTimeOffset GeneratedAt);

public sealed record DrawLifecycleTransitionResult(
    Guid DrawId,
    DrawLifecycleStatus PreviousStatus,
    DrawLifecycleStatus RequestedStatus,
    bool Accepted,
    IReadOnlyCollection<string> Reasons,
    DateTimeOffset EvaluatedAt);

public sealed record DrawSchedulerStatus(
    DrawSchedulerHealth Health,
    int ScheduleCount,
    int LifecycleRecordCount,
    int MissedDrawCount,
    bool ProductionActivationEnabled,
    bool SettlementIntegrationEnabled,
    IReadOnlyCollection<string> Reasons,
    DateTimeOffset GeneratedAt);
