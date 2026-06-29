using GameEngine.Domain.Events;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Interfaces;

public interface IDrawAuthorityRepository
{
    Task<IReadOnlyCollection<DrawAuthority>> ListAsync(CancellationToken cancellationToken);

    Task<DrawAuthority?> GetAsync(Guid id, CancellationToken cancellationToken);
}

public interface IGameDefinitionRepository
{
    Task<IReadOnlyCollection<GameDefinition>> ListAsync(CancellationToken cancellationToken);

    Task<GameDefinition?> GetAsync(Guid id, CancellationToken cancellationToken);
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
