using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresOutcomeRuntimeRequestRepository(string connectionString) : IOutcomeRuntimeRequestRepository
{
    public async Task<OutcomeRuntimeStoredRequest?> FindByIdempotencyKeyAsync(
        string idempotencyKey,
        string drawRequestScope,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await FindByIdempotencyKeyAsync(connection, idempotencyKey, drawRequestScope, cancellationToken);
    }

    public async Task<OutcomeRuntimeRequestClaim> ClaimRequestAsync(
        OutcomeRuntimeStoredRequest request,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var existing = await FindByIdempotencyKeyAsync(
            connection,
            request.IdempotencyKey,
            request.DrawRequestScope,
            cancellationToken);

        if (existing is not null)
        {
            if (existing.CanonicalRequestHash != request.CanonicalRequestHash)
            {
                throw new InvalidOperationException("Conflicting payload for the same runtime idempotency key.");
            }

            await transaction.CommitAsync(cancellationToken);
            return new OutcomeRuntimeRequestClaim(existing, Created: false, Duplicate: true);
        }

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.outcome_runtime_requests (
  runtime_request_id,
  idempotency_key,
  draw_request_scope,
  game_manifest_id,
  game_manifest_version,
  provider_id,
  provider_version,
  provider_type,
  mode,
  status,
  started_at,
  completed_at,
  failure_code,
  failure_reason,
  canonical_request_hash,
  result_reference_placeholder,
  evidence_reference_placeholder,
  lock_scope,
  lock_acquired
) values (
  @runtime_request_id,
  @idempotency_key,
  @draw_request_scope,
  @game_manifest_id,
  @game_manifest_version,
  @provider_id,
  @provider_version,
  @provider_type,
  @mode,
  @status,
  @started_at,
  @completed_at,
  @failure_code,
  @failure_reason,
  @canonical_request_hash,
  @result_reference_placeholder,
  @evidence_reference_placeholder,
  @lock_scope,
  @lock_acquired
)
on conflict (idempotency_key, draw_request_scope) do nothing;
""";
        AddRequestParameters(command, request);
        var inserted = await command.ExecuteNonQueryAsync(cancellationToken);
        var claimed = inserted == 1
            ? request
            : await FindByIdempotencyKeyAsync(
                connection,
                request.IdempotencyKey,
                request.DrawRequestScope,
                cancellationToken);

        if (claimed is null)
        {
            throw new InvalidOperationException("Outcome runtime request claim could not be read back deterministically.");
        }

        if (claimed.CanonicalRequestHash != request.CanonicalRequestHash)
        {
            throw new InvalidOperationException("Conflicting payload for the same runtime idempotency key.");
        }

        await transaction.CommitAsync(cancellationToken);
        return new OutcomeRuntimeRequestClaim(claimed, Created: inserted == 1, Duplicate: inserted != 1);
    }

    public async Task<OutcomeRuntimeStoredRequest> AppendRequestAsync(
        OutcomeRuntimeStoredRequest request,
        CancellationToken cancellationToken)
    {
        return (await ClaimRequestAsync(request, cancellationToken)).Request;
    }

    public async Task AppendAttemptAsync(
        OutcomeRuntimeAttemptEvidence attempt,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.outcome_runtime_attempts (
  attempt_id,
  runtime_request_id,
  idempotency_key,
  draw_request_scope,
  provider_id,
  provider_version,
  provider_type,
  mode,
  status,
  failure_code,
  failure_reason,
  lock_scope,
  lock_acquired,
  canonical_attempt_hash,
  started_at,
  completed_at
) values (
  @attempt_id,
  @runtime_request_id,
  @idempotency_key,
  @draw_request_scope,
  @provider_id,
  @provider_version,
  @provider_type,
  @mode,
  @status,
  @failure_code,
  @failure_reason,
  @lock_scope,
  @lock_acquired,
  @canonical_attempt_hash,
  @started_at,
  @completed_at
);
""";
        command.Parameters.AddWithValue("attempt_id", attempt.AttemptId);
        command.Parameters.AddWithValue("runtime_request_id", attempt.RuntimeRequestId);
        command.Parameters.AddWithValue("idempotency_key", attempt.IdempotencyKey);
        command.Parameters.AddWithValue("draw_request_scope", attempt.DrawRequestScope);
        command.Parameters.AddWithValue("provider_id", attempt.ProviderId);
        command.Parameters.AddWithValue("provider_version", attempt.ProviderVersion);
        command.Parameters.AddWithValue("provider_type", ToDatabaseProviderType(attempt.ProviderType));
        command.Parameters.AddWithValue("mode", attempt.Mode.ToString());
        command.Parameters.AddWithValue("status", attempt.Status.ToString());
        command.Parameters.AddWithValue("failure_code", attempt.FailureCode.ToString());
        command.Parameters.AddWithValue("failure_reason", attempt.FailureReason is null ? DBNull.Value : attempt.FailureReason);
        command.Parameters.AddWithValue("lock_scope", attempt.LockScope);
        command.Parameters.AddWithValue("lock_acquired", attempt.LockAcquired);
        command.Parameters.AddWithValue("canonical_attempt_hash", attempt.CanonicalAttemptHash);
        command.Parameters.AddWithValue("started_at", attempt.StartedAt);
        command.Parameters.AddWithValue("completed_at", attempt.CompletedAt is null ? DBNull.Value : attempt.CompletedAt.Value);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<OutcomeRuntimePersistenceReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('game_engine.outcome_runtime_requests') is not null,
  to_regclass('game_engine.outcome_runtime_attempts') is not null;
""";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            await reader.ReadAsync(cancellationToken);
            if (!reader.GetBoolean(0))
            {
                blockers.Add("game_engine.outcome_runtime_requests is missing.");
            }

            if (!reader.GetBoolean(1))
            {
                blockers.Add("game_engine.outcome_runtime_attempts is missing.");
            }
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            blockers.Add(error.Message);
        }

        return new OutcomeRuntimePersistenceReadiness(
            DurablePersistenceConfigured: true,
            DurablePersistenceReachable: blockers.Count == 0,
            IdempotencyRepositoryReady: blockers.Count == 0,
            RuntimeAttemptsRepositoryReady: blockers.Count == 0,
            ProductionGenerationDisabled: true,
            Blockers: blockers);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static async Task<OutcomeRuntimeStoredRequest?> FindByIdempotencyKeyAsync(
        NpgsqlConnection connection,
        string idempotencyKey,
        string drawRequestScope,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  runtime_request_id,
  idempotency_key,
  draw_request_scope,
  game_manifest_id,
  game_manifest_version,
  provider_id,
  provider_version,
  provider_type,
  mode,
  status,
  failure_code,
  failure_reason,
  canonical_request_hash,
  result_reference_placeholder,
  evidence_reference_placeholder,
  started_at,
  completed_at
from game_engine.outcome_runtime_requests
where idempotency_key = @idempotency_key
  and draw_request_scope = @draw_request_scope
order by created_at desc
limit 1;
""";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        command.Parameters.AddWithValue("draw_request_scope", drawRequestScope);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadRequest(reader) : null;
    }

    private static OutcomeRuntimeStoredRequest ReadRequest(NpgsqlDataReader reader)
    {
        return new OutcomeRuntimeStoredRequest(
            reader.GetGuid(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetString(6),
            FromDatabaseProviderType(reader.GetString(7)),
            Enum.Parse<OutcomeRuntimeExecutionMode>(reader.GetString(8), ignoreCase: true),
            Enum.Parse<OutcomeRuntimeStatus>(reader.GetString(9), ignoreCase: true),
            Enum.Parse<OutcomeRuntimeFailureCode>(reader.GetString(10), ignoreCase: true),
            reader.IsDBNull(11) ? null : reader.GetString(11),
            reader.GetString(12),
            reader.IsDBNull(13) ? null : reader.GetString(13),
            reader.IsDBNull(14) ? null : reader.GetString(14),
            reader.GetFieldValue<DateTimeOffset>(15),
            reader.IsDBNull(16) ? null : reader.GetFieldValue<DateTimeOffset>(16));
    }

    private static void AddRequestParameters(NpgsqlCommand command, OutcomeRuntimeStoredRequest request)
    {
        command.Parameters.AddWithValue("runtime_request_id", request.RuntimeRequestId);
        command.Parameters.AddWithValue("idempotency_key", request.IdempotencyKey);
        command.Parameters.AddWithValue("draw_request_scope", request.DrawRequestScope);
        command.Parameters.AddWithValue("game_manifest_id", request.GameManifestId);
        command.Parameters.AddWithValue("game_manifest_version", request.GameManifestVersion);
        command.Parameters.AddWithValue("provider_id", request.ProviderId);
        command.Parameters.AddWithValue("provider_version", request.ProviderVersion);
        command.Parameters.AddWithValue("provider_type", ToDatabaseProviderType(request.ProviderType));
        command.Parameters.AddWithValue("mode", request.Mode.ToString());
        command.Parameters.AddWithValue("status", request.Status.ToString());
        command.Parameters.AddWithValue("started_at", request.StartedAt);
        command.Parameters.AddWithValue("completed_at", request.CompletedAt is null ? DBNull.Value : request.CompletedAt.Value);
        command.Parameters.AddWithValue("failure_code", request.FailureCode.ToString());
        command.Parameters.AddWithValue("failure_reason", request.FailureReason is null ? DBNull.Value : request.FailureReason);
        command.Parameters.AddWithValue("canonical_request_hash", request.CanonicalRequestHash);
        command.Parameters.AddWithValue("result_reference_placeholder", request.ResultReference is null ? DBNull.Value : request.ResultReference);
        command.Parameters.AddWithValue("evidence_reference_placeholder", request.EvidenceReference is null ? DBNull.Value : request.EvidenceReference);
        command.Parameters.AddWithValue("lock_scope", OutcomeRuntimeLockScope.ForStoredRequest(request));
        command.Parameters.AddWithValue("lock_acquired", request.Status is not OutcomeRuntimeStatus.FailedClosed ||
            request.FailureCode is not OutcomeRuntimeFailureCode.LockUnavailable);
    }

    private static string ToDatabaseProviderType(OutcomeProviderType providerType)
    {
        return providerType switch
        {
            OutcomeProviderType.CertifiedCsprng => "CERTIFIED_CSPRNG",
            OutcomeProviderType.ProvablyFair => "PROVABLY_FAIR",
            OutcomeProviderType.ExternalOfficialResult => "EXTERNAL_OFFICIAL_RESULT",
            OutcomeProviderType.PhysicalDrawResult => "PHYSICAL_DRAW_RESULT",
            OutcomeProviderType.SimulationTest => "SIMULATION_TEST",
            _ => throw new ArgumentOutOfRangeException(nameof(providerType), providerType, "Unsupported Outcome Provider type.")
        };
    }

    private static OutcomeProviderType FromDatabaseProviderType(string providerType)
    {
        return providerType switch
        {
            "CERTIFIED_CSPRNG" => OutcomeProviderType.CertifiedCsprng,
            "PROVABLY_FAIR" => OutcomeProviderType.ProvablyFair,
            "EXTERNAL_OFFICIAL_RESULT" => OutcomeProviderType.ExternalOfficialResult,
            "PHYSICAL_DRAW_RESULT" => OutcomeProviderType.PhysicalDrawResult,
            "SIMULATION_TEST" => OutcomeProviderType.SimulationTest,
            _ => Enum.Parse<OutcomeProviderType>(providerType, ignoreCase: true)
        };
    }
}

public sealed class PostgresOutcomeRuntimeLockManager(string connectionString) : IOutcomeRuntimeLockManager, IAsyncDisposable
{
    private readonly Dictionary<string, NpgsqlConnection> heldConnections = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim gate = new(1, 1);

    public async Task<OutcomeRuntimeLockLease> TryAcquireAsync(
        string lockScope,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow.Add(timeout);
        while (DateTimeOffset.UtcNow <= deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();

            await gate.WaitAsync(cancellationToken);
            try
            {
                if (heldConnections.ContainsKey(lockScope))
                {
                    return new OutcomeRuntimeLockLease(lockScope, Acquired: false, "Outcome runtime lock is already held by this process.");
                }
            }
            finally
            {
                gate.Release();
            }

            var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "select pg_try_advisory_lock(hashtextextended(@lock_scope, 0));";
            command.Parameters.AddWithValue("lock_scope", lockScope);
            var acquired = (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);

            if (acquired)
            {
                await gate.WaitAsync(cancellationToken);
                try
                {
                    heldConnections.Add(lockScope, connection);
                }
                catch
                {
                    await ReleaseConnectionLockAsync(connection, lockScope, cancellationToken);
                    await connection.DisposeAsync();
                    throw;
                }
                finally
                {
                    gate.Release();
                }

                return new OutcomeRuntimeLockLease(lockScope, Acquired: true, FailureReason: null);
            }

            await connection.DisposeAsync();
            await Task.Delay(TimeSpan.FromMilliseconds(50), cancellationToken);
        }

        return new OutcomeRuntimeLockLease(lockScope, Acquired: false, "Outcome runtime advisory lock acquisition timed out.");
    }

    public async Task ReleaseAsync(
        OutcomeRuntimeLockLease lease,
        CancellationToken cancellationToken)
    {
        if (!lease.Acquired)
        {
            return;
        }

        NpgsqlConnection? connection;
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (!heldConnections.Remove(lease.LockScope, out connection))
            {
                return;
            }
        }
        finally
        {
            gate.Release();
        }

        await ReleaseConnectionLockAsync(connection, lease.LockScope, cancellationToken);
        await connection.DisposeAsync();
    }

    public async Task<OutcomeRuntimeLockingReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        try
        {
            await using var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "select game_engine.try_outcome_runtime_advisory_lock(@lock_scope);";
            command.Parameters.AddWithValue("lock_scope", $"readiness:{Guid.NewGuid():N}");
            var reachable = (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);
            if (!reachable)
            {
                blockers.Add("Postgres advisory lock helper did not acquire a readiness lock.");
            }
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            blockers.Add(error.Message);
        }

        return new OutcomeRuntimeLockingReadiness(
            AdvisoryLockingConfigured: true,
            AdvisoryLockingReachable: blockers.Count == 0,
            RedisLockDependencyAbsent: true,
            Blockers: blockers);
    }

    public async ValueTask DisposeAsync()
    {
        await gate.WaitAsync();
        try
        {
            foreach (var item in heldConnections)
            {
                await ReleaseConnectionLockAsync(item.Value, item.Key, CancellationToken.None);
                await item.Value.DisposeAsync();
            }

            heldConnections.Clear();
        }
        finally
        {
            gate.Release();
            gate.Dispose();
        }
    }

    private static async Task ReleaseConnectionLockAsync(
        NpgsqlConnection connection,
        string lockScope,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "select pg_advisory_unlock(hashtextextended(@lock_scope, 0));";
        command.Parameters.AddWithValue("lock_scope", lockScope);
        await command.ExecuteScalarAsync(cancellationToken);
    }
}

internal static class OutcomeRuntimeLockScope
{
    public static string ForStoredRequest(OutcomeRuntimeStoredRequest request)
    {
        return $"outcome-runtime:{request.ProviderId}:{request.ProviderVersion}:{request.DrawRequestScope}";
    }
}
