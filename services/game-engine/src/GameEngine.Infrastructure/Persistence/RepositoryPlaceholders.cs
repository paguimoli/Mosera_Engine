using GameEngine.Application.Interfaces;
using GameEngine.Domain.Model;

namespace GameEngine.Infrastructure.Persistence;

public sealed class InMemoryDrawAuthorityRepository : IDrawAuthorityRepository
{
    private readonly Dictionary<Guid, DrawAuthority> authoritiesById = [];

    public Task<IReadOnlyCollection<DrawAuthority>> ListAsync(CancellationToken cancellationToken)
    {
        return Task.FromResult<IReadOnlyCollection<DrawAuthority>>(
            authoritiesById.Values.OrderBy(authority => authority.Code, StringComparer.OrdinalIgnoreCase).ToArray());
    }

    public Task<DrawAuthority?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return Task.FromResult(authoritiesById.GetValueOrDefault(id));
    }

    public Task<DrawAuthority> UpsertAsync(DrawAuthority authority, CancellationToken cancellationToken)
    {
        authoritiesById[authority.Id] = authority;
        return Task.FromResult(authority);
    }
}

public sealed class InMemoryDrawAuthorityVersionRepository : IDrawAuthorityVersionRepository
{
    private readonly Dictionary<Guid, DrawAuthorityVersion> versionsById = [];

    public Task<IReadOnlyCollection<DrawAuthorityVersion>> ListAsync(Guid drawAuthorityId, CancellationToken cancellationToken)
    {
        return Task.FromResult<IReadOnlyCollection<DrawAuthorityVersion>>(
            versionsById.Values
                .Where(version => version.DrawAuthorityId == drawAuthorityId)
                .OrderBy(version => version.Version, StringComparer.OrdinalIgnoreCase)
                .ThenBy(version => version.Id)
                .ToArray());
    }

    public Task<DrawAuthorityVersion?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return Task.FromResult(versionsById.GetValueOrDefault(id));
    }

    public Task<DrawAuthorityVersion> UpsertAsync(DrawAuthorityVersion version, CancellationToken cancellationToken)
    {
        versionsById[version.Id] = version;
        return Task.FromResult(version);
    }
}

public sealed class InMemoryDrawAuthorityAssignmentRepository : IDrawAuthorityAssignmentRepository
{
    private readonly Dictionary<Guid, DrawAuthorityAssignment> assignmentsById = [];

    public Task<IReadOnlyCollection<DrawAuthorityAssignment>> ListAsync(Guid gameDefinitionId, CancellationToken cancellationToken)
    {
        return Task.FromResult<IReadOnlyCollection<DrawAuthorityAssignment>>(
            assignmentsById.Values
                .Where(assignment => assignment.GameDefinitionId == gameDefinitionId)
                .OrderBy(assignment => assignment.EffectiveFrom)
                .ThenBy(assignment => assignment.Id)
                .ToArray());
    }

    public Task<DrawAuthorityAssignment?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return Task.FromResult(assignmentsById.GetValueOrDefault(id));
    }

    public Task<DrawAuthorityAssignment> UpsertAsync(DrawAuthorityAssignment assignment, CancellationToken cancellationToken)
    {
        assignmentsById[assignment.Id] = assignment;
        return Task.FromResult(assignment);
    }
}

public sealed class InMemoryDrawScheduleRepository : IDrawScheduleRepository
{
    private readonly Dictionary<Guid, DrawSchedule> schedulesById = [];

    public Task<IReadOnlyCollection<DrawSchedule>> ListAsync(CancellationToken cancellationToken)
    {
        return Task.FromResult<IReadOnlyCollection<DrawSchedule>>(
            schedulesById.Values
                .OrderBy(schedule => schedule.DrawAt)
                .ThenBy(schedule => schedule.Id)
                .ToArray());
    }

    public Task<DrawSchedule?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return Task.FromResult(schedulesById.GetValueOrDefault(id));
    }

    public Task<DrawSchedule> UpsertAsync(DrawSchedule schedule, CancellationToken cancellationToken)
    {
        schedulesById[schedule.Id] = schedule;
        return Task.FromResult(schedule);
    }
}

public sealed class InMemoryGameDefinitionRepository : IGameDefinitionRepository
{
    private readonly Dictionary<Guid, GameDefinition> definitionsById = [];

    public Task<IReadOnlyCollection<GameDefinition>> ListAsync(CancellationToken cancellationToken)
    {
        return Task.FromResult<IReadOnlyCollection<GameDefinition>>(
            definitionsById.Values.OrderBy(definition => definition.Code, StringComparer.OrdinalIgnoreCase).ToArray());
    }

    public Task<GameDefinition?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return Task.FromResult(definitionsById.GetValueOrDefault(id));
    }

    public Task<GameDefinition> UpsertAsync(GameDefinition definition, CancellationToken cancellationToken)
    {
        definitionsById[definition.Id] = definition;
        return Task.FromResult(definition);
    }
}

public sealed class InMemoryGameDefinitionVersionRepository : IGameDefinitionVersionRepository
{
    private readonly Dictionary<Guid, GameDefinitionVersion> versionsById = [];

    public Task<IReadOnlyCollection<GameDefinitionVersion>> ListAsync(Guid gameDefinitionId, CancellationToken cancellationToken)
    {
        return Task.FromResult<IReadOnlyCollection<GameDefinitionVersion>>(
            versionsById.Values
                .Where(version => version.GameDefinitionId == gameDefinitionId)
                .OrderBy(version => version.VersionNumber)
                .ThenBy(version => version.Id)
                .ToArray());
    }

    public Task<GameDefinitionVersion?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return Task.FromResult(versionsById.GetValueOrDefault(id));
    }

    public Task<GameDefinitionVersion> UpsertAsync(GameDefinitionVersion version, CancellationToken cancellationToken)
    {
        versionsById[version.Id] = version;
        return Task.FromResult(version);
    }
}

public sealed class InMemoryGameModuleRepository : IGameModuleRepository
{
    private readonly Dictionary<Guid, GameModule> modulesById = [];

    public Task<IReadOnlyCollection<GameModule>> ListAsync(CancellationToken cancellationToken)
    {
        return Task.FromResult<IReadOnlyCollection<GameModule>>(
            modulesById.Values.OrderBy(module => module.Code, StringComparer.OrdinalIgnoreCase).ToArray());
    }

    public Task<GameModule?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return Task.FromResult(modulesById.GetValueOrDefault(id));
    }

    public Task<GameModule> UpsertAsync(GameModule module, CancellationToken cancellationToken)
    {
        modulesById[module.Id] = module;
        return Task.FromResult(module);
    }
}

public sealed class InMemoryGameModuleVersionRepository : IGameModuleVersionRepository
{
    private readonly Dictionary<Guid, GameModuleVersion> versionsById = [];

    public Task<IReadOnlyCollection<GameModuleVersion>> ListAsync(Guid gameModuleId, CancellationToken cancellationToken)
    {
        return Task.FromResult<IReadOnlyCollection<GameModuleVersion>>(
            versionsById.Values
                .Where(version => version.GameModuleId == gameModuleId)
                .OrderBy(version => version.Version, StringComparer.OrdinalIgnoreCase)
                .ThenBy(version => version.Id)
                .ToArray());
    }

    public Task<GameModuleVersion?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return Task.FromResult(versionsById.GetValueOrDefault(id));
    }

    public Task<GameModuleVersion> UpsertAsync(GameModuleVersion version, CancellationToken cancellationToken)
    {
        versionsById[version.Id] = version;
        return Task.FromResult(version);
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
