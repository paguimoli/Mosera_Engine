using System.Text.Json;
using GameEngine.Application.Services;
using Npgsql;
using NpgsqlTypes;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresMathEvaluationBatchRepository(string connectionString) : IMathEvaluationBatchRepository
{
    public async Task<MathEvaluationBatchClaim> ClaimBatchAsync(MathEvaluationBatchRecord batch, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var existing = await FindBatchByIdempotencyKeyAsync(connection, batch.BatchIdempotencyKey, cancellationToken);
        if (existing is not null)
        {
            if (existing.CanonicalBatchRequestHash != batch.CanonicalBatchRequestHash)
            {
                throw new InvalidOperationException("Conflicting payload for the same Math Evaluation batch idempotency key.");
            }

            await transaction.CommitAsync(cancellationToken);
            return new MathEvaluationBatchClaim(existing, Created: false, Duplicate: true);
        }

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.math_evaluation_batches (
  batch_id, batch_idempotency_key, canonical_batch_request_hash,
  outcome_certificate_id, outcome_certificate_hash,
  game_manifest_id, game_manifest_version, game_manifest_hash,
  math_model_id, math_model_version, math_model_hash,
  paytable_id, paytable_version, paytable_hash,
  evaluator_type, evaluator_version, expected_item_count,
  completed_item_count, failed_item_count, status, created_at, started_at,
  provenance_metadata
) values (
  @batch_id, @batch_idempotency_key, @canonical_batch_request_hash,
  @outcome_certificate_id, @outcome_certificate_hash,
  @game_manifest_id, @game_manifest_version, @game_manifest_hash,
  @math_model_id, @math_model_version, @math_model_hash,
  @paytable_id, @paytable_version, @paytable_hash,
  @evaluator_type, @evaluator_version, @expected_item_count,
  0, 0, 'Running', @created_at, @started_at, @provenance_metadata
)
on conflict (batch_idempotency_key) do nothing;
""";
        AddBatchParameters(command, batch);
        command.Parameters.AddWithValue("started_at", DateTimeOffset.UtcNow);
        var inserted = await command.ExecuteNonQueryAsync(cancellationToken);
        var claimed = inserted == 1
            ? batch with { Status = MathEvaluationBatchStatus.Running, StartedAt = DateTimeOffset.UtcNow }
            : await FindBatchByIdempotencyKeyAsync(connection, batch.BatchIdempotencyKey, cancellationToken);

        if (claimed is null)
        {
            throw new InvalidOperationException("Math Evaluation batch claim could not be read back deterministically.");
        }

        await transaction.CommitAsync(cancellationToken);
        return new MathEvaluationBatchClaim(claimed, Created: inserted == 1, Duplicate: inserted != 1);
    }

    public async Task<MathEvaluationBatchItemClaim> ClaimItemAsync(MathEvaluationBatchItemRecord item, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var existing = await FindItemByIdempotencyKeyAsync(connection, item.ItemIdempotencyKey, cancellationToken);
        if (existing is not null)
        {
            if (existing.CanonicalWagerPayloadHash != item.CanonicalWagerPayloadHash)
            {
                throw new InvalidOperationException("Conflicting payload for the same Math Evaluation batch item idempotency key.");
            }

            await transaction.CommitAsync(cancellationToken);
            return new MathEvaluationBatchItemClaim(existing, Created: false, Duplicate: true);
        }

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.math_evaluation_batch_items (
  batch_item_id, batch_id, ticket_reference, item_idempotency_key,
  canonical_wager_payload_hash, evaluation_status, created_at
) values (
  @batch_item_id, @batch_id, @ticket_reference, @item_idempotency_key,
  @canonical_wager_payload_hash, 'Running', @created_at
)
on conflict (item_idempotency_key) do nothing;
""";
        command.Parameters.AddWithValue("batch_item_id", item.BatchItemId);
        command.Parameters.AddWithValue("batch_id", item.BatchId);
        command.Parameters.AddWithValue("ticket_reference", item.TicketReference);
        command.Parameters.AddWithValue("item_idempotency_key", item.ItemIdempotencyKey);
        command.Parameters.AddWithValue("canonical_wager_payload_hash", item.CanonicalWagerPayloadHash);
        command.Parameters.AddWithValue("created_at", item.CreatedAt);
        var inserted = await command.ExecuteNonQueryAsync(cancellationToken);
        var claimed = inserted == 1
            ? item with { EvaluationStatus = MathEvaluationBatchItemStatus.Running }
            : await FindItemByIdempotencyKeyAsync(connection, item.ItemIdempotencyKey, cancellationToken);
        if (claimed is null)
        {
            throw new InvalidOperationException("Math Evaluation batch item claim could not be read back deterministically.");
        }

        await transaction.CommitAsync(cancellationToken);
        return new MathEvaluationBatchItemClaim(claimed, Created: inserted == 1, Duplicate: inserted != 1);
    }

    public async Task AppendAttemptAsync(
        Guid batchId,
        Guid? batchItemId,
        MathEvaluationBatchAttemptStatus status,
        string? failureCode,
        string? failureReason,
        string canonicalAttemptHash,
        DateTimeOffset completedAt,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var attemptNumber = await NextAttemptNumberAsync(connection, batchId, batchItemId, cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.math_evaluation_batch_attempts (
  batch_attempt_id, batch_id, batch_item_id, attempt_number, status,
  failure_code, failure_reason, canonical_attempt_hash, completed_at
) values (
  @batch_attempt_id, @batch_id, @batch_item_id, @attempt_number, @status,
  @failure_code, @failure_reason, @canonical_attempt_hash, @completed_at
);
""";
        command.Parameters.AddWithValue("batch_attempt_id", Guid.NewGuid());
        command.Parameters.AddWithValue("batch_id", batchId);
        command.Parameters.AddWithValue("batch_item_id", batchItemId is null ? DBNull.Value : batchItemId.Value);
        command.Parameters.AddWithValue("attempt_number", attemptNumber);
        command.Parameters.AddWithValue("status", status.ToString());
        command.Parameters.AddWithValue("failure_code", failureCode is null ? DBNull.Value : failureCode);
        command.Parameters.AddWithValue("failure_reason", failureReason is null ? DBNull.Value : failureReason);
        command.Parameters.AddWithValue("canonical_attempt_hash", canonicalAttemptHash);
        command.Parameters.AddWithValue("completed_at", completedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);

        if (batchItemId is not null)
        {
            await using var update = connection.CreateCommand();
            update.CommandText = """
update game_engine.math_evaluation_batch_items
set attempt_count = attempt_count + 1
where batch_item_id = @batch_item_id;
""";
            update.Parameters.AddWithValue("batch_item_id", batchItemId.Value);
            await update.ExecuteNonQueryAsync(cancellationToken);
        }
    }

    public async Task CompleteItemAsync(Guid batchItemId, Guid evaluationRequestId, Guid certificateId, string certificateHash, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
update game_engine.math_evaluation_batch_items
set evaluation_request_id = @evaluation_request_id,
    evaluation_status = 'Completed',
    certificate_id = @certificate_id,
    certificate_hash = @certificate_hash,
    failure_code = null,
    failure_reason = null,
    completed_at = @completed_at
where batch_item_id = @batch_item_id;
""";
        command.Parameters.AddWithValue("evaluation_request_id", evaluationRequestId);
        command.Parameters.AddWithValue("certificate_id", certificateId);
        command.Parameters.AddWithValue("certificate_hash", certificateHash);
        command.Parameters.AddWithValue("completed_at", DateTimeOffset.UtcNow);
        command.Parameters.AddWithValue("batch_item_id", batchItemId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task FailItemAsync(Guid batchItemId, string failureCode, string failureReason, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
update game_engine.math_evaluation_batch_items
set evaluation_status = 'Failed',
    failure_code = @failure_code,
    failure_reason = @failure_reason
where batch_item_id = @batch_item_id
  and evaluation_status <> 'Completed';
""";
        command.Parameters.AddWithValue("failure_code", failureCode);
        command.Parameters.AddWithValue("failure_reason", failureReason);
        command.Parameters.AddWithValue("batch_item_id", batchItemId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task CancelPendingItemsAsync(Guid batchId, string reasonCode, string reason, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
update game_engine.math_evaluation_batch_items
set evaluation_status = 'Cancelled',
    failure_code = @failure_code,
    failure_reason = @failure_reason
where batch_id = @batch_id
  and evaluation_status in ('Pending', 'Running', 'Failed');
""";
        command.Parameters.AddWithValue("batch_id", batchId);
        command.Parameters.AddWithValue("failure_code", reasonCode);
        command.Parameters.AddWithValue("failure_reason", reason);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<MathEvaluationBatchRecord> RecalculateBatchStatusAsync(Guid batchId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var items = await ListItemsAsync(connection, batchId, cancellationToken);
        var batch = await FindBatchAsync(connection, batchId, cancellationToken)
            ?? throw new InvalidOperationException("Math Evaluation batch was not found.");
        var completed = items.Count(item => item.EvaluationStatus == MathEvaluationBatchItemStatus.Completed);
        var failed = items.Count(item => item.EvaluationStatus == MathEvaluationBatchItemStatus.Failed);
        var cancelled = items.Count(item => item.EvaluationStatus == MathEvaluationBatchItemStatus.Cancelled);
        var status = completed == batch.ExpectedItemCount
            ? MathEvaluationBatchStatus.Completed
            : cancelled > 0
                ? MathEvaluationBatchStatus.Cancelled
                : completed > 0 || failed > 0
                    ? MathEvaluationBatchStatus.PartiallyCompleted
                    : MathEvaluationBatchStatus.Running;
        var failureCode = failed > 0 ? "MATH_BATCH_ITEM_FAILURE" : cancelled > 0 ? "MATH_BATCH_CANCELLED" : null;
        var failureReason = failed > 0 ? "One or more Math Evaluation batch items failed." : cancelled > 0 ? "Math Evaluation batch was cancelled." : null;

        await using var command = connection.CreateCommand();
        command.CommandText = """
update game_engine.math_evaluation_batches
set completed_item_count = @completed_item_count,
    failed_item_count = @failed_item_count,
    status = @status,
    completed_at = @completed_at,
    failure_code = @failure_code,
    failure_reason = @failure_reason
where batch_id = @batch_id;
""";
        command.Parameters.AddWithValue("completed_item_count", completed);
        command.Parameters.AddWithValue("failed_item_count", failed);
        command.Parameters.AddWithValue("status", status.ToString());
        command.Parameters.AddWithValue("completed_at", status is MathEvaluationBatchStatus.Completed or MathEvaluationBatchStatus.Cancelled
            ? DateTimeOffset.UtcNow
            : DBNull.Value);
        command.Parameters.AddWithValue("failure_code", failureCode is null ? DBNull.Value : failureCode);
        command.Parameters.AddWithValue("failure_reason", failureReason is null ? DBNull.Value : failureReason);
        command.Parameters.AddWithValue("batch_id", batchId);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return (await FindBatchAsync(connection, batchId, cancellationToken))!;
    }

    public async Task<MathEvaluationBatchRecord?> FindBatchByIdempotencyKeyAsync(string batchIdempotencyKey, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await FindBatchByIdempotencyKeyAsync(connection, batchIdempotencyKey, cancellationToken);
    }

    public async Task<MathEvaluationBatchRecord?> FindBatchAsync(Guid batchId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await FindBatchAsync(connection, batchId, cancellationToken);
    }

    public async Task<IReadOnlyCollection<MathEvaluationBatchItemRecord>> ListItemsAsync(Guid batchId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await ListItemsAsync(connection, batchId, cancellationToken);
    }

    public async Task<MathEvaluationBatchReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('game_engine.math_evaluation_batches') is not null,
  to_regclass('game_engine.math_evaluation_batch_items') is not null,
  to_regclass('game_engine.math_evaluation_batch_attempts') is not null;
""";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            await reader.ReadAsync(cancellationToken);
            if (!reader.GetBoolean(0)) blockers.Add("game_engine.math_evaluation_batches is missing.");
            if (!reader.GetBoolean(1)) blockers.Add("game_engine.math_evaluation_batch_items is missing.");
            if (!reader.GetBoolean(2)) blockers.Add("game_engine.math_evaluation_batch_attempts is missing.");
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            blockers.Add(error.Message);
        }

        return new MathEvaluationBatchReadiness(
            BatchRepositoryConfigured: true,
            BatchPersistenceReachable: blockers.Count == 0,
            BatchRecoveryReady: blockers.Count == 0,
            ItemIdempotencyReady: blockers.Count == 0,
            BoundedParallelExecutionReady: true,
            ProductionActivationDisabled: true,
            Blockers: blockers);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static async Task<MathEvaluationBatchRecord?> FindBatchByIdempotencyKeyAsync(NpgsqlConnection connection, string key, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"{BatchSelectSql} where batch_idempotency_key = @key limit 1;";
        command.Parameters.AddWithValue("key", key);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapBatch(reader) : null;
    }

    private static async Task<MathEvaluationBatchRecord?> FindBatchAsync(NpgsqlConnection connection, Guid batchId, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"{BatchSelectSql} where batch_id = @batch_id limit 1;";
        command.Parameters.AddWithValue("batch_id", batchId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapBatch(reader) : null;
    }

    private static async Task<MathEvaluationBatchItemRecord?> FindItemByIdempotencyKeyAsync(NpgsqlConnection connection, string key, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"{ItemSelectSql} where item_idempotency_key = @key limit 1;";
        command.Parameters.AddWithValue("key", key);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapItem(reader) : null;
    }

    private static async Task<IReadOnlyCollection<MathEvaluationBatchItemRecord>> ListItemsAsync(NpgsqlConnection connection, Guid batchId, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"{ItemSelectSql} where batch_id = @batch_id order by ticket_reference, item_idempotency_key;";
        command.Parameters.AddWithValue("batch_id", batchId);
        var items = new List<MathEvaluationBatchItemRecord>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            items.Add(MapItem(reader));
        }

        return items;
    }

    private static async Task<int> NextAttemptNumberAsync(NpgsqlConnection connection, Guid batchId, Guid? batchItemId, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select coalesce(max(attempt_number), 0) + 1
from game_engine.math_evaluation_batch_attempts
where batch_id = @batch_id
  and ((@batch_item_id::uuid is null and batch_item_id is null) or batch_item_id = @batch_item_id::uuid);
""";
        command.Parameters.AddWithValue("batch_id", batchId);
        command.Parameters.AddWithValue("batch_item_id", batchItemId is null ? DBNull.Value : batchItemId.Value);
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken));
    }

    private static void AddBatchParameters(NpgsqlCommand command, MathEvaluationBatchRecord batch)
    {
        command.Parameters.AddWithValue("batch_id", batch.BatchId);
        command.Parameters.AddWithValue("batch_idempotency_key", batch.BatchIdempotencyKey);
        command.Parameters.AddWithValue("canonical_batch_request_hash", batch.CanonicalBatchRequestHash);
        command.Parameters.AddWithValue("outcome_certificate_id", batch.OutcomeCertificateId);
        command.Parameters.AddWithValue("outcome_certificate_hash", batch.OutcomeCertificateHash);
        command.Parameters.AddWithValue("game_manifest_id", batch.GameManifestId);
        command.Parameters.AddWithValue("game_manifest_version", batch.GameManifestVersion);
        command.Parameters.AddWithValue("game_manifest_hash", batch.GameManifestHash);
        command.Parameters.AddWithValue("math_model_id", batch.MathModelId);
        command.Parameters.AddWithValue("math_model_version", batch.MathModelVersion);
        command.Parameters.AddWithValue("math_model_hash", batch.MathModelHash);
        command.Parameters.AddWithValue("paytable_id", batch.PaytableId);
        command.Parameters.AddWithValue("paytable_version", batch.PaytableVersion);
        command.Parameters.AddWithValue("paytable_hash", batch.PaytableHash);
        command.Parameters.AddWithValue("evaluator_type", batch.EvaluatorType);
        command.Parameters.AddWithValue("evaluator_version", batch.EvaluatorVersion);
        command.Parameters.AddWithValue("expected_item_count", batch.ExpectedItemCount);
        command.Parameters.AddWithValue("created_at", batch.CreatedAt);
        command.Parameters.AddWithValue("provenance_metadata", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(batch.ProvenanceMetadata));
    }

    private static MathEvaluationBatchRecord MapBatch(NpgsqlDataReader reader)
    {
        return new MathEvaluationBatchRecord(
            reader.GetGuid(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetGuid(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetString(6),
            reader.GetString(7),
            reader.GetString(8),
            reader.GetString(9),
            reader.GetString(10),
            reader.GetString(11),
            reader.GetString(12),
            reader.GetString(13),
            reader.GetString(14),
            reader.GetString(15),
            reader.GetInt32(16),
            reader.GetInt32(17),
            reader.GetInt32(18),
            Enum.Parse<MathEvaluationBatchStatus>(reader.GetString(19)),
            reader.GetFieldValue<DateTimeOffset>(20),
            reader.IsDBNull(21) ? null : reader.GetFieldValue<DateTimeOffset>(21),
            reader.IsDBNull(22) ? null : reader.GetFieldValue<DateTimeOffset>(22),
            reader.IsDBNull(23) ? null : reader.GetString(23),
            reader.IsDBNull(24) ? null : reader.GetString(24),
            JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(25)) ?? []);
    }

    private static MathEvaluationBatchItemRecord MapItem(NpgsqlDataReader reader)
    {
        return new MathEvaluationBatchItemRecord(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.IsDBNull(5) ? null : reader.GetGuid(5),
            Enum.Parse<MathEvaluationBatchItemStatus>(reader.GetString(6)),
            reader.IsDBNull(7) ? null : reader.GetGuid(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.GetInt32(9),
            reader.IsDBNull(10) ? null : reader.GetString(10),
            reader.IsDBNull(11) ? null : reader.GetString(11),
            reader.GetFieldValue<DateTimeOffset>(12),
            reader.IsDBNull(13) ? null : reader.GetFieldValue<DateTimeOffset>(13));
    }

    private const string BatchSelectSql = """
select batch_id, batch_idempotency_key, canonical_batch_request_hash,
       outcome_certificate_id, outcome_certificate_hash,
       game_manifest_id, game_manifest_version, game_manifest_hash,
       math_model_id, math_model_version, math_model_hash,
       paytable_id, paytable_version, paytable_hash,
       evaluator_type, evaluator_version, expected_item_count,
       completed_item_count, failed_item_count, status, created_at,
       started_at, completed_at, failure_code, failure_reason,
       provenance_metadata::text
from game_engine.math_evaluation_batches
""";

    private const string ItemSelectSql = """
select batch_item_id, batch_id, ticket_reference, item_idempotency_key,
       canonical_wager_payload_hash, evaluation_request_id, evaluation_status,
       certificate_id, certificate_hash, attempt_count, failure_code, failure_reason,
       created_at, completed_at
from game_engine.math_evaluation_batch_items
""";
}
