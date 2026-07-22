using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgerService.Application;
using LedgerService.Configuration;
using LedgerService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace LedgerService.Infrastructure;

public sealed record LedgerJournalEntryRecord(
    Guid Id,
    Guid TransactionId,
    Guid AccountId,
    Guid? WalletId,
    string AccountClass,
    long DebitAmount,
    long CreditAmount,
    string Currency,
    LedgerDirection Direction,
    short PostingSequence,
    Guid? ReversalOfEntryId,
    string CanonicalEntryHash,
    IReadOnlyDictionary<string, object?> Provenance,
    DateTimeOffset CreatedAt);

public sealed record LedgerJournalTransactionRecord(
    Guid Id,
    string TransactionHash,
    string OriginatingAuthority,
    string InstructionId,
    string InstructionHash,
    Guid PostingRequestId,
    Guid SourceLedgerEntryId,
    LedgerTransactionType TransactionType,
    string Currency,
    DateTimeOffset EffectiveAt,
    string IdempotencyKey,
    string CanonicalTransactionHash,
    string PostingRuleId,
    string PostingRuleVersion,
    Guid? ReversesTransactionId,
    IReadOnlyDictionary<string, object?> Provenance,
    DateTimeOffset CreatedAt,
    IReadOnlyList<LedgerJournalEntryRecord> Entries);

public sealed class LedgerJournalRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly IReadOnlySet<string> SubjectAccountRoles =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "PLAYER_LIABILITY", "AGENT_PAYABLE", "FREE_PLAY_LIABILITY"
        };
    private readonly ServiceConfiguration configuration;

    public LedgerJournalRepository(ServiceConfiguration configuration)
    {
        this.configuration = configuration;
    }

    public bool Configured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<LedgerJournalTransactionRecord> EnsureAndVerifyAsync(
        LedgerPostingRequestRecord request,
        DurableLedgerEntry sourceEntry,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var databaseTransaction = await connection.BeginTransactionAsync(cancellationToken);

        await LockPostingRequestAsync(connection, databaseTransaction, request.Id, cancellationToken);
        var existing = await FindByPostingRequestAsync(
            connection,
            databaseTransaction,
            request.Id,
            cancellationToken);
        if (existing is not null)
        {
            Verify(request, sourceEntry, existing);
            await databaseTransaction.CommitAsync(cancellationToken);
            return existing;
        }

        LedgerJournalTransactionRecord? original = null;
        if (request.OriginalLedgerEntryId.HasValue)
        {
            original = await FindBySourceEntryAsync(
                connection,
                databaseTransaction,
                request.OriginalLedgerEntryId.Value,
                cancellationToken) ?? throw new LedgerJournalException(
                    "Original Ledger transaction is missing for the reversal journal.");
        }

        var journal = BuildJournal(request, sourceEntry, original);
        await InsertTransactionAsync(connection, databaseTransaction, journal, cancellationToken);
        foreach (var entry in journal.Entries)
        {
            await InsertEntryAsync(connection, databaseTransaction, entry, cancellationToken);
        }

        Verify(request, sourceEntry, journal);
        await databaseTransaction.CommitAsync(cancellationToken);
        return journal;
    }

    public async Task<LedgerJournalTransactionRecord?> FindByPostingRequestAsync(
        Guid postingRequestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await FindByPostingRequestAsync(
            connection,
            null,
            postingRequestId,
            cancellationToken);
    }

    public async Task<LedgerJournalTransactionRecord> VerifyAsync(
        LedgerPostingRequestRecord request,
        DurableLedgerEntry sourceEntry,
        CancellationToken cancellationToken)
    {
        var journal = await FindByPostingRequestAsync(request.Id, cancellationToken)
            ?? throw new LedgerJournalException("Balanced Ledger transaction is missing.");
        Verify(request, sourceEntry, journal);
        return journal;
    }

    private static LedgerJournalTransactionRecord BuildJournal(
        LedgerPostingRequestRecord request,
        DurableLedgerEntry sourceEntry,
        LedgerJournalTransactionRecord? original)
    {
        var transactionId = DeterministicGuid($"ledger-journal:{request.Id:D}");
        var ruleId = MetadataString(request.Metadata, "postingRuleId")
            ?? FinancialPostingRuleIds.LegacyRuleId;
        var ruleVersion = MetadataString(request.Metadata, "postingRuleVersion")
            ?? FinancialPostingRuleIds.LegacyRuleVersion;
        var debitRole = MetadataString(request.Metadata, "debitAccountRole")
            ?? (sourceEntry.Direction == LedgerDirection.DEBIT ? "PLAYER_LIABILITY" : "OPERATOR_CLEARING");
        var creditRole = MetadataString(request.Metadata, "creditAccountRole")
            ?? (sourceEntry.Direction == LedgerDirection.CREDIT ? "PLAYER_LIABILITY" : "OPERATOR_CLEARING");
        var provenance = new Dictionary<string, object?>
        {
            ["canonicalRequestHash"] = request.CanonicalRequestHash,
            ["journalModel"] = "minimal-balanced-journal-v1",
            ["postingRuleId"] = ruleId,
            ["postingRuleVersion"] = ruleVersion,
            ["sourceLedgerEntryId"] = sourceEntry.Id.ToString("D"),
            ["businessEffectiveAt"] = request.EffectiveAt.ToUniversalTime().ToString("O"),
            ["accountingPostedAt"] = request.AccountingPostedAt.ToUniversalTime().ToString("O"),
            ["originalAccountingPeriodId"] = request.OriginalAccountingPeriodId?.ToString("D"),
            ["postingAccountingPeriodId"] = request.PostingAccountingPeriodId?.ToString("D")
        };
        LedgerJournalEntryRecord[] entries;
        if (original is not null)
        {
            ruleId = original.PostingRuleId;
            ruleVersion = original.PostingRuleVersion;
            entries = original.Entries.OrderBy(entry => entry.PostingSequence).Select(entry => BuildEntry(
                transactionId,
                entry.PostingSequence,
                entry.AccountId,
                entry.WalletId,
                entry.AccountClass,
                entry.CreditAmount,
                entry.DebitAmount,
                entry.Currency,
                entry.Direction == LedgerDirection.DEBIT ? LedgerDirection.CREDIT : LedgerDirection.DEBIT,
                entry.Id,
                provenance)).ToArray();
        }
        else
        {
            entries =
            [
                BuildEntry(transactionId, 1, ResolveAccountId(debitRole, sourceEntry),
                    ResolveWalletId(debitRole, sourceEntry), debitRole, sourceEntry.Amount, 0,
                    sourceEntry.CurrencyCode, LedgerDirection.DEBIT, null, provenance),
                BuildEntry(transactionId, 2, ResolveAccountId(creditRole, sourceEntry),
                    ResolveWalletId(creditRole, sourceEntry), creditRole, 0, sourceEntry.Amount,
                    sourceEntry.CurrencyCode, LedgerDirection.CREDIT, null, provenance)
            ];
        }
        var canonicalTransactionHash = CanonicalLedgerRequestHasher.ComputeEvidenceHash(
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["currency"] = request.Currency,
                ["effectiveAt"] = ToPostgresTimestamp(request.EffectiveAt).ToString("O"),
                ["idempotencyKey"] = request.IdempotencyKey,
                ["instructionHash"] = request.InstructionHash,
                ["instructionId"] = request.InstructionId,
                ["originatingAuthority"] = request.OriginatingAuthority,
                ["postingRequestId"] = request.Id.ToString("D"),
                ["postingRuleId"] = ruleId,
                ["postingRuleVersion"] = ruleVersion,
                ["reversesTransactionId"] = original?.Id.ToString("D"),
                ["sourceLedgerEntryId"] = sourceEntry.Id.ToString("D"),
                ["transactionType"] = request.TransactionType.ToString()
            });
        var transactionHash = CanonicalLedgerRequestHasher.ComputeEvidenceHash(
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["canonicalTransactionHash"] = canonicalTransactionHash,
                ["entryHashes"] = entries.OrderBy(entry => entry.PostingSequence)
                    .Select(entry => entry.CanonicalEntryHash).ToArray()
            });

        return new LedgerJournalTransactionRecord(
            transactionId,
            transactionHash,
            request.OriginatingAuthority,
            request.InstructionId,
            request.InstructionHash,
            request.Id,
            sourceEntry.Id,
            request.TransactionType,
            request.Currency,
            ToPostgresTimestamp(request.EffectiveAt),
            request.IdempotencyKey,
            canonicalTransactionHash,
            ruleId,
            ruleVersion,
            original?.Id,
            provenance,
            DateTimeOffset.UtcNow,
            entries);
    }

    private static LedgerJournalEntryRecord BuildEntry(
        Guid transactionId,
        short sequence,
        Guid accountId,
        Guid? walletId,
        string accountClass,
        long debitAmount,
        long creditAmount,
        string currency,
        LedgerDirection direction,
        Guid? reversalOfEntryId,
        IReadOnlyDictionary<string, object?> provenance)
    {
        var entryId = DeterministicGuid($"ledger-journal-entry:{transactionId:D}:{sequence}");
        var hash = CanonicalLedgerRequestHasher.ComputeEvidenceHash(
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["accountClass"] = accountClass,
                ["accountId"] = accountId.ToString("D"),
                ["creditAmount"] = creditAmount,
                ["currency"] = currency,
                ["debitAmount"] = debitAmount,
                ["direction"] = direction.ToString(),
                ["entryId"] = entryId.ToString("D"),
                ["postingSequence"] = sequence,
                ["reversalOfEntryId"] = reversalOfEntryId?.ToString("D"),
                ["transactionId"] = transactionId.ToString("D"),
                ["walletId"] = walletId?.ToString("D")
            });
        return new LedgerJournalEntryRecord(
            entryId,
            transactionId,
            accountId,
            walletId,
            accountClass,
            debitAmount,
            creditAmount,
            currency,
            direction,
            sequence,
            reversalOfEntryId,
            hash,
            provenance,
            DateTimeOffset.UtcNow);
    }

    private static void Verify(
        LedgerPostingRequestRecord request,
        DurableLedgerEntry sourceEntry,
        LedgerJournalTransactionRecord journal)
    {
        var mismatches = new List<string>();
        if (journal.PostingRequestId != request.Id) mismatches.Add("posting request");
        if (journal.SourceLedgerEntryId != sourceEntry.Id) mismatches.Add("source Ledger entry");
        if (!string.Equals(journal.InstructionId, request.InstructionId, StringComparison.Ordinal)) mismatches.Add("instruction id");
        if (!string.Equals(journal.InstructionHash, request.InstructionHash, StringComparison.Ordinal)) mismatches.Add("instruction hash");
        if (!string.Equals(journal.OriginatingAuthority, request.OriginatingAuthority, StringComparison.Ordinal)) mismatches.Add("originating authority");
        if (journal.TransactionType != request.TransactionType) mismatches.Add("transaction type");
        if (!string.Equals(journal.Currency, request.Currency, StringComparison.Ordinal)) mismatches.Add("currency");
        if (!string.Equals(journal.IdempotencyKey, request.IdempotencyKey, StringComparison.Ordinal)) mismatches.Add("idempotency key");
        if (string.IsNullOrWhiteSpace(journal.PostingRuleId) || string.IsNullOrWhiteSpace(journal.PostingRuleVersion)) mismatches.Add("posting rule binding");
        if (ToPostgresTimestamp(journal.EffectiveAt) != ToPostgresTimestamp(request.EffectiveAt)) mismatches.Add("effective timestamp");
        if (journal.Entries.Count != 2) mismatches.Add("entry count");
        if (journal.Entries.Any(entry => entry.TransactionId != journal.Id)) mismatches.Add("entry transaction ownership");
        if (journal.Entries.Any(entry => !string.Equals(entry.Currency, journal.Currency, StringComparison.Ordinal))) mismatches.Add("entry currency");
        if (journal.Entries.Sum(entry => entry.DebitAmount) != journal.Entries.Sum(entry => entry.CreditAmount)) mismatches.Add("debit/credit balance");

        var expected = BuildJournal(request, sourceEntry, ResolveOriginalShape(journal));
        if (!string.Equals(journal.CanonicalTransactionHash, expected.CanonicalTransactionHash, StringComparison.Ordinal)) mismatches.Add("canonical transaction hash");
        if (!string.Equals(journal.TransactionHash, expected.TransactionHash, StringComparison.Ordinal)) mismatches.Add("transaction hash");
        if (!journal.Entries.OrderBy(entry => entry.PostingSequence).Select(entry => entry.CanonicalEntryHash)
            .SequenceEqual(expected.Entries.OrderBy(entry => entry.PostingSequence).Select(entry => entry.CanonicalEntryHash), StringComparer.Ordinal))
        {
            mismatches.Add("canonical entry hashes");
        }

        if (mismatches.Count > 0)
        {
            throw new LedgerJournalException(
                $"Balanced Ledger journal verification failed: {string.Join(", ", mismatches)}.");
        }
    }

    private static LedgerJournalTransactionRecord? ResolveOriginalShape(LedgerJournalTransactionRecord journal)
    {
        if (!journal.ReversesTransactionId.HasValue)
        {
            return null;
        }

        var originalEntries = journal.Entries.Select(entry => entry with
        {
            Id = entry.ReversalOfEntryId ?? Guid.Empty,
            DebitAmount = entry.CreditAmount,
            CreditAmount = entry.DebitAmount,
            Direction = entry.Direction == LedgerDirection.DEBIT
                ? LedgerDirection.CREDIT
                : LedgerDirection.DEBIT,
            ReversalOfEntryId = null
        }).ToArray();
        return journal with { Id = journal.ReversesTransactionId.Value, Entries = originalEntries };
    }

    private static async Task LockPostingRequestAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid requestId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "select id from ledger_service.ledger_posting_requests where id = @id for update";
        command.Parameters.AddWithValue("id", requestId);
        if (await command.ExecuteScalarAsync(cancellationToken) is null)
        {
            throw new LedgerJournalException("Ledger posting request does not exist.");
        }
    }

    private static async Task InsertTransactionAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        LedgerJournalTransactionRecord journal,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into ledger_service.ledger_transactions (
  id, transaction_hash, originating_authority, instruction_id, instruction_hash,
  posting_request_id, source_ledger_entry_id, transaction_type, currency,
  effective_at, idempotency_key, canonical_transaction_hash, posting_rule_id, posting_rule_version,
  reverses_transaction_id, provenance, created_at
)
values (
  @id, @transaction_hash, @originating_authority, @instruction_id, @instruction_hash,
  @posting_request_id, @source_ledger_entry_id, @transaction_type, @currency,
  @effective_at, @idempotency_key, @canonical_transaction_hash, @posting_rule_id, @posting_rule_version,
  @reverses_transaction_id, cast(@provenance as jsonb), @created_at
);
""";
        command.Parameters.AddWithValue("id", journal.Id);
        command.Parameters.AddWithValue("transaction_hash", journal.TransactionHash);
        command.Parameters.AddWithValue("originating_authority", journal.OriginatingAuthority);
        command.Parameters.AddWithValue("instruction_id", journal.InstructionId);
        command.Parameters.AddWithValue("instruction_hash", journal.InstructionHash);
        command.Parameters.AddWithValue("posting_request_id", journal.PostingRequestId);
        command.Parameters.AddWithValue("source_ledger_entry_id", journal.SourceLedgerEntryId);
        command.Parameters.AddWithValue("transaction_type", journal.TransactionType.ToString());
        command.Parameters.AddWithValue("currency", journal.Currency);
        command.Parameters.AddWithValue("effective_at", journal.EffectiveAt);
        command.Parameters.AddWithValue("idempotency_key", journal.IdempotencyKey);
        command.Parameters.AddWithValue("canonical_transaction_hash", journal.CanonicalTransactionHash);
        command.Parameters.AddWithValue("posting_rule_id", journal.PostingRuleId);
        command.Parameters.AddWithValue("posting_rule_version", journal.PostingRuleVersion);
        command.Parameters.Add("reverses_transaction_id", NpgsqlDbType.Uuid).Value =
            (object?)journal.ReversesTransactionId ?? DBNull.Value;
        command.Parameters.AddWithValue("provenance", JsonSerializer.Serialize(journal.Provenance, JsonOptions));
        command.Parameters.AddWithValue("created_at", journal.CreatedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task InsertEntryAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        LedgerJournalEntryRecord entry,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into ledger_service.ledger_entries (
  id, transaction_id, account_id, wallet_id, account_class, debit_amount,
  credit_amount, currency, direction, posting_sequence, reversal_of_entry_id,
  canonical_entry_hash, provenance, created_at
)
values (
  @id, @transaction_id, @account_id, @wallet_id, @account_class, @debit_amount,
  @credit_amount, @currency, @direction, @posting_sequence, @reversal_of_entry_id,
  @canonical_entry_hash, cast(@provenance as jsonb), @created_at
);
""";
        command.Parameters.AddWithValue("id", entry.Id);
        command.Parameters.AddWithValue("transaction_id", entry.TransactionId);
        command.Parameters.AddWithValue("account_id", entry.AccountId);
        command.Parameters.Add("wallet_id", NpgsqlDbType.Uuid).Value = (object?)entry.WalletId ?? DBNull.Value;
        command.Parameters.AddWithValue("account_class", entry.AccountClass);
        command.Parameters.AddWithValue("debit_amount", entry.DebitAmount);
        command.Parameters.AddWithValue("credit_amount", entry.CreditAmount);
        command.Parameters.AddWithValue("currency", entry.Currency);
        command.Parameters.AddWithValue("direction", entry.Direction.ToString());
        command.Parameters.AddWithValue("posting_sequence", entry.PostingSequence);
        command.Parameters.Add("reversal_of_entry_id", NpgsqlDbType.Uuid).Value =
            (object?)entry.ReversalOfEntryId ?? DBNull.Value;
        command.Parameters.AddWithValue("canonical_entry_hash", entry.CanonicalEntryHash);
        command.Parameters.AddWithValue("provenance", JsonSerializer.Serialize(entry.Provenance, JsonOptions));
        command.Parameters.AddWithValue("created_at", entry.CreatedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<LedgerJournalTransactionRecord?> FindByPostingRequestAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        Guid postingRequestId,
        CancellationToken cancellationToken)
    {
        return await FindAsync(
            connection,
            transaction,
            "posting_request_id = @value",
            postingRequestId,
            cancellationToken);
    }

    private static async Task<LedgerJournalTransactionRecord?> FindBySourceEntryAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        Guid sourceEntryId,
        CancellationToken cancellationToken)
    {
        return await FindAsync(
            connection,
            transaction,
            "source_ledger_entry_id = @value",
            sourceEntryId,
            cancellationToken);
    }

    private static async Task<LedgerJournalTransactionRecord?> FindAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        string predicate,
        Guid value,
        CancellationToken cancellationToken)
    {
        LedgerJournalTransactionRecord? header;
        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = $"""
select id, transaction_hash, originating_authority, instruction_id, instruction_hash,
       posting_request_id, source_ledger_entry_id, transaction_type, currency,
       effective_at, idempotency_key, canonical_transaction_hash, posting_rule_id, posting_rule_version,
       reverses_transaction_id, provenance::text, created_at
from ledger_service.ledger_transactions
where {predicate};
""";
            command.Parameters.AddWithValue("value", value);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                return null;
            }

            header = new LedgerJournalTransactionRecord(
                reader.GetGuid(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetGuid(5),
                reader.GetGuid(6),
                Enum.Parse<LedgerTransactionType>(reader.GetString(7)),
                reader.GetString(8),
                reader.GetFieldValue<DateTimeOffset>(9),
                reader.GetString(10),
                reader.GetString(11),
                reader.GetString(12),
                reader.GetString(13),
                reader.IsDBNull(14) ? null : reader.GetGuid(14),
                Deserialize(reader.GetString(15)),
                reader.GetFieldValue<DateTimeOffset>(16),
                Array.Empty<LedgerJournalEntryRecord>());
        }

        var entries = new List<LedgerJournalEntryRecord>();
        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
select id, transaction_id, account_id, wallet_id, account_class, debit_amount,
       credit_amount, currency, direction, posting_sequence, reversal_of_entry_id,
       canonical_entry_hash, provenance::text, created_at
from ledger_service.ledger_entries
where transaction_id = @transaction_id
order by posting_sequence;
""";
            command.Parameters.AddWithValue("transaction_id", header.Id);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                entries.Add(new LedgerJournalEntryRecord(
                    reader.GetGuid(0),
                    reader.GetGuid(1),
                    reader.GetGuid(2),
                    reader.IsDBNull(3) ? null : reader.GetGuid(3),
                    reader.GetString(4),
                    reader.GetInt64(5),
                    reader.GetInt64(6),
                    reader.GetString(7),
                    Enum.Parse<LedgerDirection>(reader.GetString(8)),
                    reader.GetInt16(9),
                    reader.IsDBNull(10) ? null : reader.GetGuid(10),
                    reader.GetString(11),
                    Deserialize(reader.GetString(12)),
                    reader.GetFieldValue<DateTimeOffset>(13)));
            }
        }

        return header with { Entries = entries };
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!Configured)
        {
            throw new LedgerJournalException("DATABASE_URL is not configured for balanced journals.");
        }

        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static Guid ResolveAccountId(string accountRole, DurableLedgerEntry sourceEntry)
    {
        return SubjectAccountRoles.Contains(accountRole)
            ? sourceEntry.AccountId
            : DeterministicGuid($"ledger-account-role:{accountRole}");
    }

    private static Guid? ResolveWalletId(string accountRole, DurableLedgerEntry sourceEntry)
    {
        return SubjectAccountRoles.Contains(accountRole) ? sourceEntry.WalletId : null;
    }

    private static string? MetadataString(IReadOnlyDictionary<string, object?> metadata, string key)
    {
        if (!metadata.TryGetValue(key, out var value) || value is null) return null;
        return value is JsonElement element && element.ValueKind == JsonValueKind.String
            ? element.GetString()
            : value.ToString();
    }

    private static IReadOnlyDictionary<string, object?> Deserialize(string json)
    {
        return JsonSerializer.Deserialize<Dictionary<string, object?>>(json, JsonOptions)
            ?? new Dictionary<string, object?>();
    }

    private static Guid DeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        var id = bytes[..16];
        id[6] = (byte)((id[6] & 0x0f) | 0x50);
        id[8] = (byte)((id[8] & 0x3f) | 0x80);
        return new Guid(id);
    }

    private static DateTimeOffset ToPostgresTimestamp(DateTimeOffset value)
    {
        var utc = value.ToUniversalTime();
        return new DateTimeOffset(utc.Ticks - (utc.Ticks % 10), TimeSpan.Zero);
    }
}

public sealed class LedgerJournalException : Exception
{
    public LedgerJournalException(string message)
        : base(message)
    {
    }
}
