namespace GameEngine.Domain.Model;

public enum OutcomeRuntimeExecutionMode
{
    DryRun,
    Simulation,
    Production
}

public enum OutcomeRuntimeStatus
{
    Accepted,
    DuplicateReturned,
    FailedClosed,
    ProductionDisabled,
    GenerationNotImplemented
}

public enum OutcomeRuntimeFailureCode
{
    None,
    MissingManifestBinding,
    MissingProvider,
    InactiveProvider,
    IneligibleProvider,
    TypeMismatch,
    VersionMismatch,
    CapabilityMismatch,
    SilentFallbackConfigured,
    SimulationProviderInProduction,
    RuntimeNotReady,
    IdempotencyConflict,
    LockUnavailable,
    GenerationNotImplemented,
    ProductionDisabled
}

public sealed record OutcomeProviderRuntimeRequest(
    Guid RuntimeRequestId,
    string IdempotencyKey,
    string DrawRequestScope,
    string GameManifestId,
    string GameManifestVersion,
    OutcomeProviderManifestBinding? ManifestBinding,
    OutcomeProviderType ExpectedProviderType,
    OutcomeRuntimeExecutionMode Mode,
    IReadOnlyCollection<OutcomePrimitiveType> RequiredPrimitives,
    string CanonicalRequestHash,
    bool SilentFallbackConfigured = false);

public sealed record OutcomeProviderRuntimeReadiness(
    OutcomeProviderType ProviderType,
    bool ProviderResolverReady,
    bool OrchestrationReady,
    bool DurableIdempotencyConfigured,
    bool AdvisoryLockingConfigured,
    bool ProviderRuntimeImplemented,
    bool ProductionGenerationDisabled,
    IReadOnlyCollection<string> CapabilityMarkers,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}

public sealed record OutcomeProviderRuntimeContext(
    OutcomeProviderRuntimeRequest Request,
    OutcomeProviderDefinitionV1 Provider);

public sealed record OutcomeProviderRuntimeResult(
    Guid RuntimeRequestId,
    string IdempotencyKey,
    string DrawRequestScope,
    string GameManifestId,
    string GameManifestVersion,
    string ProviderId,
    string ProviderVersion,
    OutcomeProviderType ProviderType,
    OutcomeRuntimeExecutionMode Mode,
    OutcomeRuntimeStatus Status,
    OutcomeRuntimeFailureCode FailureCode,
    string? FailureReason,
    string CanonicalRequestHash,
    string? ResultReference,
    string? EvidenceReference,
    DateTimeOffset StartedAt,
    DateTimeOffset? CompletedAt);

public sealed record OutcomeRuntimeStoredRequest(
    Guid RuntimeRequestId,
    string IdempotencyKey,
    string DrawRequestScope,
    string GameManifestId,
    string GameManifestVersion,
    string ProviderId,
    string ProviderVersion,
    OutcomeProviderType ProviderType,
    OutcomeRuntimeExecutionMode Mode,
    OutcomeRuntimeStatus Status,
    OutcomeRuntimeFailureCode FailureCode,
    string? FailureReason,
    string CanonicalRequestHash,
    string? ResultReference,
    string? EvidenceReference,
    DateTimeOffset StartedAt,
    DateTimeOffset? CompletedAt);

public sealed record OutcomeRuntimeRequestClaim(
    OutcomeRuntimeStoredRequest Request,
    bool Created,
    bool Duplicate);

public sealed record OutcomeRuntimeAttemptEvidence(
    Guid AttemptId,
    Guid RuntimeRequestId,
    string IdempotencyKey,
    string DrawRequestScope,
    string ProviderId,
    string ProviderVersion,
    OutcomeProviderType ProviderType,
    OutcomeRuntimeExecutionMode Mode,
    OutcomeRuntimeStatus Status,
    OutcomeRuntimeFailureCode FailureCode,
    string? FailureReason,
    string LockScope,
    bool LockAcquired,
    string CanonicalAttemptHash,
    DateTimeOffset StartedAt,
    DateTimeOffset? CompletedAt);

public sealed record OutcomeRuntimeLockLease(
    string LockScope,
    bool Acquired,
    string? FailureReason);

public sealed record OutcomeRuntimePersistenceReadiness(
    bool DurablePersistenceConfigured,
    bool DurablePersistenceReachable,
    bool IdempotencyRepositoryReady,
    bool RuntimeAttemptsRepositoryReady,
    bool ProductionGenerationDisabled,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}

public sealed record OutcomeRuntimeLockingReadiness(
    bool AdvisoryLockingConfigured,
    bool AdvisoryLockingReachable,
    bool RedisLockDependencyAbsent,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}
