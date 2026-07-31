namespace GameEngine.Domain.Model;

public enum InternalCsprngHealthState
{
    Instantiated,
    EntropyAcquired,
    Seeded,
    Ready,
    Reseeded,
    ExecutionSucceeded,
    ExecutionFailed
}

public sealed record InternalCsprngExecutionRequest(
    Guid RequestId,
    string IdempotencyKey,
    string CorrelationId);

public sealed record InternalCsprngHealthEvidence(
    bool SelfTestPassed,
    bool KnownAnswerTestsPassed,
    bool ContinuousTestReady,
    IReadOnlyCollection<InternalCsprngHealthState> States,
    IReadOnlyCollection<string> Blockers);

public sealed record InternalCsprngExecutionEvidence(
    string EntropySourceIdentifier,
    string ProviderVersion,
    string ConfigurationVersion,
    Guid DrbgInstanceIdentifier,
    string SeedIdentifier,
    long ReseedCounter,
    Guid RequestIdentifier,
    string GeneratedBytesHash,
    long GeneratedByteCount,
    IReadOnlyList<int> GeneratedNumbers,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    long ExecutionDurationMicroseconds,
    InternalCsprngHealthEvidence Health,
    string EvidenceHash);

public sealed record InternalCsprngGenerationResult(
    Guid ExecutionId,
    Guid ExecutionManifestId,
    Guid DrawId,
    string IdempotencyKey,
    string CanonicalRequestHash,
    string CanonicalOutcomeJson,
    string CanonicalOutcomeHash,
    InternalCsprngExecutionEvidence Evidence,
    bool Duplicate);

public sealed record InternalCsprngReadiness(
    bool ProviderImplementationReady,
    bool OperatingSystemEntropyReady,
    bool StartupSelfTestPassed,
    bool KnownAnswerTestsPassed,
    bool ContinuousTestReady,
    bool GameDefinitionDrivenGenerationReady,
    bool CanonicalEvidencePersistenceReady,
    bool ProductionReady,
    bool ProductionActive,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}

public sealed record InternalCsprngReplayResult(
    bool Valid,
    Guid ExecutionManifestId,
    string ResultHash,
    string EvidenceHash,
    IReadOnlyCollection<string> Blockers);
