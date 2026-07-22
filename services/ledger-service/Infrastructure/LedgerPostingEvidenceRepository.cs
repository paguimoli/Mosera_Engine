using System.Text.Json;
using LedgerService.Configuration;
using LedgerService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace LedgerService.Infrastructure;

public sealed record LedgerPostingRequestRecord(
    Guid Id,
    string RequestKind,
    string InstructionId,
    string InstructionType,
    string InstructionHash,
    string OriginatingAuthority,
    Guid? SettlementRecordId,
    Guid WalletId,
    Guid? LedgerAccountId,
    LedgerDirection Direction,
    long Amount,
    string Currency,
    int MinorUnitPrecision,
    LedgerTransactionType TransactionType,
    string IdempotencyKey,
    string CanonicalRequestHash,
    DateTimeOffset EffectiveAt,
    DateTimeOffset AccountingPostedAt,
    Guid? AccountingBrandId,
    Guid? AccountingMarketId,
    Guid? OriginalAccountingPeriodId,
    Guid? PostingAccountingPeriodId,
    Guid? OriginalLedgerEntryId,
    string? OriginalLedgerEntryHash,
    LedgerPostingRequestStatus Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt,
    string? FailureCode,
    string? FailureReason,
    Guid? LedgerEntryId,
    string? LedgerEntryHash,
    Guid? JournalTransactionId,
    IReadOnlyDictionary<string, object?> Metadata);

public sealed record LedgerPostingRequestClaim(
    LedgerPostingRequestRecord Request,
    bool Created);

public sealed record LedgerPostingAttemptRecord(
    Guid Id,
    Guid PostingRequestId,
    int AttemptNumber,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    LedgerPostingAttemptResult Result,
    string? FailureClassification,
    string? TargetResponseReference,
    string? ResponseHash,
    string RuntimeProvenance,
    string BuildProvenance,
    string CanonicalEvidenceHash,
    DateTimeOffset CreatedAt);

public sealed record LedgerReplayEvidenceRecord(
    Guid Id,
    Guid PostingRequestId,
    Guid LedgerEntryId,
    LedgerReplayResult Result,
    IReadOnlyList<string> Mismatches,
    string RequestHash,
    string EntryHash,
    string CanonicalEvidenceHash,
    DateTimeOffset VerifiedAt);

public sealed class LedgerPostingEvidenceRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ServiceConfiguration configuration;

    public LedgerPostingEvidenceRepository(ServiceConfiguration configuration)
    {
        this.configuration = configuration;
    }

    public bool Configured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<LedgerPostingRequestClaim> ClaimAsync(
        LedgerPostingRequestRecord request,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await using var insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = """
insert into ledger_service.ledger_posting_requests (
  id, request_kind, instruction_id, instruction_type, instruction_hash,
  originating_authority, settlement_record_id, ledger_wallet_id, ledger_account_id,
  direction, amount_minor, currency, minor_unit_precision, transaction_type,
  idempotency_key, canonical_request_hash, effective_at, accounting_posted_at,
  accounting_brand_id, accounting_market_id, original_accounting_period_id,
  posting_accounting_period_id,
  original_ledger_entry_id, original_ledger_entry_hash, correlation_metadata,
  request_status, created_at
)
values (
  @id, @request_kind, @instruction_id, @instruction_type, @instruction_hash,
  @originating_authority, @settlement_record_id, @ledger_wallet_id, @ledger_account_id,
  @direction, @amount_minor, @currency, @minor_unit_precision, @transaction_type,
  @idempotency_key, @canonical_request_hash, @effective_at, @accounting_posted_at,
  @accounting_brand_id, @accounting_market_id, @original_accounting_period_id,
  @posting_accounting_period_id,
  @original_ledger_entry_id, @original_ledger_entry_hash, cast(@correlation_metadata as jsonb),
  'CLAIMED', @created_at
)
on conflict (idempotency_key) do nothing;
""";
        AddRequestParameters(insert, request);
        var created = await insert.ExecuteNonQueryAsync(cancellationToken) == 1;

        var stored = await FindByIdempotencyKeyAsync(
            connection,
            transaction,
            request.IdempotencyKey,
            cancellationToken) ?? throw new LedgerPostingEvidenceException(
                "Ledger posting request claim could not be read back.");

        await transaction.CommitAsync(cancellationToken);
        return new LedgerPostingRequestClaim(stored, created);
    }

    public async Task<LedgerPostingRequestRecord?> FindByIdAsync(
        Guid requestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"{RequestSelect} where id = @id";
        command.Parameters.AddWithValue("id", requestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapRequest(reader) : null;
    }

    public async Task<LedgerPostingRequestRecord?> FindByIdempotencyKeyAsync(
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await FindByIdempotencyKeyAsync(connection, null, idempotencyKey, cancellationToken);
    }

    public async Task<IReadOnlyList<LedgerPostingAttemptRecord>> ListAttemptsAsync(
        Guid requestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
{AttemptSelect}
where posting_request_id = @posting_request_id
order by attempt_number asc;
""";
        command.Parameters.AddWithValue("posting_request_id", requestId);
        var attempts = new List<LedgerPostingAttemptRecord>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            attempts.Add(MapAttempt(reader));
        }

        return attempts;
    }

    public async Task<LedgerPostingRequestRecord> CompleteAsync(
        Guid requestId,
        DurableLedgerEntry entry,
        Guid journalTransactionId,
        CancellationToken cancellationToken)
    {
        return await UpdateStatusAsync(
            requestId,
            LedgerPostingRequestStatus.COMPLETED,
            null,
            null,
            entry.Id,
            entry.CanonicalRequestHash,
            journalTransactionId,
            cancellationToken);
    }

    public async Task<LedgerPostingRequestRecord> RecordStatusAsync(
        Guid requestId,
        LedgerPostingRequestStatus status,
        string? failureCode,
        string? failureReason,
        CancellationToken cancellationToken)
    {
        return await UpdateStatusAsync(
            requestId,
            status,
            failureCode,
            failureReason,
            null,
            null,
            null,
            cancellationToken);
    }

    public async Task<LedgerPostingAttemptRecord> AppendAttemptAsync(
        Guid requestId,
        DateTimeOffset startedAt,
        DateTimeOffset completedAt,
        LedgerPostingAttemptResult result,
        string? failureClassification,
        string? targetResponseReference,
        string? responseHash,
        string runtimeProvenance,
        string buildProvenance,
        string evidenceHash,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
insert into ledger_service.ledger_posting_attempts (
  id, posting_request_id, attempt_number, started_at, completed_at, result,
  failure_classification, target_response_reference, response_hash,
  runtime_provenance, build_provenance, canonical_evidence_hash
)
select @id, @posting_request_id, coalesce(max(attempt_number), 0) + 1,
       @started_at, @completed_at, @result, @failure_classification,
       @target_response_reference, @response_hash, @runtime_provenance,
       @build_provenance, @canonical_evidence_hash
from ledger_service.ledger_posting_attempts
where posting_request_id = @posting_request_id
returning id, posting_request_id, attempt_number, started_at, completed_at, result,
          failure_classification, target_response_reference, response_hash,
          runtime_provenance, build_provenance, canonical_evidence_hash, created_at;
""";
        command.Parameters.AddWithValue("id", Guid.NewGuid());
        command.Parameters.AddWithValue("posting_request_id", requestId);
        command.Parameters.AddWithValue("started_at", startedAt);
        command.Parameters.AddWithValue("completed_at", completedAt);
        command.Parameters.AddWithValue("result", result.ToString());
        AddNullable(command, "failure_classification", failureClassification);
        AddNullable(command, "target_response_reference", targetResponseReference);
        AddNullable(command, "response_hash", responseHash);
        command.Parameters.AddWithValue("runtime_provenance", runtimeProvenance);
        command.Parameters.AddWithValue("build_provenance", buildProvenance);
        command.Parameters.AddWithValue("canonical_evidence_hash", evidenceHash);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new LedgerPostingEvidenceException("Ledger posting attempt was not persisted.");
        }

        return MapAttempt(reader);
    }

    public async Task<LedgerReplayEvidenceRecord> AppendReplayEvidenceAsync(
        Guid requestId,
        Guid entryId,
        LedgerReplayResult result,
        IReadOnlyList<string> mismatches,
        string requestHash,
        string entryHash,
        string evidenceHash,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into ledger_service.ledger_replay_evidence (
  id, posting_request_id, ledger_entry_id, replay_result, mismatches,
  request_hash, entry_hash, canonical_evidence_hash
)
values (
  @id, @posting_request_id, @ledger_entry_id, @replay_result, cast(@mismatches as jsonb),
  @request_hash, @entry_hash, @canonical_evidence_hash
)
returning id, posting_request_id, ledger_entry_id, replay_result, mismatches::text,
          request_hash, entry_hash, canonical_evidence_hash, verified_at;
""";
        command.Parameters.AddWithValue("id", Guid.NewGuid());
        command.Parameters.AddWithValue("posting_request_id", requestId);
        command.Parameters.AddWithValue("ledger_entry_id", entryId);
        command.Parameters.AddWithValue("replay_result", result.ToString());
        command.Parameters.AddWithValue("mismatches", JsonSerializer.Serialize(mismatches, JsonOptions));
        command.Parameters.AddWithValue("request_hash", requestHash);
        command.Parameters.AddWithValue("entry_hash", entryHash);
        command.Parameters.AddWithValue("canonical_evidence_hash", evidenceHash);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new LedgerPostingEvidenceException("Ledger replay evidence was not persisted.");
        }

        return MapReplay(reader);
    }

    private async Task<LedgerPostingRequestRecord> UpdateStatusAsync(
        Guid requestId,
        LedgerPostingRequestStatus status,
        string? failureCode,
        string? failureReason,
        Guid? entryId,
        string? entryHash,
        Guid? journalTransactionId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
select set_config('ledger_service.allow_request_status_update', 'true', true);
update ledger_service.ledger_posting_requests
set request_status = @request_status,
    completed_at = case when @request_status = 'COMPLETED' then now() else completed_at end,
    failure_code = @failure_code,
    failure_reason = @failure_reason,
    ledger_entry_id = coalesce(@ledger_entry_id, ledger_entry_id),
    ledger_entry_hash = coalesce(@ledger_entry_hash, ledger_entry_hash),
    journal_transaction_id = coalesce(@journal_transaction_id, journal_transaction_id)
where id = @id
returning {RequestColumns};
""";
        command.Parameters.AddWithValue("id", requestId);
        command.Parameters.AddWithValue("request_status", status.ToString());
        AddNullable(command, "failure_code", failureCode);
        AddNullable(command, "failure_reason", failureReason);
        command.Parameters.Add("ledger_entry_id", NpgsqlDbType.Uuid).Value = (object?)entryId ?? DBNull.Value;
        AddNullable(command, "ledger_entry_hash", entryHash);
        command.Parameters.Add("journal_transaction_id", NpgsqlDbType.Uuid).Value =
            (object?)journalTransactionId ?? DBNull.Value;

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        LedgerPostingRequestRecord? updated = null;
        do
        {
            if (reader.FieldCount > 1 && await reader.ReadAsync(cancellationToken))
            {
                updated = MapRequest(reader);
            }
        }
        while (updated is null && await reader.NextResultAsync(cancellationToken));

        if (updated is null)
        {
            throw new LedgerPostingEvidenceException("Ledger posting request status was not updated.");
        }

        await reader.DisposeAsync();
        await transaction.CommitAsync(cancellationToken);
        return updated;
    }

    private async Task<LedgerPostingRequestRecord?> FindByIdempotencyKeyAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{RequestSelect} where idempotency_key = @idempotency_key";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapRequest(reader) : null;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!Configured)
        {
            throw new LedgerPostingEvidenceException("DATABASE_URL is not configured.");
        }

        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static void AddRequestParameters(NpgsqlCommand command, LedgerPostingRequestRecord request)
    {
        command.Parameters.AddWithValue("id", request.Id);
        command.Parameters.AddWithValue("request_kind", request.RequestKind);
        command.Parameters.AddWithValue("instruction_id", request.InstructionId);
        command.Parameters.AddWithValue("instruction_type", request.InstructionType);
        command.Parameters.AddWithValue("instruction_hash", request.InstructionHash);
        command.Parameters.AddWithValue("originating_authority", request.OriginatingAuthority);
        command.Parameters.Add("settlement_record_id", NpgsqlDbType.Uuid).Value =
            (object?)request.SettlementRecordId ?? DBNull.Value;
        command.Parameters.AddWithValue("ledger_wallet_id", request.WalletId);
        command.Parameters.Add("ledger_account_id", NpgsqlDbType.Uuid).Value =
            (object?)request.LedgerAccountId ?? DBNull.Value;
        command.Parameters.AddWithValue("direction", request.Direction.ToString());
        command.Parameters.AddWithValue("amount_minor", request.Amount);
        command.Parameters.AddWithValue("currency", request.Currency);
        command.Parameters.AddWithValue("minor_unit_precision", request.MinorUnitPrecision);
        command.Parameters.AddWithValue("transaction_type", request.TransactionType.ToString());
        command.Parameters.AddWithValue("idempotency_key", request.IdempotencyKey);
        command.Parameters.AddWithValue("canonical_request_hash", request.CanonicalRequestHash);
        command.Parameters.AddWithValue("effective_at", request.EffectiveAt);
        command.Parameters.AddWithValue("accounting_posted_at", request.AccountingPostedAt);
        command.Parameters.Add("accounting_brand_id", NpgsqlDbType.Uuid).Value =
            (object?)request.AccountingBrandId ?? DBNull.Value;
        command.Parameters.Add("accounting_market_id", NpgsqlDbType.Uuid).Value =
            (object?)request.AccountingMarketId ?? DBNull.Value;
        command.Parameters.Add("original_accounting_period_id", NpgsqlDbType.Uuid).Value =
            (object?)request.OriginalAccountingPeriodId ?? DBNull.Value;
        command.Parameters.Add("posting_accounting_period_id", NpgsqlDbType.Uuid).Value =
            (object?)request.PostingAccountingPeriodId ?? DBNull.Value;
        command.Parameters.Add("original_ledger_entry_id", NpgsqlDbType.Uuid).Value =
            (object?)request.OriginalLedgerEntryId ?? DBNull.Value;
        AddNullable(command, "original_ledger_entry_hash", request.OriginalLedgerEntryHash);
        command.Parameters.AddWithValue(
            "correlation_metadata",
            JsonSerializer.Serialize(request.Metadata, JsonOptions));
        command.Parameters.AddWithValue("created_at", request.CreatedAt);
    }

    private static void AddNullable(NpgsqlCommand command, string name, string? value)
    {
        command.Parameters.Add(name, NpgsqlDbType.Text).Value = (object?)value ?? DBNull.Value;
    }

    private const string RequestColumns = """
id, request_kind, instruction_id, instruction_type, instruction_hash,
originating_authority, settlement_record_id, ledger_wallet_id, ledger_account_id,
direction, amount_minor, currency, minor_unit_precision, transaction_type,
idempotency_key, canonical_request_hash, effective_at, accounting_posted_at,
accounting_brand_id, accounting_market_id, original_accounting_period_id,
posting_accounting_period_id, original_ledger_entry_id,
original_ledger_entry_hash, request_status, created_at, completed_at, failure_code,
failure_reason, ledger_entry_id, ledger_entry_hash, journal_transaction_id,
correlation_metadata::text
""";

    private const string RequestSelect = $"""
select {RequestColumns}
from ledger_service.ledger_posting_requests
""";

    private const string AttemptSelect = """
select id, posting_request_id, attempt_number, started_at, completed_at, result,
       failure_classification, target_response_reference, response_hash,
       runtime_provenance, build_provenance, canonical_evidence_hash, created_at
from ledger_service.ledger_posting_attempts
""";

    private static LedgerPostingRequestRecord MapRequest(NpgsqlDataReader reader)
    {
        return new LedgerPostingRequestRecord(
            reader.GetGuid(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetGuid(6),
            reader.GetGuid(7),
            reader.IsDBNull(8) ? null : reader.GetGuid(8),
            Enum.Parse<LedgerDirection>(reader.GetString(9)),
            reader.GetInt64(10),
            reader.GetString(11),
            reader.GetInt32(12),
            Enum.Parse<LedgerTransactionType>(reader.GetString(13)),
            reader.GetString(14),
            reader.GetString(15),
            reader.GetFieldValue<DateTimeOffset>(16),
            reader.GetFieldValue<DateTimeOffset>(17),
            reader.IsDBNull(18) ? null : reader.GetGuid(18),
            reader.IsDBNull(19) ? null : reader.GetGuid(19),
            reader.IsDBNull(20) ? null : reader.GetGuid(20),
            reader.IsDBNull(21) ? null : reader.GetGuid(21),
            reader.IsDBNull(22) ? null : reader.GetGuid(22),
            reader.IsDBNull(23) ? null : reader.GetString(23),
            Enum.Parse<LedgerPostingRequestStatus>(reader.GetString(24)),
            reader.GetFieldValue<DateTimeOffset>(25),
            reader.IsDBNull(26) ? null : reader.GetFieldValue<DateTimeOffset>(26),
            reader.IsDBNull(27) ? null : reader.GetString(27),
            reader.IsDBNull(28) ? null : reader.GetString(28),
            reader.IsDBNull(29) ? null : reader.GetGuid(29),
            reader.IsDBNull(30) ? null : reader.GetString(30),
            reader.IsDBNull(31) ? null : reader.GetGuid(31),
            JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(32), JsonOptions) ??
                new Dictionary<string, object?>());
    }

    private static LedgerPostingAttemptRecord MapAttempt(NpgsqlDataReader reader)
    {
        return new LedgerPostingAttemptRecord(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetInt32(2),
            reader.GetFieldValue<DateTimeOffset>(3),
            reader.GetFieldValue<DateTimeOffset>(4),
            Enum.Parse<LedgerPostingAttemptResult>(reader.GetString(5)),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.GetString(9),
            reader.GetString(10),
            reader.GetString(11),
            reader.GetFieldValue<DateTimeOffset>(12));
    }

    private static LedgerReplayEvidenceRecord MapReplay(NpgsqlDataReader reader)
    {
        return new LedgerReplayEvidenceRecord(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetGuid(2),
            Enum.Parse<LedgerReplayResult>(reader.GetString(3)),
            JsonSerializer.Deserialize<string[]>(reader.GetString(4), JsonOptions) ?? [],
            reader.GetString(5),
            reader.GetString(6),
            reader.GetString(7),
            reader.GetFieldValue<DateTimeOffset>(8));
    }
}

public sealed class LedgerPostingEvidenceException : Exception
{
    public LedgerPostingEvidenceException(string message)
        : base(message)
    {
    }
}
