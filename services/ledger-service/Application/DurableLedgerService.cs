using LedgerService.Contracts;
using LedgerService.Infrastructure;
using Npgsql;

namespace LedgerService.Application;

public sealed class DurableLedgerService
{
    private readonly DurableLedgerRepository repository;

    public DurableLedgerService(DurableLedgerRepository repository)
    {
        this.repository = repository;
    }

    public bool MutationCapabilityEnabled => repository.DurablePersistenceConfigured;
    public bool DurablePersistenceConfigured => repository.DurablePersistenceConfigured;
    public bool IdempotencySupportConfigured => repository.DurablePersistenceConfigured;

    public async Task<LedgerEntryDto> PostEntryAsync(
        CreateLedgerEntryRequest request,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var entry = await repository.PostEntryAsync(request, idempotencyKey, cancellationToken);
        return ToDto(entry);
    }

    public async Task<LedgerEntryDto?> FindEntryAsync(Guid ledgerEntryId, CancellationToken cancellationToken)
    {
        var entry = await repository.FindByIdAsync(ledgerEntryId, cancellationToken);
        return entry is null ? null : ToDto(entry);
    }

    public async Task<LedgerEntryDto?> ReverseEntryAsync(
        Guid ledgerEntryId,
        ReverseLedgerEntryRequest request,
        CancellationToken cancellationToken)
    {
        var originalEntry = await repository.FindByIdAsync(ledgerEntryId, cancellationToken);
        if (originalEntry is null)
        {
            return null;
        }

        var idempotencyKey = CreateReversalIdempotencyKey(originalEntry.Id);
        var reversalEntry = await repository.ReverseEntryAsync(
            originalEntry,
            request,
            idempotencyKey,
            cancellationToken);

        return ToDto(reversalEntry);
    }

    public async Task<(IReadOnlyList<LedgerEntryDto> Entries, string? NextCursor)> ListAccountEntriesAsync(
        Guid accountId,
        int limit,
        string? cursor,
        string? sort,
        CancellationToken cancellationToken)
    {
        var offset = ParseCursor(cursor);
        var ascending = string.Equals(sort, "createdAt.asc", StringComparison.Ordinal);
        var page = await repository.ListByAccountAsync(accountId, limit, offset, ascending, cancellationToken);

        return (page.Entries.Select(ToDto).ToArray(), page.NextCursor);
    }

    public static bool IsBusinessRuleError(Exception error)
    {
        return error is PostgresException postgresError && new[]
        {
            "Ledger amount must be positive.",
            "Ledger transaction type is invalid.",
            "Ledger direction is invalid.",
            "Wallet not found.",
            "Wallet is not active.",
            "duplicate key value violates unique constraint"
        }.Any(message => postgresError.MessageText.Contains(message, StringComparison.OrdinalIgnoreCase));
    }

    public static string CreateReversalIdempotencyKey(Guid ledgerEntryId)
    {
        return $"ledger-reversal:{ledgerEntryId:N}";
    }

    private static int ParseCursor(string? cursor)
    {
        if (string.IsNullOrWhiteSpace(cursor))
        {
            return 0;
        }

        return int.TryParse(cursor, out var offset) && offset >= 0 ? offset : 0;
    }

    private static LedgerEntryDto ToDto(DurableLedgerEntry entry)
    {
        return new LedgerEntryDto(
            entry.Id,
            entry.WalletId,
            entry.AccountId,
            entry.TransactionType,
            entry.Direction,
            new MoneyDto(entry.Amount, entry.CurrencyCode),
            new MoneyDto(entry.BalanceAfter, entry.CurrencyCode),
            entry.ReferenceType is null && entry.ReferenceId is null
                ? null
                : new LedgerReferenceDto(entry.ReferenceType, entry.ReferenceId),
            entry.IdempotencyKey,
            entry.ReversalOfLedgerEntryId,
            entry.Metadata,
            entry.CreatedAt);
    }
}
