namespace GameEngine.Domain.Model;

public enum CanonicalOutcomeVersionKind
{
    Published,
    Corrected,
    Cancelled
}

public sealed record CanonicalOutcomePublicationCommand(
    string IdempotencyKey,
    Guid DrawId,
    string ProductReference,
    string EngineName,
    string EngineVersion,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    CanonicalOutcomeVersionKind VersionKind,
    Guid? PreviousOutcomeVersionId,
    string AuthoritativeSource,
    string CorrelationId,
    string CausationId,
    string AuditReference);

public sealed record CanonicalOutcomeVersion(
    Guid OutcomeVersionId,
    Guid DrawId,
    Guid ExecutionManifestId,
    string ExecutionManifestHash,
    string ProductReference,
    string EngineName,
    string EngineVersion,
    int VersionNumber,
    CanonicalOutcomeVersionKind VersionKind,
    Guid OutcomeId,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    Guid? PreviousOutcomeVersionId,
    string CanonicalOutcomeJson,
    string CanonicalOutcomeHash,
    DateTimeOffset GeneratedAt,
    string AuthoritativeSource,
    string CorrelationId,
    string CausationId,
    string AuditReference,
    string CanonicalRequestHash,
    string IdempotencyKey,
    Guid OutboxEventId,
    DateTimeOffset PublishedAt);

public sealed record DrawExecutionManifest(
    Guid ExecutionManifestId,
    Guid DrawId,
    Guid ScheduleVersionId,
    Guid GameDefinitionVersionId,
    Guid DrawAuthorityVersionId,
    string EngineName,
    string EngineVersion,
    string OutcomeProviderId,
    string OutcomeProviderVersion,
    string ProviderConfigurationVersion,
    string EvaluatorVersion,
    string PaytableVersion,
    DateTimeOffset ScheduledExecutionAt,
    string ScheduleHash,
    string DrawIdentityHash,
    string CanonicalManifestHash,
    DateTimeOffset CreatedAt);

public sealed record OutcomeSettlementRequestCommand(
    string IdempotencyKey,
    Guid OutcomeVersionId,
    Guid? SettlementInputId,
    string CorrelationId,
    string CausationId,
    string AuditReference);

public sealed record OutcomeSettlementRequest(
    Guid SettlementRequestId,
    Guid OutcomeVersionId,
    Guid DrawId,
    CanonicalOutcomeVersionKind RequestKind,
    Guid? SettlementInputId,
    string CanonicalRequestHash,
    string IdempotencyKey,
    string CorrelationId,
    string CausationId,
    string AuditReference,
    Guid OutboxEventId,
    DateTimeOffset EmittedAt);

public sealed record CanonicalOutcomePipelineReadiness(
    bool DurablePersistenceConfigured,
    bool DurablePersistenceReachable,
    bool ImmutableVersioningReady,
    bool IdempotencyReady,
    bool AdvisoryLockingReady,
    bool OutboxReady,
    bool SettlementRequestEmissionReady,
    bool CanonicalDrawOrchestrationReady,
    bool OutboxDispatcherReady,
    bool WorkerRuntimeReady,
    bool RabbitMqConsumptionReady,
    bool SettlementRequestConsumptionReady,
    bool ReplayProtectionReady,
    bool MissingRequestRecoveryReady,
    bool LegacyPublicationDisabled,
    bool ProductionAuthorityDisabled,
    bool LegacyDirectSettlementPathsResolved,
    IReadOnlyCollection<string> Blockers);

public sealed record CanonicalOutcomeRecoveryResult(
    int MissingRequestCount,
    int RequestsCreated,
    int EventsRequeued,
    int BlockedCount,
    bool RecoveryLockAcquired,
    IReadOnlyCollection<string> Blockers,
    DateTimeOffset ScannedAt);
