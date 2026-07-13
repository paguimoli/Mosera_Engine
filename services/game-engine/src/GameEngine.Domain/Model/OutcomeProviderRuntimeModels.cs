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
    ProductionDisabled,
    UnknownExternalSource,
    ExternalSourceInactive,
    ExternalSourceAuthenticationFailed,
    ExternalResultSignatureInvalid,
    ExternalResultSchemaMismatch,
    ExternalResultIdentityMismatch,
    ExternalResultTimestampInvalid,
    ExternalResultConflict,
    ExternalResultSupersessionRequired,
    UnknownPhysicalDrawAuthority,
    PhysicalDrawAuthorityInactive,
    PhysicalDrawEquipmentInvalid,
    PhysicalDrawWitnessInvalid,
    PhysicalDrawSchemaMismatch,
    PhysicalDrawIdentityMismatch,
    PhysicalDrawTimestampInvalid,
    PhysicalDrawConflict,
    PhysicalDrawSupersessionRequired,
    RuntimeRecoveryRequired,
    RuntimeRollbackDetected,
    RuntimeCrashInjected,
    RuntimeProvenanceMissing
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
    bool SilentFallbackConfigured = false,
    ExternalOfficialResultEnvelope? ExternalOfficialResult = null,
    PhysicalDrawResultEnvelope? PhysicalDrawResult = null);

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

public enum OutcomeRuntimeRecoveryEventType
{
    Boot,
    Shutdown,
    UnexpectedTermination,
    Crash,
    Restart,
    StartupValidation,
    RollbackDetection,
    AbandonedRuntime,
    RecoveredRuntime,
    RecoveryAttempt,
    LockRecovery,
    ProviderRecovery
}

public enum OutcomeRuntimeCrashInjectionStage
{
    Startup,
    ProviderValidation,
    EntropyAcquisition,
    DrbgInstantiation,
    ProviderExecution,
    OutcomeDsl,
    Canonicalization,
    CertificateCreation,
    CertificatePersistence,
    ReceiptGeneration,
    ReceiptPersistence,
    ProviderEvidencePersistence,
    LockAcquisition,
    LockRelease,
    Completion,
    Recovery
}

public sealed record OutcomeRuntimeBootIdentity(
    Guid BootId,
    string RuntimeInstanceId,
    int ProcessId,
    string? ContainerId,
    string HostId,
    string Hostname,
    string ServiceVersion,
    string SemanticVersion,
    string BuildNumber,
    string GitCommitSha,
    string? GitBranch,
    string? DockerImageDigest,
    DateTimeOffset? BuildTimestamp,
    DateTimeOffset BootTimestamp,
    string Environment,
    string ProviderConfigurationVersion,
    string? OutcomeProviderId,
    string? OutcomeProviderVersion,
    string? EntropyProviderId,
    string? EntropyProviderVersion,
    string BuildHash,
    string RuntimeFramework);

public sealed record OutcomeRuntimeProvenanceSnapshot(
    Guid BootId,
    string RuntimeInstanceId,
    int ProcessId,
    string BuildHash,
    string GitCommitSha,
    string? DockerImageDigest,
    string? OutcomeProviderId,
    string? OutcomeProviderVersion,
    string? EntropyProviderId,
    string? EntropyProviderVersion,
    string? ManifestId,
    string? ManifestVersion,
    string ProviderConfigurationVersion);

public sealed record OutcomeRuntimeRecoveryEvidence(
    Guid EvidenceId,
    OutcomeRuntimeRecoveryEventType EventType,
    Guid BootId,
    string RuntimeInstanceId,
    Guid? RuntimeRequestId,
    Guid? AttemptId,
    string? DrawRequestScope,
    string? ProviderId,
    string? ProviderVersion,
    OutcomeProviderType? ProviderType,
    string? ReasonCode,
    string? Details,
    string RecoveryHash,
    string ContentHash,
    DateTimeOffset CreatedAt);

public sealed record OutcomeRuntimeRecoveryReadiness(
    bool BootIdentityReady,
    bool ProvenanceRepositoryReady,
    bool RecoveryEvidenceRepositoryReady,
    bool RollbackDetectionReady,
    bool CrashInjectionConfigured,
    bool ProductionGenerationDisabled,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}
