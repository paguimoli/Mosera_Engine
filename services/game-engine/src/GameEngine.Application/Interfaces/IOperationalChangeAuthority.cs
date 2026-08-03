namespace GameEngine.Application.Interfaces;

public sealed record OperationalChangeExecution(Guid ChangeId, Guid CommandId, int Attempt, string ExecutorIdentityId);

public interface IOperationalChangeAuthority
{
    Task<OperationalChangeExecution?> BeginAsync(
        string? changeId,
        string? commandId,
        string? executorIdentityId,
        string expectedChangeType,
        CancellationToken cancellationToken);

    Task CompleteAsync(
        OperationalChangeExecution? execution,
        object result,
        object observedState,
        CancellationToken cancellationToken);

    Task FailAsync(
        OperationalChangeExecution? execution,
        Exception failure,
        CancellationToken cancellationToken);
}
