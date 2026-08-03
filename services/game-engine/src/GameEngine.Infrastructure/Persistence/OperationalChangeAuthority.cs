using System.Text.Json;
using GameEngine.Application.Interfaces;
using Npgsql;

namespace GameEngine.Infrastructure.Persistence;

public sealed class OperationalChangeAuthority(string? databaseUrl) : IOperationalChangeAuthority
{
    private readonly string? databaseUrl = databaseUrl;

    private static bool ProductionEnforced => string.Equals(
        Environment.GetEnvironmentVariable("DEPLOYMENT_ENVIRONMENT"),
        "production",
        StringComparison.OrdinalIgnoreCase);

    public async Task<OperationalChangeExecution?> BeginAsync(
        string? changeId,
        string? commandId,
        string? executorIdentityId,
        string expectedChangeType,
        CancellationToken cancellationToken)
    {
        if (!ProductionEnforced) return null;
        if (!Guid.TryParse(changeId, out var parsedChangeId) ||
            !Guid.TryParse(commandId, out var parsedCommandId) ||
            string.IsNullOrWhiteSpace(executorIdentityId) ||
            string.IsNullOrWhiteSpace(databaseUrl))
        {
            throw new InvalidOperationException(
                "Production Game Engine changes require canonical Operational Change evidence.");
        }

        await using var connection = new NpgsqlConnection(databaseUrl);
        await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand(
            "select operational_governance.begin_change_execution(@change_id,@command_id,@executor_identity_id,@change_type)",
            connection);
        command.Parameters.AddWithValue("change_id", parsedChangeId);
        command.Parameters.AddWithValue("command_id", parsedCommandId);
        command.Parameters.AddWithValue("executor_identity_id", executorIdentityId.Trim());
        command.Parameters.AddWithValue("change_type", expectedChangeType);
        var attempt = Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken));
        if (attempt == 0)
        {
            throw new InvalidOperationException("Operational change was already verified; duplicate execution is blocked.");
        }
        return new OperationalChangeExecution(parsedChangeId, parsedCommandId, attempt, executorIdentityId.Trim());
    }

    public Task CompleteAsync(
        OperationalChangeExecution? execution,
        object result,
        object observedState,
        CancellationToken cancellationToken) =>
        CompleteInternalAsync(execution, result, observedState, true, null, null, cancellationToken);

    public Task FailAsync(
        OperationalChangeExecution? execution,
        Exception failure,
        CancellationToken cancellationToken) =>
        CompleteInternalAsync(execution, new { }, new { status = "FAILED", reason = failure.Message },
            false, failure.GetType().Name, failure.Message, cancellationToken);

    private async Task CompleteInternalAsync(
        OperationalChangeExecution? execution,
        object result,
        object observedState,
        bool verified,
        string? failureCode,
        string? failureReason,
        CancellationToken cancellationToken)
    {
        if (execution is null) return;
        if (string.IsNullOrWhiteSpace(databaseUrl))
        {
            throw new InvalidOperationException("Operational Change persistence is unavailable.");
        }
        await using var connection = new NpgsqlConnection(databaseUrl);
        await connection.OpenAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            select (operational_governance.complete_change_execution(
              @change_id,@attempt,@executor_identity_id,@result::jsonb,@observed::jsonb,
              @expected_state_reached,@authority_accepted,@readiness_maintained,@audit_recorded,
              @failure_code,@failure_reason)).decision
            """, connection);
        command.Parameters.AddWithValue("change_id", execution.ChangeId);
        command.Parameters.AddWithValue("attempt", execution.Attempt);
        command.Parameters.AddWithValue("executor_identity_id", execution.ExecutorIdentityId);
        command.Parameters.AddWithValue("result", JsonSerializer.Serialize(result));
        command.Parameters.AddWithValue("observed", JsonSerializer.Serialize(observedState));
        command.Parameters.AddWithValue("expected_state_reached", verified);
        command.Parameters.AddWithValue("authority_accepted", verified);
        command.Parameters.AddWithValue("readiness_maintained", verified);
        command.Parameters.AddWithValue("audit_recorded", true);
        command.Parameters.AddWithValue("failure_code", (object?)failureCode ?? DBNull.Value);
        command.Parameters.AddWithValue("failure_reason", (object?)failureReason ?? DBNull.Value);
        var decision = Convert.ToString(await command.ExecuteScalarAsync(cancellationToken));
        if (verified && !string.Equals(decision, "VERIFIED", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Canonical operational change verification failed.");
        }
    }
}
