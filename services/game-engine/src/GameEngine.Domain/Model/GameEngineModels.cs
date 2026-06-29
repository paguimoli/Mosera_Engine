namespace GameEngine.Domain.Model;

public enum GameModuleLifecycleStatus
{
    Development,
    InternalTesting,
    QaCertified,
    Approved,
    ProductionActive,
    Retired
}

public enum DrawAuthorityStatus
{
    Draft,
    Testing,
    InternallyApproved,
    PendingApproval,
    Approved,
    ExternallyCertified,
    ProductionActive,
    Production,
    Suspended,
    Retired
}

public enum DrawProviderType
{
    InternalPrng,
    InternalProductionPrng,
    InternalTestPrng,
    ExternalRngProvider,
    OfficialFeed,
    ManualCertifiedEntry,
    SupplierApi
}

public enum DrawLifecycleStatus
{
    Scheduled,
    SalesClosed,
    ResultSubmitted,
    Certified,
    EvaluationQueued,
    EvaluationCompleted,
    Voided
}

public enum SettlementTriggerPolicy
{
    Manual,
    OnDrawCertification,
    OnEvaluationCompletion
}

public enum EvaluationBatchStatus
{
    Pending,
    InProgress,
    Completed,
    Failed,
    Retrying
}

public enum EvaluationRunStatus
{
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled
}

public enum GameModuleHealthStatus
{
    Unknown,
    Healthy,
    Degraded,
    Unhealthy
}

public enum GameType
{
    HotSpot,
    Test
}

public enum WagerType
{
    Straight,
    TestWager
}

public sealed record GameDefinition(
    Guid Id,
    string Code,
    string DisplayName,
    Guid ActiveVersionId,
    Guid GameModuleId,
    DateTimeOffset CreatedAt);

public sealed record GameDefinitionVersion(
    Guid Id,
    Guid GameDefinitionId,
    int VersionNumber,
    string DefinitionHash,
    string PaytableVersion,
    string EvaluatorVersion,
    string DrawGeneratorVersion,
    DateTimeOffset EffectiveFrom,
    DateTimeOffset? EffectiveTo);

public sealed record GameModule(
    Guid Id,
    string Code,
    string DisplayName,
    GameModuleLifecycleStatus LifecycleStatus,
    Guid ActiveVersionId);

public sealed record GameModuleVersion(
    Guid Id,
    Guid GameModuleId,
    string Version,
    string SdkVersion,
    string ManifestHash,
    GameModuleLifecycleStatus LifecycleStatus,
    DateTimeOffset CreatedAt);

public sealed record DrawAuthority(
    Guid Id,
    string Code,
    string DisplayName,
    DrawProviderType ProviderType,
    DrawAuthorityStatus Status,
    Guid ActiveVersionId);

public sealed record DrawAuthorityVersion(
    Guid Id,
    Guid DrawAuthorityId,
    string Version,
    string ProviderVersion,
    string ConfigurationHash,
    DrawAuthorityStatus Status,
    DateTimeOffset CreatedAt);

public sealed record DrawAuthorityAssignment(
    Guid Id,
    Guid GameDefinitionId,
    Guid DrawAuthorityId,
    Guid DrawAuthorityVersionId,
    SettlementTriggerPolicy SettlementTriggerPolicy,
    DateTimeOffset EffectiveFrom,
    DateTimeOffset? EffectiveTo);

public sealed record DrawSchedule(
    Guid Id,
    Guid GameDefinitionId,
    Guid DrawAuthorityAssignmentId,
    DateTimeOffset SalesOpenAt,
    DateTimeOffset SalesCloseAt,
    DateTimeOffset DrawAt,
    DrawLifecycleStatus Status);

public sealed record DrawResultSubmission(
    Guid Id,
    Guid DrawScheduleId,
    Guid DrawAuthorityId,
    string ResultHash,
    string ResultPayloadReference,
    string SubmittedBy,
    DateTimeOffset SubmittedAt,
    bool IsManualSubmission);

public sealed record OfficialCertifiedDrawResult(
    Guid Id,
    Guid DrawScheduleId,
    Guid DrawResultSubmissionId,
    string CertifiedBy,
    DateTimeOffset CertifiedAt,
    DrawGenerationMetadata Metadata);

public sealed record GameEvaluationRun(
    Guid Id,
    Guid DrawScheduleId,
    Guid GameDefinitionVersionId,
    Guid OfficialCertifiedDrawResultId,
    EvaluationRunStatus Status,
    int BatchSize,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt);

public sealed record GameEvaluationBatch(
    Guid Id,
    Guid EvaluationRunId,
    int Sequence,
    string? Checkpoint,
    EvaluationBatchStatus Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt);

public sealed record GameEvaluationRecord(
    Guid Id,
    Guid EvaluationRunId,
    Guid EvaluationBatchId,
    Guid TicketId,
    string ResultCode,
    string EvaluationHash,
    string EvaluatorVersion,
    string PaytableVersion,
    DateTimeOffset EvaluatedAt);

public sealed record PrngProvider(
    Guid Id,
    string Code,
    string DisplayName,
    Guid ActiveVersionId);

public sealed record PrngProviderVersion(
    Guid Id,
    Guid PrngProviderId,
    string Version,
    bool IsDeterministicForTestOnly,
    DateTimeOffset CreatedAt);

public sealed record DrawGenerationMetadata(
    string GameModuleVersion,
    string DrawGeneratorVersion,
    string PrngProviderVersion,
    string DrawAuthorityVersion,
    string AlgorithmVersion,
    string PayloadHash);

public sealed record GameModuleManifest(
    string ModuleId,
    string ModuleName,
    string ModuleVersion,
    IReadOnlyCollection<GameType> GameTypes,
    IReadOnlyCollection<WagerType> SupportedWagerTypes,
    IReadOnlyCollection<DrawProviderType> SupportedDrawAuthorityTypes,
    bool SupportsInternalDrawGeneration,
    bool SupportsExternalResultEvaluation,
    bool SupportsManualResultEvaluation,
    string ConfigurationSchemaVersion,
    string EvaluatorVersion,
    string DrawGeneratorVersion,
    string MinimumGameEngineVersion,
    GameModuleLifecycleStatus LifecycleStatus,
    string Checksum,
    DateTimeOffset CreatedAt,
    string BuildMetadata);

public sealed record GameModuleStatus(
    GameModuleManifest Manifest,
    GameModuleHealthStatus HealthStatus,
    bool ProductionReady,
    IReadOnlyCollection<string> LifecycleGateBlockers,
    IReadOnlyCollection<string> LifecycleGateWarnings,
    DateTimeOffset CheckedAt);

public sealed record GameModuleVersionMetadata(
    string ModuleVersion,
    string EvaluatorVersion,
    string DrawGeneratorVersion,
    string ConfigurationSchemaVersion,
    string SdkVersion,
    string MinimumGameEngineVersion,
    string Checksum);
