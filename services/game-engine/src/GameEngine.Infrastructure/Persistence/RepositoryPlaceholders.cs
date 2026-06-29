using GameEngine.Application.Interfaces;
using GameEngine.Domain.Model;

namespace GameEngine.Infrastructure.Persistence;

public sealed class InMemoryDrawAuthorityRepository : IDrawAuthorityRepository
{
    public Task<IReadOnlyCollection<DrawAuthority>> ListAsync(CancellationToken cancellationToken)
    {
        return Task.FromResult<IReadOnlyCollection<DrawAuthority>>([]);
    }

    public Task<DrawAuthority?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return Task.FromResult<DrawAuthority?>(null);
    }
}

public sealed class InMemoryGameDefinitionRepository : IGameDefinitionRepository
{
    public Task<IReadOnlyCollection<GameDefinition>> ListAsync(CancellationToken cancellationToken)
    {
        return Task.FromResult<IReadOnlyCollection<GameDefinition>>([]);
    }

    public Task<GameDefinition?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return Task.FromResult<GameDefinition?>(null);
    }
}

public sealed class InMemoryEvaluationRepository : IEvaluationRepository
{
    public Task<IReadOnlyCollection<GameEvaluationRun>> ListRunsAsync(CancellationToken cancellationToken)
    {
        return Task.FromResult<IReadOnlyCollection<GameEvaluationRun>>([]);
    }

    public Task<GameEvaluationRun?> GetRunAsync(Guid id, CancellationToken cancellationToken)
    {
        return Task.FromResult<GameEvaluationRun?>(null);
    }
}
