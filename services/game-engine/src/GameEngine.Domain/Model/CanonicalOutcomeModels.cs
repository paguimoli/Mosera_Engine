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
    string AuditReference,
    string ActorReference,
    string ReasonCode,
    string LifecycleEvidenceHash);

public sealed record CanonicalOutcomeVersion(
    Guid OutcomeVersionId,
    Guid DrawId,
    Guid ExecutionManifestId,
    string ExecutionManifestHash,
    Guid ProviderEvidenceId,
    Guid ProviderExecutionId,
    CanonicalOutcomeProviderCategory ProviderCategory,
    string OutcomeProviderId,
    string OutcomeProviderVersion,
    string ProviderConfigurationVersion,
    string ProviderEvidenceHash,
    Guid GameDefinitionVersionId,
    string GameDefinitionHash,
    string EvaluatorVersion,
    Guid CertificateSignatureId,
    string CertificateVerificationHash,
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
    string ValidatedOutcomeJson,
    string ValidatedOutcomeHash,
    IReadOnlyList<int> ValidatedPrimaryResult,
    IReadOnlyList<int> ValidatedBonusResult,
    IReadOnlyDictionary<string, object?> DerivedOutcomeData,
    string OutcomeSchemaVersion,
    DateTimeOffset GeneratedAt,
    string AuthoritativeSource,
    string CorrelationId,
    string CausationId,
    string AuditReference,
    string ActorReference,
    string ReasonCode,
    string LifecycleEvidenceHash,
    string CanonicalRequestHash,
    string IdempotencyKey,
    Guid OutboxEventId,
    DateTimeOffset PublishedAt);

public sealed record CanonicalOutcomeCertificateVerificationEvidence(
    Guid OutcomeId,
    Guid DrawId,
    string OutcomePayloadJson,
    string OutcomeHash,
    DateTimeOffset GeneratedAt,
    Guid SignatureId,
    string VerificationEvidenceHash,
    SigningProviderDefinition SigningProvider,
    CertificateSignature Signature,
    IReadOnlyCollection<CertificateReference> PreviousCertificates);

public sealed record CanonicalOutcomeAuthorityContext(
    DrawExecutionManifest Manifest,
    AuthorizedOutcomeProviderEvidence Provider,
    GameDefinitionVersion GameDefinitionVersion,
    CanonicalProviderOutcomeResult ValidatedResult,
    string ValidatedResultJson,
    string ValidatedResultHash,
    CanonicalOutcomeCertificateVerificationEvidence CertificateEvidence);

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

public enum CanonicalOutcomeLifecycleOperation
{
    Recovery,
    Correction,
    Cancellation,
    ReplayVerified,
    ReplayRejected
}

public sealed record CanonicalOutcomeRecoveryCommand(
    int Limit,
    string ActorReference,
    string ReasonCode,
    string CorrelationId,
    string CausationId);

public sealed record CanonicalOutcomeReplayCommand(
    Guid OutcomeVersionId,
    string IdempotencyKey,
    string ActorReference,
    string ReasonCode,
    string CorrelationId,
    string CausationId);

public sealed record CanonicalOutcomeReplayEvidence(
    CanonicalOutcomeVersion Outcome,
    DrawExecutionManifest Manifest,
    string ProviderResultJson,
    string ProviderResultHash,
    string ProviderSourceResultHash,
    string ProviderEvidenceHash,
    CanonicalOutcomeCertificateVerificationEvidence CertificateEvidence,
    Guid? SettlementRequestId,
    Guid? SettlementInputId,
    string? SettlementInputHash,
    bool SettlementReferencesValid);

public sealed record CanonicalOutcomeLifecycleEvent(
    Guid LifecycleEventId,
    CanonicalOutcomeLifecycleOperation Operation,
    Guid OutcomeVersionId,
    Guid DrawId,
    Guid OutcomeCertificateId,
    Guid ProviderEvidenceId,
    Guid? PreviousOutcomeVersionId,
    Guid? SettlementRequestId,
    Guid? SettlementInputId,
    string ActorReference,
    string ReasonCode,
    string CorrelationId,
    string CausationId,
    string CanonicalRequestHash,
    string EvidenceHash,
    string IdempotencyKey,
    DateTimeOffset CreatedAt);
