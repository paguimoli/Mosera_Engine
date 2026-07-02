using GameEngine.Domain.Events;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Interfaces;

public interface IDrawAuthorityRepository
{
    Task<IReadOnlyCollection<DrawAuthority>> ListAsync(CancellationToken cancellationToken);

    Task<DrawAuthority?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<DrawAuthority> UpsertAsync(DrawAuthority authority, CancellationToken cancellationToken);
}

public interface IDrawAuthorityVersionRepository
{
    Task<IReadOnlyCollection<DrawAuthorityVersion>> ListAsync(Guid drawAuthorityId, CancellationToken cancellationToken);

    Task<DrawAuthorityVersion?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<DrawAuthorityVersion> UpsertAsync(DrawAuthorityVersion version, CancellationToken cancellationToken);
}

public interface IDrawAuthorityAssignmentRepository
{
    Task<IReadOnlyCollection<DrawAuthorityAssignment>> ListAsync(Guid gameDefinitionId, CancellationToken cancellationToken);

    Task<DrawAuthorityAssignment?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<DrawAuthorityAssignment> UpsertAsync(DrawAuthorityAssignment assignment, CancellationToken cancellationToken);
}

public interface IDrawScheduleRepository
{
    Task<IReadOnlyCollection<DrawSchedule>> ListAsync(CancellationToken cancellationToken);

    Task<DrawSchedule?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<DrawSchedule> UpsertAsync(DrawSchedule schedule, CancellationToken cancellationToken);
}

public interface IGameDefinitionRepository
{
    Task<IReadOnlyCollection<GameDefinition>> ListAsync(CancellationToken cancellationToken);

    Task<GameDefinition?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<GameDefinition> UpsertAsync(GameDefinition definition, CancellationToken cancellationToken);
}

public interface IGameDefinitionVersionRepository
{
    Task<IReadOnlyCollection<GameDefinitionVersion>> ListAsync(Guid gameDefinitionId, CancellationToken cancellationToken);

    Task<GameDefinitionVersion?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<GameDefinitionVersion> UpsertAsync(GameDefinitionVersion version, CancellationToken cancellationToken);
}

public interface IGameModuleRepository
{
    Task<IReadOnlyCollection<GameModule>> ListAsync(CancellationToken cancellationToken);

    Task<GameModule?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<GameModule> UpsertAsync(GameModule module, CancellationToken cancellationToken);
}

public interface IGameModuleVersionRepository
{
    Task<IReadOnlyCollection<GameModuleVersion>> ListAsync(Guid gameModuleId, CancellationToken cancellationToken);

    Task<GameModuleVersion?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<GameModuleVersion> UpsertAsync(GameModuleVersion version, CancellationToken cancellationToken);
}

public interface IEvaluationRepository
{
    Task<IReadOnlyCollection<GameEvaluationRun>> ListRunsAsync(CancellationToken cancellationToken);

    Task<GameEvaluationRun?> GetRunAsync(Guid id, CancellationToken cancellationToken);
}

public interface IPrngProvider
{
    string ProviderCode { get; }

    string GetVersion();

    byte[] GenerateBytes(int byteCount);
}

public interface IDrawProvider
{
    DrawProviderType ProviderType { get; }

    Task<DrawResultSubmission> SubmitResultAsync(
        Guid drawScheduleId,
        IReadOnlyDictionary<string, object?> payload,
        CancellationToken cancellationToken);
}

public interface IEventPublisher
{
    Task PublishAsync(GameEngineEvent gameEvent, CancellationToken cancellationToken);
}

public interface IEventConsumer
{
    Task StartAsync(CancellationToken cancellationToken);
}

public interface ITicketReadClient
{
    Task<IReadOnlyCollection<Guid>> PullEligibleTicketIdsAsync(
        Guid drawScheduleId,
        string? checkpoint,
        int batchSize,
        CancellationToken cancellationToken);
}

public interface IClock
{
    DateTimeOffset UtcNow { get; }
}

public interface IIdempotencyService
{
    Task<bool> HasProcessedAsync(string idempotencyKey, CancellationToken cancellationToken);

    Task RecordProcessedAsync(string idempotencyKey, CancellationToken cancellationToken);
}
