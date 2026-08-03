using Npgsql;
using GameEngine.Application.Interfaces;

namespace GameEngine.Infrastructure.Persistence;

public sealed class OperationalSecurityAuthority(string? databaseUrl) : IOperationalSecurityAuthority
{
    private readonly string? databaseUrl = databaseUrl;

    public async Task ValidateAsync(
        string? commandId,
        string? privilegedSessionId,
        string? executorIdentityId,
        string expectedCommandType,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(
                Environment.GetEnvironmentVariable("DEPLOYMENT_ENVIRONMENT"),
                "production",
                StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        if (!Guid.TryParse(commandId, out var parsedCommandId) ||
            !Guid.TryParse(privilegedSessionId, out var parsedPrivilegedSessionId) ||
            string.IsNullOrWhiteSpace(executorIdentityId) ||
            string.IsNullOrWhiteSpace(databaseUrl))
        {
            throw new InvalidOperationException(
                "Production Game Engine operations require canonical operational-security evidence.");
        }

        const string sql = """
            select exists (
              select 1
                from operational_governance.commands command
                join operational_governance.security_validation_evidence evidence
                  on evidence.command_id = command.command_id
               where command.command_id = @command_id
                 and command.command_type = @command_type
                 and evidence.privileged_session_id = @privileged_session_id
                 and evidence.executor_identity_id = @executor_identity_id
                 and evidence.production_enforced
                 and evidence.decision = 'AUTHORIZED'
            )
            """;

        await using var connection = new NpgsqlConnection(databaseUrl);
        await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(sql, connection);
        command.Parameters.AddWithValue("command_id", parsedCommandId);
        command.Parameters.AddWithValue("command_type", expectedCommandType);
        command.Parameters.AddWithValue("privileged_session_id", parsedPrivilegedSessionId);
        command.Parameters.AddWithValue("executor_identity_id", executorIdentityId.Trim());
        var authorized = (bool?)await command.ExecuteScalarAsync(cancellationToken) == true;
        if (!authorized)
        {
            throw new InvalidOperationException(
                "Canonical Operational Security Authority denied the Game Engine operation.");
        }
    }
}
