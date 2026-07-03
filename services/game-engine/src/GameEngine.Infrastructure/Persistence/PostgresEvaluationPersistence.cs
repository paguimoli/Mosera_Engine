using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;
using NpgsqlTypes;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresEvaluationRunRepository(string connectionString) : IEvaluationRunRepository
{
    public IReadOnlyCollection<EvaluationRunDefinition> GetRuns()
    {
        return QueryMany(string.Empty);
    }

    public EvaluationRunDefinition? GetRun(Guid runId)
    {
        return QueryMany("where id = @value", command => command.Parameters.AddWithValue("value", runId)).FirstOrDefault();
    }

    public EvaluationRunDefinition UpsertRun(EvaluationRunDefinition run)
    {
        using var connection = OpenConnection();
        PostgresEvaluationStorageSupport.EnsureReferenceGraph(connection, run);

        using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.evaluation_runs (
  id,
  draw_id,
  game_binding_id,
  official_certified_draw_result_id,
  game_module_id,
  game_module_version,
  evaluation_version,
  status,
  batch_size,
  eligible_ticket_count,
  planned_batch_count,
  preconditions,
  created_at,
  started_at,
  completed_at
) values (
  @id,
  @draw_id,
  @game_binding_id,
  @official_certified_draw_result_id,
  @game_module_id,
  @game_module_version,
  @evaluation_version,
  @status,
  @batch_size,
  @eligible_ticket_count,
  @planned_batch_count,
  @preconditions,
  @created_at,
  @started_at,
  @completed_at
)
on conflict (id) do update set
  status = excluded.status,
  batch_size = excluded.batch_size,
  eligible_ticket_count = excluded.eligible_ticket_count,
  planned_batch_count = excluded.planned_batch_count,
  preconditions = excluded.preconditions,
  started_at = coalesce(excluded.started_at, game_engine.evaluation_runs.started_at),
  completed_at = excluded.completed_at;
""";
        AddRunParameters(command, run);
        command.ExecuteNonQuery();
        return GetRun(run.Id) ?? run;
    }

    private IReadOnlyCollection<EvaluationRunDefinition> QueryMany(string whereClause, Action<NpgsqlCommand>? configure = null)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = $"""
select
  id,
  draw_id,
  game_binding_id,
  official_certified_draw_result_id,
  game_module_id,
  game_module_version,
  evaluation_version,
  status,
  batch_size,
  eligible_ticket_count,
  planned_batch_count,
  preconditions::text,
  created_at,
  started_at,
  completed_at
from game_engine.evaluation_runs
{whereClause}
order by created_at, id;
""";
        configure?.Invoke(command);

        using var reader = command.ExecuteReader();
        var runs = new List<EvaluationRunDefinition>();
        while (reader.Read())
        {
            runs.Add(new EvaluationRunDefinition(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetGuid(2),
                reader.GetGuid(3),
                reader.GetString(4),
                reader.GetString(5),
                reader.GetString(6),
                Enum.Parse<EvaluationRunStatus>(reader.GetString(7), ignoreCase: true),
                reader.GetInt32(8),
                reader.GetInt32(9),
                reader.GetInt32(10),
                reader.GetFieldValue<DateTimeOffset>(12),
                reader.IsDBNull(13) ? null : reader.GetFieldValue<DateTimeOffset>(13),
                reader.IsDBNull(14) ? null : reader.GetFieldValue<DateTimeOffset>(14),
                JsonSerializer.Deserialize<string[]>(reader.GetString(11)) ?? []));
        }

        return runs;
    }

    private NpgsqlConnection OpenConnection()
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        connection.Open();
        return connection;
    }

    private static void AddRunParameters(NpgsqlCommand command, EvaluationRunDefinition run)
    {
        command.Parameters.AddWithValue("id", run.Id);
        command.Parameters.AddWithValue("draw_id", run.DrawId);
        command.Parameters.AddWithValue("game_binding_id", run.GameBindingId);
        command.Parameters.AddWithValue("official_certified_draw_result_id", run.OfficialCertifiedResultId);
        command.Parameters.AddWithValue("game_module_id", run.GameModuleId);
        command.Parameters.AddWithValue("game_module_version", run.GameModuleVersion);
        command.Parameters.AddWithValue("evaluation_version", run.EvaluationVersion);
        command.Parameters.AddWithValue("status", run.Status.ToString());
        command.Parameters.AddWithValue("batch_size", run.BatchSize);
        command.Parameters.AddWithValue("eligible_ticket_count", run.EligibleTicketCount);
        command.Parameters.AddWithValue("planned_batch_count", run.PlannedBatchCount);
        command.Parameters.AddWithValue("preconditions", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(run.Preconditions));
        command.Parameters.AddWithValue("created_at", run.CreatedAt);
        command.Parameters.AddWithValue("started_at", run.StartedAt is null ? DBNull.Value : run.StartedAt.Value);
        command.Parameters.AddWithValue("completed_at", run.CompletedAt is null ? DBNull.Value : run.CompletedAt.Value);
    }
}

public sealed class PostgresEvaluationBatchRepository(string connectionString) : IEvaluationBatchRepository
{
    public IReadOnlyCollection<EvaluationBatchDefinition> GetBatches(Guid runId)
    {
        return QueryMany("where evaluation_run_id = @value", command => command.Parameters.AddWithValue("value", runId));
    }

    public EvaluationBatchDefinition? GetBatch(Guid batchId)
    {
        return QueryMany("where id = @value", command => command.Parameters.AddWithValue("value", batchId)).FirstOrDefault();
    }

    public EvaluationBatchDefinition UpsertBatch(EvaluationRunDefinition run, EvaluationBatchDefinition batch)
    {
        using var connection = OpenConnection();
        PostgresEvaluationStorageSupport.EnsureReferenceGraph(connection, run);

        using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.evaluation_batches (
  id,
  evaluation_run_id,
  sequence,
  start_inclusive,
  end_exclusive,
  status,
  checkpoint_cursor,
  retry_count,
  created_at,
  claimed_at,
  completed_at
) values (
  @id,
  @evaluation_run_id,
  @sequence,
  @start_inclusive,
  @end_exclusive,
  @status,
  @checkpoint_cursor,
  @retry_count,
  @created_at,
  @claimed_at,
  @completed_at
)
on conflict (evaluation_run_id, sequence) do update set
  id = excluded.id,
  start_inclusive = excluded.start_inclusive,
  end_exclusive = excluded.end_exclusive,
  status = excluded.status,
  checkpoint_cursor = excluded.checkpoint_cursor,
  retry_count = excluded.retry_count,
  claimed_at = coalesce(excluded.claimed_at, game_engine.evaluation_batches.claimed_at),
  completed_at = excluded.completed_at;
""";
        AddBatchParameters(command, batch);
        command.ExecuteNonQuery();
        return GetBatch(batch.Id) ?? batch;
    }

    private IReadOnlyCollection<EvaluationBatchDefinition> QueryMany(string whereClause, Action<NpgsqlCommand>? configure = null)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = $"""
select
  id,
  evaluation_run_id,
  sequence,
  start_inclusive,
  end_exclusive,
  status,
  checkpoint_cursor,
  retry_count,
  created_at,
  claimed_at,
  completed_at
from game_engine.evaluation_batches
{whereClause}
order by evaluation_run_id, sequence, id;
""";
        configure?.Invoke(command);

        using var reader = command.ExecuteReader();
        var batches = new List<EvaluationBatchDefinition>();
        while (reader.Read())
        {
            batches.Add(new EvaluationBatchDefinition(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetInt32(2),
                reader.GetInt32(3),
                reader.GetInt32(4),
                Enum.Parse<EvaluationBatchStatus>(reader.GetString(5), ignoreCase: true),
                reader.GetString(6),
                reader.GetInt32(7),
                reader.GetFieldValue<DateTimeOffset>(8),
                reader.IsDBNull(9) ? null : reader.GetFieldValue<DateTimeOffset>(9),
                reader.IsDBNull(10) ? null : reader.GetFieldValue<DateTimeOffset>(10)));
        }

        return batches;
    }

    private NpgsqlConnection OpenConnection()
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        connection.Open();
        return connection;
    }

    private static void AddBatchParameters(NpgsqlCommand command, EvaluationBatchDefinition batch)
    {
        command.Parameters.AddWithValue("id", batch.Id);
        command.Parameters.AddWithValue("evaluation_run_id", batch.EvaluationRunId);
        command.Parameters.AddWithValue("sequence", batch.Sequence);
        command.Parameters.AddWithValue("start_inclusive", batch.StartInclusive);
        command.Parameters.AddWithValue("end_exclusive", batch.EndExclusive);
        command.Parameters.AddWithValue("status", batch.Status.ToString());
        command.Parameters.AddWithValue("checkpoint_cursor", batch.CheckpointCursor);
        command.Parameters.AddWithValue("retry_count", batch.RetryCount);
        command.Parameters.AddWithValue("created_at", batch.CreatedAt);
        command.Parameters.AddWithValue("claimed_at", batch.ClaimedAt is null ? DBNull.Value : batch.ClaimedAt.Value);
        command.Parameters.AddWithValue("completed_at", batch.CompletedAt is null ? DBNull.Value : batch.CompletedAt.Value);
    }
}

public sealed class PostgresEvaluationRecordRepository(string connectionString) : IEvaluationRecordRepository
{
    public EvaluationRecordPersistenceResult InsertEvaluationRecord(ImmutableEvaluationRecord record)
    {
        using var connection = OpenConnection();
        PostgresEvaluationStorageSupport.EnsureGraph(connection, record);

        using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.evaluation_records (
  id,
  idempotency_key,
  evaluation_run_id,
  evaluation_batch_id,
  ticket_id,
  draw_id,
  game_id,
  game_module_id,
  game_module_version,
  evaluator_version,
  paytable_version,
  outcome,
  reason_code,
  currency,
  stake_amount,
  payout_amount,
  net_amount,
  evaluation_metadata,
  evaluated_at,
  settlement_consumed_at,
  settlement_consumed_by,
  settlement_consumer_status,
  settlement_consumer_correlation_id
) values (
  @id,
  @idempotency_key,
  @evaluation_run_id,
  @evaluation_batch_id,
  @ticket_id,
  @draw_id,
  @game_id,
  @game_module_id,
  @game_module_version,
  @evaluator_version,
  @paytable_version,
  @outcome,
  @reason_code,
  @currency,
  @stake_amount,
  @payout_amount,
  @net_amount,
  @evaluation_metadata,
  @evaluated_at,
  @settlement_consumed_at,
  @settlement_consumed_by,
  @settlement_consumer_status,
  @settlement_consumer_correlation_id
)
on conflict (idempotency_key) do nothing;
""";
        AddRecordParameters(command, record);
        var created = command.ExecuteNonQuery() == 1;
        var persisted = FindByIdempotencyKey(record.IdempotencyKey)
            ?? throw new InvalidOperationException("Evaluation record insert completed but the persisted record could not be read.");
        return new EvaluationRecordPersistenceResult(
            created ? EvaluationDuplicateStatus.Created : EvaluationDuplicateStatus.DuplicateReturnedExisting,
            persisted,
            created);
    }

    public ImmutableEvaluationRecord? FindById(Guid id)
    {
        return QueryOne("where id = @value", command => command.Parameters.AddWithValue("value", id));
    }

    public ImmutableEvaluationRecord? FindByIdempotencyKey(string idempotencyKey)
    {
        return QueryOne("where idempotency_key = @value", command => command.Parameters.AddWithValue("value", idempotencyKey));
    }

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetAll()
    {
        return QueryMany(string.Empty);
    }

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByRun(Guid runId)
    {
        return QueryMany("where evaluation_run_id = @value", command => command.Parameters.AddWithValue("value", runId));
    }

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByDraw(Guid drawId)
    {
        return QueryMany("where draw_id = @value", command => command.Parameters.AddWithValue("value", drawId));
    }

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByTicket(Guid ticketId)
    {
        return QueryMany("where ticket_id = @value", command => command.Parameters.AddWithValue("value", ticketId));
    }

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByBatch(Guid batchId)
    {
        return QueryMany("where evaluation_batch_id = @value", command => command.Parameters.AddWithValue("value", batchId));
    }

    private ImmutableEvaluationRecord? QueryOne(string whereClause, Action<NpgsqlCommand> configure)
    {
        return QueryMany(whereClause, configure).FirstOrDefault();
    }

    private IReadOnlyCollection<ImmutableEvaluationRecord> QueryMany(string whereClause, Action<NpgsqlCommand>? configure = null)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = $"""
select
  id,
  idempotency_key,
  evaluation_run_id,
  evaluation_batch_id,
  ticket_id,
  draw_id,
  game_id,
  game_module_id,
  game_module_version,
  evaluator_version,
  paytable_version,
  outcome,
  reason_code,
  currency,
  stake_amount,
  payout_amount,
  net_amount,
  evaluation_metadata::text,
  evaluated_at,
  settlement_consumed_at,
  settlement_consumed_by,
  settlement_consumer_status,
  settlement_consumer_correlation_id
from game_engine.evaluation_records
{whereClause}
order by evaluated_at, id;
""";
        configure?.Invoke(command);

        using var reader = command.ExecuteReader();
        var records = new List<ImmutableEvaluationRecord>();
        while (reader.Read())
        {
            records.Add(MapRecord(reader));
        }

        return records;
    }

    private NpgsqlConnection OpenConnection()
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        connection.Open();
        return connection;
    }

    private static void AddRecordParameters(NpgsqlCommand command, ImmutableEvaluationRecord record)
    {
        var metadata = new Dictionary<string, object?>(record.EvaluationMetadata, StringComparer.OrdinalIgnoreCase);
        var consumerStatus = ReadConsumerStatus(metadata);
        var consumedAt = ReadDateTimeOffset(metadata, "settlementConsumedAt");
        var consumedBy = ReadString(metadata, "settlementConsumedBy");
        var consumerCorrelationId = ReadGuid(metadata, "settlementConsumerCorrelationId");

        command.Parameters.AddWithValue("id", record.Id);
        command.Parameters.AddWithValue("idempotency_key", record.IdempotencyKey);
        command.Parameters.AddWithValue("evaluation_run_id", record.RunId);
        command.Parameters.AddWithValue("evaluation_batch_id", record.BatchId);
        command.Parameters.AddWithValue("ticket_id", record.TicketId);
        command.Parameters.AddWithValue("draw_id", record.DrawId);
        command.Parameters.AddWithValue("game_id", record.GameId);
        command.Parameters.AddWithValue("game_module_id", record.ModuleId);
        command.Parameters.AddWithValue("game_module_version", record.ModuleVersion);
        command.Parameters.AddWithValue("evaluator_version", record.EvaluatorVersion);
        command.Parameters.AddWithValue("paytable_version", record.PaytableVersion);
        command.Parameters.AddWithValue("outcome", record.Outcome.ToString());
        command.Parameters.AddWithValue("reason_code", record.ReasonCode.ToString());
        command.Parameters.AddWithValue("currency", record.Amount.Currency);
        command.Parameters.AddWithValue("stake_amount", record.Amount.StakeAmount);
        command.Parameters.AddWithValue("payout_amount", record.Amount.PayoutAmount);
        command.Parameters.AddWithValue("net_amount", record.Amount.NetAmount);
        command.Parameters.AddWithValue("evaluation_metadata", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(metadata));
        command.Parameters.AddWithValue("evaluated_at", record.EvaluatedAt);
        command.Parameters.AddWithValue("settlement_consumed_at", consumedAt is null ? DBNull.Value : consumedAt.Value);
        command.Parameters.AddWithValue("settlement_consumed_by", string.IsNullOrWhiteSpace(consumedBy) ? DBNull.Value : consumedBy);
        command.Parameters.AddWithValue("settlement_consumer_status", ToDbConsumerStatus(consumerStatus));
        command.Parameters.AddWithValue("settlement_consumer_correlation_id", consumerCorrelationId is null ? DBNull.Value : consumerCorrelationId.Value);
    }

    private static ImmutableEvaluationRecord MapRecord(NpgsqlDataReader reader)
    {
        var metadata = ReadMetadata(reader.GetString(17));
        var consumerStatus = FromDbConsumerStatus(reader.GetString(21));
        metadata["settlementConsumerStatus"] = consumerStatus.ToString();
        if (!reader.IsDBNull(19)) metadata["settlementConsumedAt"] = reader.GetFieldValue<DateTimeOffset>(19).ToString("O");
        if (!reader.IsDBNull(20)) metadata["settlementConsumedBy"] = reader.GetString(20);
        if (!reader.IsDBNull(22)) metadata["settlementConsumerCorrelationId"] = reader.GetGuid(22).ToString("D");

        return new ImmutableEvaluationRecord(
            reader.GetGuid(0),
            reader.GetString(1),
            reader.GetGuid(2),
            reader.GetGuid(3),
            reader.GetGuid(4),
            reader.GetGuid(5),
            reader.GetGuid(6),
            reader.GetString(7),
            reader.GetString(8),
            reader.GetString(9),
            reader.GetString(10),
            Enum.Parse<GameEvaluationOutcome>(reader.GetString(11), ignoreCase: true),
            Enum.Parse<GameEvaluationReason>(reader.GetString(12), ignoreCase: true),
            new GameEvaluationAmount(
                reader.GetString(13),
                reader.GetDecimal(14),
                reader.GetDecimal(15),
                reader.GetDecimal(16)),
            metadata,
            reader.GetFieldValue<DateTimeOffset>(18));
    }

    private static Dictionary<string, object?> ReadMetadata(string json)
    {
        return JsonSerializer.Deserialize<Dictionary<string, object?>>(json) ?? new Dictionary<string, object?>();
    }

    private static SettlementEvaluationConsumerStatus ReadConsumerStatus(IReadOnlyDictionary<string, object?> metadata)
    {
        return Enum.TryParse<SettlementEvaluationConsumerStatus>(ReadString(metadata, "settlementConsumerStatus"), ignoreCase: true, out var status)
            ? status
            : SettlementEvaluationConsumerStatus.NotConsumed;
    }

    private static string ToDbConsumerStatus(SettlementEvaluationConsumerStatus status)
    {
        return status switch
        {
            SettlementEvaluationConsumerStatus.NotConsumed => "NOT_CONSUMED",
            SettlementEvaluationConsumerStatus.Ready => "READY",
            SettlementEvaluationConsumerStatus.Consumed => "CONSUMED",
            SettlementEvaluationConsumerStatus.Skipped => "SKIPPED",
            SettlementEvaluationConsumerStatus.Blocked => "BLOCKED",
            SettlementEvaluationConsumerStatus.Failed => "FAILED",
            _ => "NOT_CONSUMED"
        };
    }

    private static SettlementEvaluationConsumerStatus FromDbConsumerStatus(string status)
    {
        return status switch
        {
            "READY" => SettlementEvaluationConsumerStatus.Ready,
            "CONSUMED" => SettlementEvaluationConsumerStatus.Consumed,
            "SKIPPED" => SettlementEvaluationConsumerStatus.Skipped,
            "BLOCKED" => SettlementEvaluationConsumerStatus.Blocked,
            "FAILED" => SettlementEvaluationConsumerStatus.Failed,
            _ => SettlementEvaluationConsumerStatus.NotConsumed
        };
    }

    private static string? ReadString(IReadOnlyDictionary<string, object?> metadata, string key)
    {
        return metadata.TryGetValue(key, out var value) ? value?.ToString() : null;
    }

    private static Guid? ReadGuid(IReadOnlyDictionary<string, object?> metadata, string key)
    {
        return Guid.TryParse(ReadString(metadata, key), out var value) ? value : null;
    }

    private static DateTimeOffset? ReadDateTimeOffset(IReadOnlyDictionary<string, object?> metadata, string key)
    {
        return DateTimeOffset.TryParse(ReadString(metadata, key), out var value) ? value : null;
    }
}

public sealed class PostgresEvaluationCheckpointRepository(string connectionString) : IEvaluationCheckpointRepository
{
    public PersistedEvaluationCheckpoint UpsertCheckpoint(
        EvaluationRunDefinition run,
        EvaluationBatchDefinition batch,
        int processedCount,
        int failedCount,
        EvaluationCheckpointStatus status)
    {
        using var connection = OpenConnection();
        PostgresEvaluationStorageSupport.EnsureGraph(connection, run, batch);

        using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.evaluation_checkpoints (
  evaluation_run_id,
  evaluation_batch_id,
  cursor,
  processed_count,
  failed_count,
  retry_count,
  status,
  created_at,
  updated_at
) values (
  @evaluation_run_id,
  @evaluation_batch_id,
  @cursor,
  @processed_count,
  @failed_count,
  @retry_count,
  @status,
  @created_at,
  @updated_at
)
on conflict (evaluation_batch_id) do update set
  evaluation_run_id = excluded.evaluation_run_id,
  cursor = excluded.cursor,
  processed_count = excluded.processed_count,
  failed_count = excluded.failed_count,
  retry_count = excluded.retry_count,
  status = excluded.status,
  updated_at = excluded.updated_at;
""";
        var now = DateTimeOffset.UtcNow;
        command.Parameters.AddWithValue("evaluation_run_id", run.Id);
        command.Parameters.AddWithValue("evaluation_batch_id", batch.Id);
        command.Parameters.AddWithValue("cursor", batch.CheckpointCursor);
        command.Parameters.AddWithValue("processed_count", processedCount);
        command.Parameters.AddWithValue("failed_count", failedCount);
        command.Parameters.AddWithValue("retry_count", batch.RetryCount);
        command.Parameters.AddWithValue("status", status.ToString());
        command.Parameters.AddWithValue("created_at", now);
        command.Parameters.AddWithValue("updated_at", now);
        command.ExecuteNonQuery();

        return GetCheckpoints(run.Id).Single(checkpoint => checkpoint.BatchId == batch.Id);
    }

    public IReadOnlyCollection<PersistedEvaluationCheckpoint> GetCheckpoints()
    {
        return QueryMany(string.Empty);
    }

    public IReadOnlyCollection<PersistedEvaluationCheckpoint> GetCheckpoints(Guid runId)
    {
        return QueryMany("where evaluation_run_id = @value", command => command.Parameters.AddWithValue("value", runId));
    }

    private IReadOnlyCollection<PersistedEvaluationCheckpoint> QueryMany(string whereClause, Action<NpgsqlCommand>? configure = null)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = $"""
select
  evaluation_run_id,
  evaluation_batch_id,
  cursor,
  processed_count,
  failed_count,
  retry_count,
  status,
  created_at,
  updated_at
from game_engine.evaluation_checkpoints
{whereClause}
order by evaluation_run_id, evaluation_batch_id;
""";
        configure?.Invoke(command);

        using var reader = command.ExecuteReader();
        var checkpoints = new List<PersistedEvaluationCheckpoint>();
        while (reader.Read())
        {
            checkpoints.Add(new PersistedEvaluationCheckpoint(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetString(2),
                reader.GetInt32(3),
                reader.GetInt32(4),
                reader.GetInt32(5),
                Enum.Parse<EvaluationCheckpointStatus>(reader.GetString(6), ignoreCase: true),
                reader.GetFieldValue<DateTimeOffset>(7),
                reader.GetFieldValue<DateTimeOffset>(8)));
        }

        return checkpoints;
    }

    private NpgsqlConnection OpenConnection()
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        connection.Open();
        return connection;
    }
}

internal static class PostgresConnectionString
{
    public static string Normalize(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            (uri.Scheme != "postgres" && uri.Scheme != "postgresql"))
        {
            return value;
        }

        var userInfo = uri.UserInfo.Split(':', 2);
        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Database = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/')),
            Username = Uri.UnescapeDataString(userInfo.ElementAtOrDefault(0) ?? string.Empty),
            Password = Uri.UnescapeDataString(userInfo.ElementAtOrDefault(1) ?? string.Empty),
            Pooling = true
        };

        return builder.ConnectionString;
    }
}

internal static class PostgresEvaluationStorageSupport
{
    public static void EnsureGraph(NpgsqlConnection connection, ImmutableEvaluationRecord record)
    {
        var moduleId = StableGuid($"module:{record.ModuleId}");
        var moduleVersionId = StableGuid($"module-version:{record.ModuleId}:{record.ModuleVersion}");
        var gameDefinitionVersionId = StableGuid($"game-definition-version:{record.GameId:N}:1");
        var drawAuthorityId = StableGuid("draw-authority:evaluation-persistence-placeholder");
        var drawAuthorityVersionId = StableGuid("draw-authority-version:evaluation-persistence-placeholder");
        var assignmentId = StableGuid($"draw-authority-assignment:{record.GameId:N}:{drawAuthorityId:N}");
        var submissionId = StableGuid($"draw-result-submission:{record.DrawId:N}");
        var officialResultId = StableGuid($"official-certified-result:{record.DrawId:N}");

        EnsureReferenceRows(
            connection,
            moduleId,
            moduleVersionId,
            record.ModuleId,
            record.ModuleVersion,
            record.GameId,
            gameDefinitionVersionId,
            record.PaytableVersion,
            record.EvaluatorVersion,
            drawAuthorityId,
            drawAuthorityVersionId,
            assignmentId,
            record.DrawId,
            submissionId,
            officialResultId,
            record.EvaluatedAt);
        EnsureRunAndBatch(
            connection,
            record.RunId,
            record.BatchId,
            record.DrawId,
            record.GameId,
            officialResultId,
            record.ModuleId,
            record.ModuleVersion,
            record.EvaluatorVersion,
            sequence: 0,
            startInclusive: 0,
            endExclusive: 1,
            retryCount: 0,
            checkpointCursor: string.Empty,
            record.EvaluatedAt);
    }

    public static void EnsureGraph(NpgsqlConnection connection, EvaluationRunDefinition run, EvaluationBatchDefinition batch)
    {
        EnsureReferenceGraph(connection, run);
        EnsureRunAndBatch(
            connection,
            run.Id,
            batch.Id,
            run.DrawId,
            run.GameBindingId,
            run.OfficialCertifiedResultId,
            run.GameModuleId,
            run.GameModuleVersion,
            run.EvaluationVersion,
            batch.Sequence,
            batch.StartInclusive,
            batch.EndExclusive,
            batch.RetryCount,
            batch.CheckpointCursor,
            run.CreatedAt);
    }

    public static void EnsureReferenceGraph(NpgsqlConnection connection, EvaluationRunDefinition run)
    {
        var moduleId = StableGuid($"module:{run.GameModuleId}");
        var moduleVersionId = StableGuid($"module-version:{run.GameModuleId}:{run.GameModuleVersion}");
        var gameDefinitionVersionId = StableGuid($"game-definition-version:{run.GameBindingId:N}:1");
        var drawAuthorityId = StableGuid("draw-authority:evaluation-persistence-placeholder");
        var drawAuthorityVersionId = StableGuid("draw-authority-version:evaluation-persistence-placeholder");
        var assignmentId = StableGuid($"draw-authority-assignment:{run.GameBindingId:N}:{drawAuthorityId:N}");
        var submissionId = StableGuid($"draw-result-submission:{run.DrawId:N}");

        EnsureReferenceRows(
            connection,
            moduleId,
            moduleVersionId,
            run.GameModuleId,
            run.GameModuleVersion,
            run.GameBindingId,
            gameDefinitionVersionId,
            "unknown",
            run.EvaluationVersion,
            drawAuthorityId,
            drawAuthorityVersionId,
            assignmentId,
            run.DrawId,
            submissionId,
            run.OfficialCertifiedResultId,
            run.CreatedAt);
    }

    private static void EnsureReferenceRows(
        NpgsqlConnection connection,
        Guid moduleId,
        Guid moduleVersionId,
        string moduleCode,
        string moduleVersion,
        Guid gameId,
        Guid gameDefinitionVersionId,
        string paytableVersion,
        string evaluatorVersion,
        Guid drawAuthorityId,
        Guid drawAuthorityVersionId,
        Guid assignmentId,
        Guid drawId,
        Guid submissionId,
        Guid officialResultId,
        DateTimeOffset timestamp)
    {
        Execute(
            connection,
            """
insert into game_engine.game_modules (id, code, display_name, lifecycle_status, active_version_id, created_at)
values (@module_id, @module_code, @module_code, 'ACTIVE', @module_version_id, @timestamp)
on conflict (code) do update set
  active_version_id = coalesce(game_engine.game_modules.active_version_id, excluded.active_version_id);

insert into game_engine.game_module_versions (id, game_module_id, version, sdk_version, manifest_hash, lifecycle_status, created_at)
values (
  @module_version_id,
  (select id from game_engine.game_modules where code = @module_code),
  @module_version,
  'runtime',
  @module_version_id_text,
  'ACTIVE',
  @timestamp
)
on conflict (game_module_id, version) do nothing;

insert into game_engine.game_definitions (id, code, display_name, active_version_id, game_module_id, created_at)
values (
  @game_id,
  @game_code,
  @game_code,
  @game_definition_version_id,
  (select id from game_engine.game_modules where code = @module_code),
  @timestamp
)
on conflict (id) do update set
  active_version_id = coalesce(game_engine.game_definitions.active_version_id, excluded.active_version_id);

insert into game_engine.game_definition_versions (
  id,
  game_definition_id,
  version_number,
  definition_hash,
  paytable_version,
  evaluator_version,
  draw_generator_version,
  effective_from
) values (
  @game_definition_version_id,
  @game_id,
  1,
  @game_definition_version_id_text,
  @paytable_version,
  @evaluator_version,
  'disabled',
  @timestamp
)
on conflict (game_definition_id, version_number) do nothing;

insert into game_engine.draw_authorities (id, code, display_name, provider_type, status, active_version_id, created_at)
values (@draw_authority_id, 'evaluation-persistence-placeholder', 'Evaluation Persistence Placeholder', 'ManualCertifiedEntry', 'ACTIVE', @draw_authority_version_id, @timestamp)
on conflict (code) do update set
  active_version_id = coalesce(game_engine.draw_authorities.active_version_id, excluded.active_version_id);

insert into game_engine.draw_authority_versions (id, draw_authority_id, version, provider_version, configuration_hash, status, created_at)
values (
  @draw_authority_version_id,
  (select id from game_engine.draw_authorities where code = 'evaluation-persistence-placeholder'),
  '0.0.0-local',
  '0.0.0-local',
  @draw_authority_version_id_text,
  'ACTIVE',
  @timestamp
)
on conflict (draw_authority_id, version) do nothing;

insert into game_engine.draw_authority_assignments (
  id,
  game_definition_id,
  draw_authority_id,
  draw_authority_version_id,
  settlement_trigger_policy,
  effective_from
) values (
  @assignment_id,
  @game_id,
  (select id from game_engine.draw_authorities where code = 'evaluation-persistence-placeholder'),
  (select id from game_engine.draw_authority_versions where id = @draw_authority_version_id),
  'Manual',
  @timestamp
)
on conflict (id) do nothing;

insert into game_engine.draw_schedules (
  id,
  game_definition_id,
  draw_authority_assignment_id,
  sales_open_at,
  sales_close_at,
  draw_at,
  status
) values (
  @draw_id,
  @game_id,
  @assignment_id,
  @sales_open_at,
  @sales_close_at,
  @draw_at,
  'EvaluationCompleted'
)
on conflict (id) do nothing;

insert into game_engine.draw_result_submissions (
  id,
  draw_schedule_id,
  draw_authority_id,
  result_hash,
  result_payload_reference,
  submitted_by,
  submitted_at,
  is_manual_submission
) values (
  @submission_id,
  @draw_id,
  (select id from game_engine.draw_authorities where code = 'evaluation-persistence-placeholder'),
  @submission_hash,
  @submission_reference,
  'evaluation-persistence',
  @timestamp,
  true
)
on conflict (id) do nothing;

insert into game_engine.official_certified_draw_results (
  id,
  draw_schedule_id,
  draw_result_submission_id,
  certified_by,
  certified_at,
  game_module_version,
  draw_generator_version,
  prng_provider_version,
  draw_authority_version,
  algorithm_version,
  payload_hash
) values (
  @official_result_id,
  @draw_id,
  @submission_id,
  'evaluation-persistence',
  @timestamp,
  @module_version,
  'disabled',
  'not-approved',
  '0.0.0-local',
  @evaluator_version,
  @submission_hash
)
on conflict (draw_schedule_id) do nothing;
""",
            command =>
            {
                command.Parameters.AddWithValue("module_id", moduleId);
                command.Parameters.AddWithValue("module_version_id", moduleVersionId);
                command.Parameters.AddWithValue("module_code", moduleCode);
                command.Parameters.AddWithValue("module_version", moduleVersion);
                command.Parameters.AddWithValue("module_version_id_text", moduleVersionId.ToString("N"));
                command.Parameters.AddWithValue("game_id", gameId);
                command.Parameters.AddWithValue("game_code", $"game-{gameId:N}");
                command.Parameters.AddWithValue("game_definition_version_id", gameDefinitionVersionId);
                command.Parameters.AddWithValue("game_definition_version_id_text", gameDefinitionVersionId.ToString("N"));
                command.Parameters.AddWithValue("paytable_version", paytableVersion);
                command.Parameters.AddWithValue("evaluator_version", evaluatorVersion);
                command.Parameters.AddWithValue("draw_authority_id", drawAuthorityId);
                command.Parameters.AddWithValue("draw_authority_version_id", drawAuthorityVersionId);
                command.Parameters.AddWithValue("draw_authority_version_id_text", drawAuthorityVersionId.ToString("N"));
                command.Parameters.AddWithValue("assignment_id", assignmentId);
                command.Parameters.AddWithValue("draw_id", drawId);
                command.Parameters.AddWithValue("submission_id", submissionId);
                command.Parameters.AddWithValue("submission_hash", $"hash:{drawId:N}");
                command.Parameters.AddWithValue("submission_reference", $"local://game-engine/draw-results/{drawId:N}");
                command.Parameters.AddWithValue("official_result_id", officialResultId);
                command.Parameters.AddWithValue("timestamp", timestamp);
                command.Parameters.AddWithValue("sales_open_at", timestamp.AddHours(-2));
                command.Parameters.AddWithValue("sales_close_at", timestamp.AddHours(-1));
                command.Parameters.AddWithValue("draw_at", timestamp.AddMinutes(-30));
            });
    }

    private static void EnsureRunAndBatch(
        NpgsqlConnection connection,
        Guid runId,
        Guid batchId,
        Guid drawId,
        Guid gameId,
        Guid officialResultId,
        string moduleId,
        string moduleVersion,
        string evaluationVersion,
        int sequence,
        int startInclusive,
        int endExclusive,
        int retryCount,
        string checkpointCursor,
        DateTimeOffset timestamp)
    {
        Execute(
            connection,
            """
insert into game_engine.evaluation_runs (
  id,
  draw_id,
  game_binding_id,
  official_certified_draw_result_id,
  game_module_id,
  game_module_version,
  evaluation_version,
  status,
  batch_size,
  eligible_ticket_count,
  planned_batch_count,
  preconditions,
  created_at
) values (
  @run_id,
  @draw_id,
  @game_id,
  @official_result_id,
  @module_id,
  @module_version,
  @evaluation_version,
  'InProgress',
  greatest(@batch_size, 1),
  greatest(@batch_size, 1),
  1,
  '[]'::jsonb,
  @timestamp
)
on conflict (id) do nothing;

insert into game_engine.evaluation_batches (
  id,
  evaluation_run_id,
  sequence,
  start_inclusive,
  end_exclusive,
  status,
  checkpoint_cursor,
  retry_count,
  created_at
) values (
  @batch_id,
  @run_id,
  @sequence,
  @start_inclusive,
  @end_exclusive,
  'InProgress',
  @checkpoint_cursor,
  @retry_count,
  @timestamp
)
on conflict (id) do nothing;
""",
            command =>
            {
                command.Parameters.AddWithValue("run_id", runId);
                command.Parameters.AddWithValue("draw_id", drawId);
                command.Parameters.AddWithValue("game_id", gameId);
                command.Parameters.AddWithValue("official_result_id", officialResultId);
                command.Parameters.AddWithValue("module_id", moduleId);
                command.Parameters.AddWithValue("module_version", moduleVersion);
                command.Parameters.AddWithValue("evaluation_version", evaluationVersion);
                command.Parameters.AddWithValue("batch_size", Math.Max(1, endExclusive - startInclusive));
                command.Parameters.AddWithValue("batch_id", batchId);
                command.Parameters.AddWithValue("sequence", sequence);
                command.Parameters.AddWithValue("start_inclusive", Math.Max(0, startInclusive));
                command.Parameters.AddWithValue("end_exclusive", Math.Max(Math.Max(0, startInclusive), endExclusive));
                command.Parameters.AddWithValue("checkpoint_cursor", checkpointCursor);
                command.Parameters.AddWithValue("retry_count", retryCount);
                command.Parameters.AddWithValue("timestamp", timestamp);
            });
    }

    private static void Execute(NpgsqlConnection connection, string sql, Action<NpgsqlCommand> configure)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        configure(command);
        command.ExecuteNonQuery();
    }

    private static Guid StableGuid(string value)
    {
        var bytes = MD5.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes);
    }
}
