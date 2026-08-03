namespace GameEngine.Application.Interfaces;

public interface IOperationalSecurityAuthority
{
    Task ValidateAsync(
        string? commandId,
        string? privilegedSessionId,
        string? executorIdentityId,
        string expectedCommandType,
        CancellationToken cancellationToken);
}
