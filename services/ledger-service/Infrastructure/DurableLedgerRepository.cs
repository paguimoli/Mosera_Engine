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
    string? CanonicalRequestHash,
    Guid? ReversalOfLedgerEntryId,
    string? OriginalLedgerEntryHash,
    string? ReversalReasonCode,
    string? ReversalPolicyVersion,
    string? CanonicalReversalHash,
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
        var postingFunction = request.TransactionType is LedgerTransactionType.AGENT_COMMISSION_ACCRUAL
            or LedgerTransactionType.PLAYER_REBATE_CREDIT
            or LedgerTransactionType.PROMOTIONAL_CREDIT
            ? "public.post_catalog_financial_ledger_entry"
            : "public.post_financial_ledger_entry";
        command.CommandText = $"""
{SelectColumns}
from {postingFunction}(
  @wallet_id,
  @transaction_type,
  @direction,
  @amount,
  @reference_type,
  @reference_id,
  @idempotency_key,
  cast(@metadata as jsonb),
  @reversal_of_ledger_entry_id,
  @canonical_request_hash,
  @original_ledger_entry_hash,
  @reversal_reason_code,
  @reversal_policy_version,
  @canonical_reversal_hash
);
""";
        command.Parameters.AddWithValue("wallet_id", request.WalletId);
        await ValidateWalletAsync(connection, request, cancellationToken);
        command.Parameters.AddWithValue("transaction_type", request.TransactionType.ToString());
        command.Parameters.AddWithValue("direction", request.Direction.ToString());
        command.Parameters.AddWithValue("amount", request.Money.Amount);
        command.Parameters.Add("reference_type", NpgsqlDbType.Text).Value =
            (object?)request.Reference?.Type ?? DBNull.Value;
        command.Parameters.Add("reference_id", NpgsqlDbType.Text).Value =
            (object?)request.Reference?.Id ?? DBNull.Value;
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        var metadata = request.Metadata is null
            ? new Dictionary<string, object?>()
            : new Dictionary<string, object?>(request.Metadata);
        metadata["instructionId"] = request.InstructionId;
        metadata["instructionType"] = request.InstructionType;
        metadata["instructionHash"] = request.InstructionHash;
        metadata["originatingAuthority"] = request.OriginatingAuthority;
        metadata["effectiveAt"] = request.EffectiveAt;

        command.Parameters.AddWithValue(
            "metadata",
            NpgsqlDbType.Jsonb,
            JsonSerializer.Serialize(metadata, JsonOptions));
        command.Parameters.Add("reversal_of_ledger_entry_id", NpgsqlDbType.Uuid).Value =
            (object?)request.ReversalOfLedgerEntryId ?? DBNull.Value;
        command.Parameters.AddWithValue("canonical_request_hash", request.CanonicalRequestHash);
        command.Parameters.Add("original_ledger_entry_hash", NpgsqlDbType.Text).Value = DBNull.Value;
        command.Parameters.Add("reversal_reason_code", NpgsqlDbType.Text).Value = DBNull.Value;
        command.Parameters.Add("reversal_policy_version", NpgsqlDbType.Text).Value = DBNull.Value;
        command.Parameters.Add("canonical_reversal_hash", NpgsqlDbType.Text).Value = DBNull.Value;

        await using var reader = await ExecuteReaderAsync(command, cancellationToken);
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
        metadata["reasonCode"] = request.ReasonCode;
        metadata["reversalPolicyVersion"] = request.ReversalPolicyVersion;
        metadata["actorUserId"] = request.ActorUserId;
        metadata["reversedTransactionType"] = originalEntry.TransactionType.ToString();
        metadata["reversedLedgerEntryId"] = originalEntry.Id;
        metadata["originalLedgerEntryHash"] = request.OriginalLedgerEntryHash;
        metadata["instructionId"] = request.InstructionId;
        metadata["instructionType"] = request.InstructionType;
        metadata["instructionHash"] = request.InstructionHash;
        metadata["originatingAuthority"] = request.OriginatingAuthority;
        metadata["effectiveAt"] = request.EffectiveAt;

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
{SelectColumns}
from public.post_financial_ledger_entry(
  @wallet_id,
  @transaction_type,
  @direction,
  @amount,
  @reference_type,
  @reference_id,
  @idempotency_key,
  cast(@metadata as jsonb),
  @reversal_of_ledger_entry_id,
  @canonical_request_hash,
  @original_ledger_entry_hash,
  @reversal_reason_code,
  @reversal_policy_version,
  @canonical_reversal_hash
);
""";
        command.Parameters.AddWithValue("wallet_id", request.WalletId);
        command.Parameters.AddWithValue("transaction_type", LedgerTransactionType.REVERSAL.ToString());
        command.Parameters.AddWithValue(
            "direction",
            originalEntry.Direction == LedgerDirection.CREDIT
                ? LedgerDirection.DEBIT.ToString()
                : LedgerDirection.CREDIT.ToString());
        command.Parameters.AddWithValue("amount", request.Money.Amount);
        command.Parameters.AddWithValue("reference_type", "ledger_entry");
        command.Parameters.AddWithValue("reference_id", originalEntry.Id.ToString());
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        command.Parameters.AddWithValue(
            "metadata",
            NpgsqlDbType.Jsonb,
            JsonSerializer.Serialize(metadata, JsonOptions));
        command.Parameters.AddWithValue("reversal_of_ledger_entry_id", originalEntry.Id);
        command.Parameters.AddWithValue("canonical_request_hash", request.CanonicalReversalHash);
        command.Parameters.AddWithValue("original_ledger_entry_hash", request.OriginalLedgerEntryHash);
        command.Parameters.AddWithValue("reversal_reason_code", request.ReasonCode);
        command.Parameters.AddWithValue("reversal_policy_version", request.ReversalPolicyVersion);
        command.Parameters.AddWithValue("canonical_reversal_hash", request.CanonicalReversalHash);

        await using var reader = await ExecuteReaderAsync(command, cancellationToken);
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

    public async Task<DurableLedgerEntry?> FindByIdempotencyKeyAsync(
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"{SelectSql} where idempotency_key = @idempotency_key";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapEntry(reader) : null;
    }

    public async Task<DurableLedgerEntry?> FindReversalByOriginalEntryIdAsync(
        Guid originalLedgerEntryId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText =
            $"{SelectSql} where reversal_of_ledger_entry_id = @original_ledger_entry_id";
        command.Parameters.AddWithValue("original_ledger_entry_id", originalLedgerEntryId);

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

    private const string SelectColumns = """
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
       canonical_request_hash,
       reversal_of_ledger_entry_id,
       original_ledger_entry_hash,
       reversal_reason_code,
       reversal_policy_version,
       canonical_reversal_hash,
       metadata::text,
       created_at
""";

    private const string SelectSql = $"""
{SelectColumns}
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
            reader.IsDBNull(11) ? null : reader.GetString(11),
            reader.IsDBNull(12) ? null : reader.GetGuid(12),
            reader.IsDBNull(13) ? null : reader.GetString(13),
            reader.IsDBNull(14) ? null : reader.GetString(14),
            reader.IsDBNull(15) ? null : reader.GetString(15),
            reader.IsDBNull(16) ? null : reader.GetString(16),
            JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(17), JsonOptions) ??
                new Dictionary<string, object?>(),
            reader.GetFieldValue<DateTimeOffset>(18));
    }

    private static async Task<NpgsqlDataReader> ExecuteReaderAsync(
        NpgsqlCommand command,
        CancellationToken cancellationToken)
    {
        try
        {
            return await command.ExecuteReaderAsync(cancellationToken);
        }
        catch (PostgresException error) when (
            error.MessageText.Contains("Ledger idempotency conflict.", StringComparison.OrdinalIgnoreCase))
        {
            throw new DurableLedgerIdempotencyConflictException(error.MessageText, error);
        }
        catch (PostgresException error) when (
            error.MessageText.Contains("Ledger reversal conflict.", StringComparison.OrdinalIgnoreCase)
            || error.ConstraintName == "financial_ledger_entries_one_reversal_per_original")
        {
            throw new DurableLedgerReversalConflictException(
                "Ledger entry already has an immutable reversal.",
                error);
        }
    }

    private static async Task ValidateWalletAsync(
        NpgsqlConnection connection,
        CreateLedgerEntryRequest request,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select wallet.account_id,
       wallet.currency_code,
       wallet.status,
       account.status
from public.financial_wallets wallet
join public.accounts account on account.id = wallet.account_id
where wallet.id = @wallet_id;
""";
        command.Parameters.AddWithValue("wallet_id", request.WalletId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new DurableLedgerRepositoryException("Wallet not found.");
        }

        var accountId = reader.GetGuid(0);
        var walletCurrency = reader.GetString(1);
        var walletStatus = reader.GetString(2);
        var accountStatus = reader.GetString(3);

        if (request.LedgerAccountId.HasValue && request.LedgerAccountId.Value != accountId)
        {
            throw new DurableLedgerRepositoryException("Ledger account does not match wallet account.");
        }

        if (!string.Equals(walletCurrency, request.Money.Currency, StringComparison.Ordinal))
        {
            throw new DurableLedgerRepositoryException("Ledger request currency does not match wallet currency.");
        }

        if (!string.Equals(walletStatus, "ACTIVE", StringComparison.Ordinal))
        {
            throw new DurableLedgerRepositoryException("Wallet is not active.");
        }

        if (!string.Equals(accountStatus, "ACTIVE", StringComparison.Ordinal))
        {
            throw new DurableLedgerRepositoryException("Account is not active.");
        }
    }
}

public sealed class DurableLedgerRepositoryException : Exception
{
    public DurableLedgerRepositoryException(string message)
        : base(message)
    {
    }
}

public sealed class DurableLedgerIdempotencyConflictException : Exception
{
    public DurableLedgerIdempotencyConflictException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

public sealed class DurableLedgerReversalConflictException : Exception
{
    public DurableLedgerReversalConflictException(string message)
        : base(message)
    {
    }

    public DurableLedgerReversalConflictException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
