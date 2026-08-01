namespace GameEngine.Domain.Model;

public sealed record ManualCertifiedSubmissionRequest(
    Guid RequestId,
    string IdempotencyKey,
    string CorrelationId,
    string OfficialDrawIdentifier,
    string GameIdentifier,
    Guid DrawId,
    Guid ScheduleVersionId,
    Guid ExecutionManifestId,
    DateTimeOffset DrawDateTime,
    IReadOnlyList<int> CertifiedNumbers,
    IReadOnlyList<int> BonusNumbers,
    IReadOnlyDictionary<string, object?> ProviderMetadata,
    string CertificationReference,
    string OperatorIdentityReference,
    string ReasonCode,
    string SubmissionEvidenceHash,
    DateTimeOffset SubmittedAt,
    Guid? SupersedesEvidenceId = null,
    string? CorrectionReason = null);

public sealed record ManualCertifiedNormalizedPayload(
    string ProviderId,
    string ProviderVersion,
    string ConfigurationVersion,
    string OfficialDrawIdentifier,
    string GameIdentifier,
    Guid DrawId,
    Guid ScheduleVersionId,
    Guid ExecutionManifestId,
    DateTimeOffset DrawDateTime,
    IReadOnlyList<int> CertifiedNumbers,
    IReadOnlyList<int> BonusNumbers,
    OutcomeNumberOrdering NumberOrdering,
    OutcomeNumberOrdering? BonusNumberOrdering,
    IReadOnlyDictionary<string, object?> ProviderMetadata,
    string CertificationReference,
    string OperatorIdentityReference,
    string ReasonCode,
    string CanonicalPayloadJson,
    string CanonicalPayloadHash);

public sealed record ManualCertifiedProviderEvidence(
    Guid RequestId,
    Guid ExecutionId,
    int ExecutionVersion,
    Guid? SupersedesExecutionId,
    Guid? SupersedesEvidenceId,
    string? CorrectionReason,
    string ProviderId,
    string ProviderVersion,
    string ConfigurationVersion,
    string OperatorIdentityReference,
    string CertificationReference,
    string ReasonCode,
    DateTimeOffset SubmissionTimestamp,
    string SubmissionEvidenceHash,
    string NormalizedPayloadHash,
    string ReplayIdentifier,
    string CanonicalRequestHash,
    ManualCertifiedNormalizedPayload NormalizedResult,
    string EvidenceHash,
    DateTimeOffset CompletedAt);

public sealed record ManualCertifiedSubmissionResult(
    Guid ExecutionId,
    Guid CanonicalEvidenceId,
    Guid ExecutionManifestId,
    Guid DrawId,
    string IdempotencyKey,
    string CanonicalRequestHash,
    ManualCertifiedNormalizedPayload NormalizedResult,
    ManualCertifiedProviderEvidence Evidence,
    bool Duplicate,
    bool Superseding);

public sealed record ManualCertifiedReplayResult(
    bool Valid,
    Guid ExecutionManifestId,
    string ResultHash,
    string EvidenceHash,
    IReadOnlyCollection<string> Blockers);

public sealed record ManualCertifiedProviderReadiness(
    bool ProviderImplementationReady,
    bool ImmutableSubmissionContractReady,
    bool DrawAndManifestValidationReady,
    bool GameDefinitionValidationReady,
    bool CanonicalEvidencePersistenceReady,
    bool DurableIdempotencyReady,
    bool SupersessionReady,
    bool ReplayReady,
    bool RecoveryReady,
    bool ProductionReady,
    bool ProductionActive,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}
