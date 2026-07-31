namespace GameEngine.Domain.Model;

public enum CanonicalOutcomeProviderCategory
{
    InternalCsprng,
    OfficialResults,
    ManualCertified
}

public enum OutcomeProviderActivationState
{
    Disabled,
    Enabled,
    Suspended
}

public enum OutcomeProviderExecutionStatus
{
    Claimed,
    RetryableFailure,
    NonRetryableFailure,
    Completed
}

public enum OutcomeProviderFailureClassification
{
    None,
    Retryable,
    NonRetryable
}

public enum OutcomeProviderEvidenceStage
{
    Generated,
    Authoritative
}

public sealed record CanonicalOutcomeProviderRegistration(
    string ProviderId,
    string ProviderVersion,
    string ConfigurationVersion,
    CanonicalOutcomeProviderCategory ProviderCategory,
    string ConfigurationHash,
    IReadOnlyCollection<string> SupportedCapabilities,
    IReadOnlyDictionary<string, object?> EvidenceRequirements,
    IReadOnlyCollection<string> ReadinessCapabilities,
    OutcomeProviderActivationState ActivationState,
    bool ProductionEligible,
    bool ProductionReady,
    bool FailClosed,
    DateTimeOffset ActivationEffectiveAt);

public sealed record OutcomeProviderExecutionClaim(
    Guid ExecutionId,
    Guid ExecutionManifestId,
    string ProviderId,
    string ProviderVersion,
    string ConfigurationVersion,
    string IdempotencyKey,
    string CanonicalRequestHash,
    DateTimeOffset ClaimedAt);

public sealed record OutcomeProviderExecutionAttempt(
    Guid AttemptId,
    Guid ExecutionId,
    int AttemptNumber,
    OutcomeProviderExecutionStatus Status,
    OutcomeProviderFailureClassification FailureClassification,
    string? FailureCode,
    string? FailureReason,
    string RequestHash,
    string AttemptHash,
    DateTimeOffset StartedAt,
    DateTimeOffset? CompletedAt);

public sealed record OutcomeProviderExecutionEvidence(
    Guid EvidenceId,
    Guid ExecutionId,
    Guid ExecutionManifestId,
    Guid DrawId,
    string ProviderId,
    string ProviderVersion,
    string ConfigurationVersion,
    string RequestHash,
    string ResultHash,
    string EvidenceHash,
    Guid? OutcomeCertificateId,
    string? OutcomeCertificateHash,
    int ExecutionAttempt,
    string IdempotencyKey,
    OutcomeProviderEvidenceStage Stage,
    string ProviderEvidenceJson,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt);

public sealed record OutcomeProviderClaimResult(
    OutcomeProviderExecutionClaim Claim,
    bool Created,
    bool Duplicate);

public sealed record CanonicalOutcomeProviderReadiness(
    bool ProviderRegistryReady,
    bool ProviderRegistered,
    bool ProviderVersionResolved,
    bool ConfigurationVersionResolved,
    bool ProviderEnabled,
    bool ProviderProductionReady,
    bool ProviderEvidencePersistenceReady,
    bool ProductionActivationDisabled,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}
