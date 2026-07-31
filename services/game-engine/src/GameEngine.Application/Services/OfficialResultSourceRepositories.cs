using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public interface IExternalResultSourceRepository
{
    Task<ExternalResultSourceDefinition?> FindSourceAsync(
        string sourceId,
        string sourceVersion,
        CancellationToken cancellationToken);

    Task<ExternalResultRuntimeReadiness> CheckReadinessAsync(
        CancellationToken cancellationToken);
}

public sealed class InMemoryExternalResultSourceRepository : IExternalResultSourceRepository
{
    private readonly List<ExternalResultSourceDefinition> sources = [];

    public IReadOnlyCollection<ExternalResultSourceDefinition> Sources => sources;

    public void Add(ExternalResultSourceDefinition source)
    {
        sources.Add(source);
    }

    public Task<ExternalResultSourceDefinition?> FindSourceAsync(
        string sourceId,
        string sourceVersion,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(sources.LastOrDefault(source =>
            source.SourceId == sourceId &&
            source.SourceVersion == sourceVersion));
    }

    public Task<ExternalResultRuntimeReadiness> CheckReadinessAsync(
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new ExternalResultRuntimeReadiness(
            SourceRepositoryReady: true,
            SignatureVerificationReady: true,
            SchemaNormalizationReady: true,
            IngestionEvidenceRepositoryReady: false,
            DurableIdempotencyReady: false,
            AdvisoryLockingReady: false,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: ["in-memory-official-result-source-registry"],
            Blockers: []));
    }
}
