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
    public bool CanonicalPostingContractReady => repository.DurablePersistenceConfigured;
    public bool CanonicalHashValidationReady => repository.DurablePersistenceConfigured;
    public bool ConflictSafeIdempotencyReady => repository.DurablePersistenceConfigured;
    public bool CurrencyAccountValidationReady => repository.DurablePersistenceConfigured;
    public bool ImmutableEntryStorageReady => repository.DurablePersistenceConfigured;
    public bool ReversalOnlyCorrectionReady => repository.DurablePersistenceConfigured;
    public bool OriginalEntryValidationReady => repository.DurablePersistenceConfigured;
    public bool ReversalConflictProtectionReady => repository.DurablePersistenceConfigured;
    public bool SettlementReversalInstructionCompatible => repository.DurablePersistenceConfigured;

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
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var originalEntry = await repository.FindByIdAsync(ledgerEntryId, cancellationToken);
        if (originalEntry is null)
        {
            return null;
        }

        ValidateOriginalEntry(originalEntry, request);

        var existingReversal = await repository.FindReversalByOriginalEntryIdAsync(
            originalEntry.Id,
            cancellationToken);
        if (existingReversal is not null)
        {
            if (string.Equals(existingReversal.IdempotencyKey, idempotencyKey, StringComparison.Ordinal)
                && string.Equals(
                    existingReversal.CanonicalReversalHash,
                    request.CanonicalReversalHash,
                    StringComparison.Ordinal))
            {
                return ToDto(existingReversal);
            }

            throw new DurableLedgerReversalConflictException(
                "Ledger entry already has an immutable reversal.");
        }

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

    private static void ValidateOriginalEntry(
        DurableLedgerEntry originalEntry,
        ReverseLedgerEntryRequest request)
    {
        if (originalEntry.ReversalOfLedgerEntryId.HasValue
            || originalEntry.TransactionType == LedgerTransactionType.REVERSAL)
        {
            throw new DurableLedgerReversalConflictException(
                "A reversal entry cannot itself be reversed through the standard correction path.");
        }

        if (string.IsNullOrWhiteSpace(originalEntry.CanonicalRequestHash))
        {
            throw new DurableLedgerReversalConflictException(
                "Original ledger entry is not eligible for reversal because it has no canonical entry hash.");
        }

        if (!string.Equals(
            originalEntry.CanonicalRequestHash,
            request.OriginalLedgerEntryHash,
            StringComparison.Ordinal))
        {
            throw new DurableLedgerRepositoryException(
                "Original ledger entry hash does not match the persisted immutable entry.");
        }

        var expectedDirection = originalEntry.Direction == LedgerDirection.CREDIT
            ? LedgerDirection.DEBIT
            : LedgerDirection.CREDIT;

        if (request.WalletId != originalEntry.WalletId
            || request.LedgerAccountId != originalEntry.AccountId
            || request.Direction != expectedDirection
            || request.Money.Amount != originalEntry.Amount
            || !string.Equals(request.Money.Currency, originalEntry.CurrencyCode, StringComparison.Ordinal))
        {
            throw new DurableLedgerRepositoryException(
                "Reversal financial dimensions must exactly oppose the original ledger entry.");
        }
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
            entry.CanonicalRequestHash,
            entry.ReversalOfLedgerEntryId,
            entry.OriginalLedgerEntryHash,
            entry.ReversalReasonCode,
            entry.ReversalPolicyVersion,
            entry.CanonicalReversalHash,
            entry.Metadata,
            entry.CreatedAt);
    }
}
