namespace GameEngine.Domain.Model;

public enum OfficialResultAcquisitionMethod
{
    OfficialApi,
    OfficialFile,
    OfficialScraper,
    ManualImport
}

public sealed record OfficialResultIngestionRequest(
    Guid RequestId,
    string IdempotencyKey,
    string CorrelationId,
    string SourceId,
    string SourceVersion,
    OfficialResultAcquisitionMethod AcquisitionMethod,
    string? Jurisdiction,
    string GameIdentifier,
    Guid DrawId,
    Guid ScheduleVersionId,
    Guid ExecutionManifestId,
    DateTimeOffset DrawDateTime,
    IReadOnlyList<int> OfficialNumbers,
    IReadOnlyList<int> BonusNumbers,
    IReadOnlyDictionary<string, object?> Metadata,
    string RawPayloadHash,
    string SourceAuthenticationEvidenceHash,
    string TransportEvidenceHash,
    DateTimeOffset RetrievedAt,
    Guid? SupersedesEvidenceId = null,
    string? CorrectionReason = null);

public sealed record OfficialResultNormalizedPayload(
    string ProviderId,
    string ProviderVersion,
    string ConfigurationVersion,
    string SourceId,
    string SourceVersion,
    OfficialResultAcquisitionMethod AcquisitionMethod,
    string? Jurisdiction,
    string GameIdentifier,
    Guid DrawId,
    Guid ScheduleVersionId,
    Guid ExecutionManifestId,
    DateTimeOffset DrawDateTime,
    IReadOnlyList<int> OfficialNumbers,
    IReadOnlyList<int> BonusNumbers,
    OutcomeNumberOrdering NumberOrdering,
    OutcomeNumberOrdering? BonusNumberOrdering,
    IReadOnlyDictionary<string, object?> Metadata,
    string CanonicalPayloadJson,
    string CanonicalPayloadHash);

public sealed record OfficialResultProviderEvidence(
    Guid RequestId,
    Guid ExecutionId,
    int ExecutionVersion,
    Guid? SupersedesExecutionId,
    Guid? SupersedesEvidenceId,
    string? CorrectionReason,
    string ProviderId,
    string ProviderVersion,
    string ConfigurationVersion,
    string SourceId,
    string SourceVersion,
    OfficialResultAcquisitionMethod AcquisitionMethod,
    DateTimeOffset RetrievedAt,
    string NormalizationVersion,
    bool ValidationPassed,
    string RawPayloadHash,
    string NormalizedPayloadHash,
    string SourceAuthenticationEvidenceHash,
    string TransportEvidenceHash,
    string ReplayIdentifier,
    string CanonicalRequestHash,
    OfficialResultNormalizedPayload NormalizedResult,
    string EvidenceHash,
    DateTimeOffset CompletedAt);

public sealed record OfficialResultIngestionResult(
    Guid ExecutionId,
    Guid CanonicalEvidenceId,
    Guid ExecutionManifestId,
    Guid DrawId,
    string IdempotencyKey,
    string CanonicalRequestHash,
    OfficialResultNormalizedPayload NormalizedResult,
    OfficialResultProviderEvidence Evidence,
    bool Duplicate,
    bool Superseding);

public sealed record OfficialResultReplayResult(
    bool Valid,
    Guid ExecutionManifestId,
    string ResultHash,
    string EvidenceHash,
    IReadOnlyCollection<string> Blockers);

public sealed record OfficialResultsProviderReadiness(
    bool ProviderImplementationReady,
    bool SourceRegistryReady,
    bool AcquisitionContractReady,
    bool NormalizationReady,
    bool GameDefinitionValidationReady,
    bool ExactDrawMatchingReady,
    bool CanonicalEvidencePersistenceReady,
    bool ReplayReady,
    bool RecoveryReady,
    bool ProductionReady,
    bool ProductionActive,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}
