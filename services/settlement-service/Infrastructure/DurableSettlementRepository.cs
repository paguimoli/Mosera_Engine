using System.Text.Json;
using SettlementService.Configuration;
using SettlementService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace SettlementService.Infrastructure;

public sealed class DurableSettlementRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly string[] IncompleteStatuses = ["running", "partially_completed", "recovering"];
    private readonly ServiceConfiguration configuration;

    public DurableSettlementRepository(ServiceConfiguration configuration)
    {
        this.configuration = configuration;
    }

    public bool DurablePersistenceConfigured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<SettlementRunDto> SaveRunAsync(
        CreateSettlementRunRequest request,
        CancellationToken cancellationToken)
    {
        var id = string.IsNullOrWhiteSpace(request.Id) ? $"settlement-run-{Guid.NewGuid():N}" : request.Id.Trim();
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into settlement_service.settlement_runs (
  id,
  drawing_id,
  game_id,
  status,
  expected_ticket_count,
  expected_line_count,
  started_at,
  completed_at,
  execution_id,
  processed_ticket_count,
  processed_line_count,
  win_count,
  loss_count,
  push_count,
  failed_count,
  total_stake,
  total_payout,
  total_net,
  duration_ms,
  tickets_per_second,
  lines_per_second,
  draw_to_settlement_ms,
  peak_concurrent_settlements,
  notes,
  record_hash,
  previous_hash,
  hash_version,
  created_at
)
values (
  @id, @drawing_id, @game_id, @status, @expected_ticket_count,
  @expected_line_count, @started_at, @completed_at, @execution_id,
  @processed_ticket_count, @processed_line_count, @win_count, @loss_count,
  @push_count, @failed_count, @total_stake, @total_payout, @total_net,
  @duration_ms, @tickets_per_second, @lines_per_second, @draw_to_settlement_ms,
  @peak_concurrent_settlements, @notes, @record_hash, @previous_hash,
  @hash_version, @created_at
)
on conflict (id) do update
set status = excluded.status,
    expected_ticket_count = excluded.expected_ticket_count,
    expected_line_count = excluded.expected_line_count,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at,
    execution_id = excluded.execution_id,
    processed_ticket_count = excluded.processed_ticket_count,
    processed_line_count = excluded.processed_line_count,
    win_count = excluded.win_count,
    loss_count = excluded.loss_count,
    push_count = excluded.push_count,
    failed_count = excluded.failed_count,
    total_stake = excluded.total_stake,
    total_payout = excluded.total_payout,
    total_net = excluded.total_net,
    duration_ms = excluded.duration_ms,
    tickets_per_second = excluded.tickets_per_second,
    lines_per_second = excluded.lines_per_second,
    draw_to_settlement_ms = excluded.draw_to_settlement_ms,
    peak_concurrent_settlements = excluded.peak_concurrent_settlements,
    notes = excluded.notes,
    record_hash = excluded.record_hash,
    previous_hash = excluded.previous_hash,
    hash_version = excluded.hash_version,
    updated_at = now()
returning *
""";
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("drawing_id", request.DrawingId);
        command.Parameters.AddWithValue("game_id", request.GameId);
        command.Parameters.AddWithValue("status", request.Status);
        command.Parameters.AddWithValue("expected_ticket_count", request.ExpectedTicketCount);
        command.Parameters.AddWithValue("expected_line_count", request.ExpectedLineCount);
        AddNullable(command, "started_at", NpgsqlDbType.TimestampTz, request.StartedAt);
        AddNullable(command, "completed_at", NpgsqlDbType.TimestampTz, request.CompletedAt);
        AddNullable(command, "execution_id", NpgsqlDbType.Text, request.ExecutionId);
        command.Parameters.AddWithValue("processed_ticket_count", request.ProcessedTicketCount);
        command.Parameters.AddWithValue("processed_line_count", request.ProcessedLineCount);
        command.Parameters.AddWithValue("win_count", request.WinCount);
        command.Parameters.AddWithValue("loss_count", request.LossCount);
        command.Parameters.AddWithValue("push_count", request.PushCount);
        command.Parameters.AddWithValue("failed_count", request.FailedCount);
        command.Parameters.AddWithValue("total_stake", request.TotalStake);
        command.Parameters.AddWithValue("total_payout", request.TotalPayout);
        command.Parameters.AddWithValue("total_net", request.TotalNet);
        command.Parameters.AddWithValue("duration_ms", request.DurationMs);
        command.Parameters.AddWithValue("tickets_per_second", request.TicketsPerSecond);
        command.Parameters.AddWithValue("lines_per_second", request.LinesPerSecond);
        AddNullable(command, "draw_to_settlement_ms", NpgsqlDbType.Integer, request.DrawToSettlementMs);
        command.Parameters.AddWithValue("peak_concurrent_settlements", request.PeakConcurrentSettlements);
        AddNullable(command, "notes", NpgsqlDbType.Text, request.Notes);
        AddNullable(command, "record_hash", NpgsqlDbType.Text, request.RecordHash);
        AddNullable(command, "previous_hash", NpgsqlDbType.Text, request.PreviousHash);
        AddNullable(command, "hash_version", NpgsqlDbType.Text, request.HashVersion);
        command.Parameters.AddWithValue("created_at", request.CreatedAt ?? DateTimeOffset.UtcNow);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new DurableSettlementRepositoryException("Settlement run did not return a row.");
        }

        return MapRun(reader);
    }

    public async Task<SettlementRunDto?> GetRunAsync(
        string runId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "select * from settlement_service.settlement_runs where id = @id;";
        command.Parameters.AddWithValue("id", runId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapRun(reader) : null;
    }

    public async Task<IReadOnlyList<SettlementRunDto>> ListRunsAsync(
        string? drawingId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = string.IsNullOrWhiteSpace(drawingId)
            ? """
select *
from settlement_service.settlement_runs
order by created_at asc, id asc;
"""
            : """
select *
from settlement_service.settlement_runs
where drawing_id = @drawing_id
order by created_at asc, id asc;
""";
        if (!string.IsNullOrWhiteSpace(drawingId))
        {
            command.Parameters.AddWithValue("drawing_id", drawingId.Trim());
        }

        return await ReadRunsAsync(command, cancellationToken);
    }

    public async Task<IReadOnlyList<SettlementRunDto>> ListIncompleteRunsAsync(
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from settlement_service.settlement_runs
where status = any(@statuses)
order by created_at asc, id asc;
""";
        command.Parameters.AddWithValue("statuses", IncompleteStatuses);

        return await ReadRunsAsync(command, cancellationToken);
    }

    public async Task<IReadOnlyList<SettlementRecordDto>> AppendRecordsAsync(
        string settlementRunId,
        IReadOnlyList<CreateSettlementRecordRequest> records,
        CancellationToken cancellationToken)
    {
        var persisted = new List<SettlementRecordDto>();

        await using var connection = await OpenConnectionAsync(cancellationToken);
        foreach (var record in records)
        {
            await using var command = connection.CreateCommand();
            var id = string.IsNullOrWhiteSpace(record.Id)
                ? $"settlement-record-{Guid.NewGuid():N}"
                : record.Id.Trim();
            command.CommandText = """
insert into settlement_service.settlement_records (
  id,
  settlement_run_id,
  ticket_id,
  ticket_line_id,
  account_id,
  game_id,
  drawing_id,
  wager_type_id,
  wager_option_id,
  stake,
  payout,
  net_amount,
  outcome,
  status,
  version,
  previous_settlement_record_id,
  reversal_of_settlement_record_id,
  ledger_transaction_ids,
  record_hash,
  previous_hash,
  hash_version,
  created_at
)
values (
  @id, @settlement_run_id, @ticket_id, @ticket_line_id, @account_id,
  @game_id, @drawing_id, @wager_type_id, @wager_option_id, @stake,
  @payout, @net_amount, @outcome, @status, @version,
  @previous_settlement_record_id, @reversal_of_settlement_record_id,
  cast(@ledger_transaction_ids as jsonb), @record_hash, @previous_hash,
  @hash_version, @created_at
)
on conflict (id) do nothing
returning *
""";
            command.Parameters.AddWithValue("id", id);
            command.Parameters.AddWithValue("settlement_run_id", settlementRunId);
            command.Parameters.AddWithValue("ticket_id", record.TicketId);
            command.Parameters.AddWithValue("ticket_line_id", record.TicketLineId);
            command.Parameters.AddWithValue("account_id", record.AccountId);
            command.Parameters.AddWithValue("game_id", record.GameId);
            command.Parameters.AddWithValue("drawing_id", record.DrawingId);
            command.Parameters.AddWithValue("wager_type_id", record.WagerTypeId);
            AddNullable(command, "wager_option_id", NpgsqlDbType.Text, record.WagerOptionId);
            command.Parameters.AddWithValue("stake", record.Stake);
            command.Parameters.AddWithValue("payout", record.Payout);
            command.Parameters.AddWithValue("net_amount", record.NetAmount);
            command.Parameters.AddWithValue("outcome", record.Outcome);
            command.Parameters.AddWithValue("status", record.Status);
            command.Parameters.AddWithValue("version", record.Version);
            AddNullable(command, "previous_settlement_record_id", NpgsqlDbType.Text, record.PreviousSettlementRecordId);
            AddNullable(command, "reversal_of_settlement_record_id", NpgsqlDbType.Text, record.ReversalOfSettlementRecordId);
            command.Parameters.AddWithValue(
                "ledger_transaction_ids",
                JsonSerializer.Serialize(record.LedgerTransactionIds ?? Array.Empty<string>(), JsonOptions));
            AddNullable(command, "record_hash", NpgsqlDbType.Text, record.RecordHash);
            AddNullable(command, "previous_hash", NpgsqlDbType.Text, record.PreviousHash);
            AddNullable(command, "hash_version", NpgsqlDbType.Text, record.HashVersion);
            command.Parameters.AddWithValue("created_at", record.CreatedAt ?? DateTimeOffset.UtcNow);

            SettlementRecordDto? insertedRecord = null;
            await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
            {
                if (await reader.ReadAsync(cancellationToken))
                {
                    insertedRecord = MapRecord(reader);
                }
            }

            if (insertedRecord is not null)
            {
                persisted.Add(insertedRecord);
                continue;
            }

            persisted.Add(await GetRecordByIdAsync(connection, id, cancellationToken)
                ?? throw new DurableSettlementRepositoryException("Unable to read idempotent settlement record."));
        }

        return persisted;
    }

    public async Task<IReadOnlyList<SettlementRecordDto>> ListRecordsByRunAsync(
        string settlementRunId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from settlement_service.settlement_records
where settlement_run_id = @settlement_run_id
order by created_at asc, id asc;
""";
        command.Parameters.AddWithValue("settlement_run_id", settlementRunId);

        var records = new List<SettlementRecordDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            records.Add(MapRecord(reader));
        }

        return records;
    }

    public async Task<IReadOnlyList<SettlementLedgerEffectDto>> AppendLedgerEffectsAsync(
        string settlementRunId,
        IReadOnlyList<CreateSettlementLedgerEffectRequest> effects,
        CancellationToken cancellationToken)
    {
        var persisted = new List<SettlementLedgerEffectDto>();

        await using var connection = await OpenConnectionAsync(cancellationToken);
        foreach (var effect in effects)
        {
            await using var command = connection.CreateCommand();
            var id = string.IsNullOrWhiteSpace(effect.Id)
                ? $"settlement-ledger-effect-{Guid.NewGuid():N}"
                : effect.Id.Trim();
            command.CommandText = """
insert into settlement_service.settlement_ledger_effects (
  id,
  settlement_run_id,
  settlement_record_id,
  ticket_id,
  ticket_line_id,
  drawing_id,
  account_id,
  effect_type,
  transaction_type,
  direction,
  amount,
  idempotency_key,
  posting_status,
  reference_type,
  reference_id,
  reversal_of_ledger_effect_id,
  metadata,
  created_at
)
values (
  @id, @settlement_run_id, @settlement_record_id, @ticket_id,
  @ticket_line_id, @drawing_id, @account_id, @effect_type,
  @transaction_type, @direction, @amount, @idempotency_key,
  @posting_status, @reference_type, @reference_id,
  @reversal_of_ledger_effect_id, cast(@metadata as jsonb), @created_at
)
on conflict (idempotency_key) do nothing
returning *
""";
            command.Parameters.AddWithValue("id", id);
            command.Parameters.AddWithValue("settlement_run_id", settlementRunId);
            command.Parameters.AddWithValue("settlement_record_id", effect.SettlementRecordId);
            command.Parameters.AddWithValue("ticket_id", effect.TicketId);
            command.Parameters.AddWithValue("ticket_line_id", effect.TicketLineId);
            command.Parameters.AddWithValue("drawing_id", effect.DrawingId);
            command.Parameters.AddWithValue("account_id", effect.AccountId);
            command.Parameters.AddWithValue("effect_type", effect.EffectType);
            command.Parameters.AddWithValue("transaction_type", effect.TransactionType);
            command.Parameters.AddWithValue("direction", effect.Direction);
            command.Parameters.AddWithValue("amount", effect.Amount);
            command.Parameters.AddWithValue("idempotency_key", effect.IdempotencyKey);
            command.Parameters.AddWithValue("posting_status", effect.PostingStatus);
            command.Parameters.AddWithValue("reference_type", effect.ReferenceType);
            command.Parameters.AddWithValue("reference_id", effect.ReferenceId);
            AddNullable(command, "reversal_of_ledger_effect_id", NpgsqlDbType.Text, effect.ReversalOfLedgerEffectId);
            command.Parameters.AddWithValue(
                "metadata",
                JsonSerializer.Serialize(effect.Metadata ?? new Dictionary<string, object?>(), JsonOptions));
            command.Parameters.AddWithValue("created_at", effect.CreatedAt ?? DateTimeOffset.UtcNow);

            SettlementLedgerEffectDto? insertedEffect = null;
            await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
            {
                if (await reader.ReadAsync(cancellationToken))
                {
                    insertedEffect = MapLedgerEffect(reader);
                }
            }

            if (insertedEffect is not null)
            {
                persisted.Add(insertedEffect);
                continue;
            }

            persisted.Add(await GetLedgerEffectByIdempotencyKeyAsync(connection, effect.IdempotencyKey, cancellationToken)
                ?? throw new DurableSettlementRepositoryException("Unable to read idempotent settlement ledger effect."));
        }

        return persisted;
    }

    public async Task<IReadOnlyList<SettlementLedgerEffectDto>> ListLedgerEffectsByRunAsync(
        string settlementRunId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from settlement_service.settlement_ledger_effects
where settlement_run_id = @settlement_run_id
order by created_at asc, id asc;
""";
        command.Parameters.AddWithValue("settlement_run_id", settlementRunId);

        var effects = new List<SettlementLedgerEffectDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            effects.Add(MapLedgerEffect(reader));
        }

        return effects;
    }

    public async Task<bool> CanConnectAsync(CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            return false;
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "select 1";
        await command.ExecuteScalarAsync(cancellationToken);
        return true;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            throw new DurableSettlementRepositoryException("DATABASE_URL is not configured.");
        }

        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static async Task<IReadOnlyList<SettlementRunDto>> ReadRunsAsync(
        NpgsqlCommand command,
        CancellationToken cancellationToken)
    {
        var runs = new List<SettlementRunDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            runs.Add(MapRun(reader));
        }

        return runs;
    }

    private static async Task<SettlementRecordDto?> GetRecordByIdAsync(
        NpgsqlConnection connection,
        string id,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "select * from settlement_service.settlement_records where id = @id;";
        command.Parameters.AddWithValue("id", id);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapRecord(reader) : null;
    }

    private static async Task<SettlementLedgerEffectDto?> GetLedgerEffectByIdempotencyKeyAsync(
        NpgsqlConnection connection,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "select * from settlement_service.settlement_ledger_effects where idempotency_key = @idempotency_key;";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapLedgerEffect(reader) : null;
    }

    private static SettlementRunDto MapRun(NpgsqlDataReader reader)
    {
        return new SettlementRunDto(
            reader.GetString(reader.GetOrdinal("id")),
            reader.GetString(reader.GetOrdinal("drawing_id")),
            reader.GetString(reader.GetOrdinal("game_id")),
            reader.GetString(reader.GetOrdinal("status")),
            reader.GetInt32(reader.GetOrdinal("expected_ticket_count")),
            reader.GetInt32(reader.GetOrdinal("expected_line_count")),
            GetNullableDateTimeOffset(reader, "started_at"),
            GetNullableDateTimeOffset(reader, "completed_at"),
            GetNullableString(reader, "execution_id"),
            reader.GetInt32(reader.GetOrdinal("processed_ticket_count")),
            reader.GetInt32(reader.GetOrdinal("processed_line_count")),
            reader.GetInt32(reader.GetOrdinal("win_count")),
            reader.GetInt32(reader.GetOrdinal("loss_count")),
            reader.GetInt32(reader.GetOrdinal("push_count")),
            reader.GetInt32(reader.GetOrdinal("failed_count")),
            reader.GetDecimal(reader.GetOrdinal("total_stake")),
            reader.GetDecimal(reader.GetOrdinal("total_payout")),
            reader.GetDecimal(reader.GetOrdinal("total_net")),
            reader.GetInt32(reader.GetOrdinal("duration_ms")),
            reader.GetDecimal(reader.GetOrdinal("tickets_per_second")),
            reader.GetDecimal(reader.GetOrdinal("lines_per_second")),
            GetNullableInt32(reader, "draw_to_settlement_ms"),
            reader.GetInt32(reader.GetOrdinal("peak_concurrent_settlements")),
            GetNullableString(reader, "notes"),
            GetNullableString(reader, "record_hash"),
            GetNullableString(reader, "previous_hash"),
            GetNullableString(reader, "hash_version"),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("created_at")));
    }

    private static SettlementRecordDto MapRecord(NpgsqlDataReader reader)
    {
        return new SettlementRecordDto(
            reader.GetString(reader.GetOrdinal("id")),
            reader.GetString(reader.GetOrdinal("settlement_run_id")),
            reader.GetString(reader.GetOrdinal("ticket_id")),
            reader.GetString(reader.GetOrdinal("ticket_line_id")),
            reader.GetString(reader.GetOrdinal("account_id")),
            reader.GetString(reader.GetOrdinal("game_id")),
            reader.GetString(reader.GetOrdinal("drawing_id")),
            reader.GetString(reader.GetOrdinal("wager_type_id")),
            GetNullableString(reader, "wager_option_id"),
            reader.GetDecimal(reader.GetOrdinal("stake")),
            reader.GetDecimal(reader.GetOrdinal("payout")),
            reader.GetDecimal(reader.GetOrdinal("net_amount")),
            reader.GetString(reader.GetOrdinal("outcome")),
            reader.GetString(reader.GetOrdinal("status")),
            reader.GetInt32(reader.GetOrdinal("version")),
            GetNullableString(reader, "previous_settlement_record_id"),
            GetNullableString(reader, "reversal_of_settlement_record_id"),
            JsonSerializer.Deserialize<IReadOnlyList<string>>(
                reader.GetString(reader.GetOrdinal("ledger_transaction_ids")),
                JsonOptions) ?? Array.Empty<string>(),
            GetNullableString(reader, "record_hash"),
            GetNullableString(reader, "previous_hash"),
            GetNullableString(reader, "hash_version"),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("created_at")));
    }

    private static SettlementLedgerEffectDto MapLedgerEffect(NpgsqlDataReader reader)
    {
        return new SettlementLedgerEffectDto(
            reader.GetString(reader.GetOrdinal("id")),
            reader.GetString(reader.GetOrdinal("settlement_run_id")),
            reader.GetString(reader.GetOrdinal("settlement_record_id")),
            reader.GetString(reader.GetOrdinal("ticket_id")),
            reader.GetString(reader.GetOrdinal("ticket_line_id")),
            reader.GetString(reader.GetOrdinal("drawing_id")),
            reader.GetString(reader.GetOrdinal("account_id")),
            reader.GetString(reader.GetOrdinal("effect_type")),
            reader.GetString(reader.GetOrdinal("transaction_type")),
            reader.GetString(reader.GetOrdinal("direction")),
            reader.GetDecimal(reader.GetOrdinal("amount")),
            reader.GetString(reader.GetOrdinal("idempotency_key")),
            reader.GetString(reader.GetOrdinal("posting_status")),
            reader.GetString(reader.GetOrdinal("reference_type")),
            reader.GetString(reader.GetOrdinal("reference_id")),
            GetNullableString(reader, "reversal_of_ledger_effect_id"),
            JsonSerializer.Deserialize<IReadOnlyDictionary<string, object?>>(
                reader.GetString(reader.GetOrdinal("metadata")),
                JsonOptions) ?? new Dictionary<string, object?>(),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("created_at")));
    }

    private static string? GetNullableString(NpgsqlDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static int? GetNullableInt32(NpgsqlDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);
    }

    private static DateTimeOffset? GetNullableDateTimeOffset(NpgsqlDataReader reader, string name)
    {
        var ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetFieldValue<DateTimeOffset>(ordinal);
    }

    private static void AddNullable<T>(
        NpgsqlCommand command,
        string name,
        NpgsqlDbType type,
        T? value)
    {
        command.Parameters.Add(name, type).Value = value is null ? DBNull.Value : value;
    }
}

public sealed class DurableSettlementRepositoryException : Exception
{
    public DurableSettlementRepositoryException(string message)
        : base(message)
    {
    }
}
