using System.Text.Json;
using LedgerService.Configuration;
using LedgerService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace LedgerService.Infrastructure;

public sealed record DurableLedgerEntry(
    Guid Id,
    Guid WalletId,
    Guid AccountId,
    LedgerTransactionType TransactionType,
    LedgerDirection Direction,
    long Amount,
    long BalanceAfter,
    string CurrencyCode,
    string? ReferenceType,
    string? ReferenceId,
    string? IdempotencyKey,
    Guid? ReversalOfLedgerEntryId,
    IReadOnlyDictionary<string, object?> Metadata,
    DateTimeOffset CreatedAt);

public sealed record DurableLedgerPage(
    IReadOnlyList<DurableLedgerEntry> Entries,
    string? NextCursor);

public sealed class DurableLedgerRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ServiceConfiguration configuration;

    public DurableLedgerRepository(ServiceConfiguration configuration)
    {
        this.configuration = configuration;
    }

    public bool DurablePersistenceConfigured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<DurableLedgerEntry> PostEntryAsync(
        CreateLedgerEntryRequest request,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from public.post_financial_ledger_entry(
  @wallet_id,
  @transaction_type,
  @direction,
  @amount,
  @reference_type,
  @reference_id,
  @idempotency_key,
  cast(@metadata as jsonb),
  @reversal_of_ledger_entry_id
);
""";
        command.Parameters.AddWithValue("wallet_id", request.WalletId);
        command.Parameters.AddWithValue("transaction_type", request.TransactionType.ToString());
        command.Parameters.AddWithValue("direction", request.Direction.ToString());
        command.Parameters.AddWithValue("amount", request.Money.Amount);
        command.Parameters.Add("reference_type", NpgsqlDbType.Text).Value =
            (object?)request.Reference?.Type ?? DBNull.Value;
        command.Parameters.Add("reference_id", NpgsqlDbType.Text).Value =
            (object?)request.Reference?.Id ?? DBNull.Value;
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        command.Parameters.AddWithValue(
            "metadata",
            NpgsqlDbType.Jsonb,
            JsonSerializer.Serialize(request.Metadata ?? new Dictionary<string, object?>(), JsonOptions));
        command.Parameters.Add("reversal_of_ledger_entry_id", NpgsqlDbType.Uuid).Value = DBNull.Value;

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new DurableLedgerRepositoryException("Ledger posting did not return a ledger entry.");
        }

        return MapEntry(reader);
    }

    public async Task<DurableLedgerEntry> ReverseEntryAsync(
        DurableLedgerEntry originalEntry,
        ReverseLedgerEntryRequest request,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var metadata = request.Metadata is null
            ? new Dictionary<string, object?>()
            : new Dictionary<string, object?>(request.Metadata);
        metadata["reason"] = request.Reason;
        metadata["actorUserId"] = request.ActorUserId;
        metadata["reversedTransactionType"] = originalEntry.TransactionType.ToString();
        metadata["reversedLedgerEntryId"] = originalEntry.Id;

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from public.post_financial_ledger_entry(
  @wallet_id,
  @transaction_type,
  @direction,
  @amount,
  @reference_type,
  @reference_id,
  @idempotency_key,
  cast(@metadata as jsonb),
  @reversal_of_ledger_entry_id
);
""";
        command.Parameters.AddWithValue("wallet_id", originalEntry.WalletId);
        command.Parameters.AddWithValue("transaction_type", LedgerTransactionType.REVERSAL.ToString());
        command.Parameters.AddWithValue(
            "direction",
            originalEntry.Direction == LedgerDirection.CREDIT
                ? LedgerDirection.DEBIT.ToString()
                : LedgerDirection.CREDIT.ToString());
        command.Parameters.AddWithValue("amount", originalEntry.Amount);
        command.Parameters.AddWithValue("reference_type", "ledger_entry");
        command.Parameters.AddWithValue("reference_id", originalEntry.Id.ToString());
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        command.Parameters.AddWithValue(
            "metadata",
            NpgsqlDbType.Jsonb,
            JsonSerializer.Serialize(metadata, JsonOptions));
        command.Parameters.AddWithValue("reversal_of_ledger_entry_id", originalEntry.Id);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new DurableLedgerRepositoryException("Ledger reversal did not return a ledger entry.");
        }

        return MapEntry(reader);
    }

    public async Task<DurableLedgerEntry?> FindByIdAsync(Guid ledgerEntryId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"{SelectSql} where id = @id";
        command.Parameters.AddWithValue("id", ledgerEntryId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapEntry(reader) : null;
    }

    public async Task<DurableLedgerPage> ListByAccountAsync(
        Guid accountId,
        int limit,
        int offset,
        bool ascending,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText =
            $"{SelectSql} where account_id = @account_id order by created_at {(ascending ? "asc" : "desc")}, id {(ascending ? "asc" : "desc")} limit @limit offset @offset";
        command.Parameters.AddWithValue("account_id", accountId);
        command.Parameters.AddWithValue("limit", limit + 1);
        command.Parameters.AddWithValue("offset", offset);

        var entries = new List<DurableLedgerEntry>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            entries.Add(MapEntry(reader));
        }

        var hasNext = entries.Count > limit;
        if (hasNext)
        {
            entries.RemoveAt(entries.Count - 1);
        }

        return new DurableLedgerPage(entries, hasNext ? (offset + limit).ToString() : null);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            throw new DurableLedgerRepositoryException("DATABASE_URL is not configured.");
        }

        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private const string SelectSql = """
select id,
       wallet_id,
       account_id,
       transaction_type,
       direction,
       amount,
       balance_after,
       currency_code,
       reference_type,
       reference_id,
       idempotency_key,
       reversal_of_ledger_entry_id,
       metadata::text,
       created_at
from public.financial_ledger_entries
""";

    private static DurableLedgerEntry MapEntry(NpgsqlDataReader reader)
    {
        return new DurableLedgerEntry(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetGuid(2),
            Enum.Parse<LedgerTransactionType>(reader.GetString(3)),
            Enum.Parse<LedgerDirection>(reader.GetString(4)),
            Convert.ToInt64(reader.GetDecimal(5)),
            Convert.ToInt64(reader.GetDecimal(6)),
            reader.GetString(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.IsDBNull(9) ? null : reader.GetString(9),
            reader.IsDBNull(10) ? null : reader.GetString(10),
            reader.IsDBNull(11) ? null : reader.GetGuid(11),
            JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(12), JsonOptions) ??
                new Dictionary<string, object?>(),
            reader.GetFieldValue<DateTimeOffset>(13));
    }
}

public sealed class DurableLedgerRepositoryException : Exception
{
    public DurableLedgerRepositoryException(string message)
        : base(message)
    {
    }
}
