using LedgerService.Configuration;
using Npgsql;

namespace LedgerService.Infrastructure;

public sealed record LedgerAccountingPeriodContext(
    Guid? BrandId,
    Guid? MarketId,
    DateTimeOffset AccountingPostedAt,
    Guid? OriginalAccountingPeriodId,
    Guid? PostingAccountingPeriodId);

public sealed class LedgerAccountingPeriodException(string message) : Exception(message);

public sealed class LedgerAccountingPeriodRepository(ServiceConfiguration configuration)
{
    public bool Configured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<LedgerAccountingPeriodContext> ResolveAsync(
        Guid walletId,
        Guid? requestedMarketId,
        DateTimeOffset businessEffectiveAt,
        DateTimeOffset? requestedAccountingPostedAt,
        CancellationToken cancellationToken)
    {
        var accountingPostedAt = (requestedAccountingPostedAt ?? DateTimeOffset.UtcNow).ToUniversalTime();
        await using var connection = await OpenAsync(cancellationToken);

        var brandId = await FindWalletBrandAsync(connection, walletId, cancellationToken);
        if (!brandId.HasValue && requestedMarketId.HasValue)
        {
            brandId = await FindMarketBrandAsync(connection, requestedMarketId.Value, cancellationToken)
                ?? throw new LedgerAccountingPeriodException(
                    "Accounting market is unknown or is not part of an active platform hierarchy.");
        }

        if (!brandId.HasValue)
        {
            return new(null, null, accountingPostedAt, null, null);
        }

        var marketId = requestedMarketId;
        if (marketId.HasValue)
        {
            var marketBrand = await FindMarketBrandAsync(connection, marketId.Value, cancellationToken);
            if (marketBrand != brandId)
            {
                throw new LedgerAccountingPeriodException(
                    "Accounting market does not belong to the Ledger wallet brand scope.");
            }
        }
        else
        {
            var markets = await ListPeriodMarketsAsync(connection, brandId.Value, cancellationToken);
            if (markets.Count == 0)
            {
                return new(brandId, null, accountingPostedAt, null, null);
            }
            if (markets.Count > 1)
            {
                throw new LedgerAccountingPeriodException(
                    "Accounting market is required when a brand has multiple weekly period scopes.");
            }
            marketId = markets[0];
        }

        var original = await FindPeriodAsync(
            connection, brandId.Value, marketId.Value, businessEffectiveAt, cancellationToken);
        var posting = await FindPeriodAsync(
            connection, brandId.Value, marketId.Value, accountingPostedAt, cancellationToken);
        if (posting is null)
        {
            throw new LedgerAccountingPeriodException(
                "No weekly accounting period covers the requested accounting posting time.");
        }
        if (!string.Equals(posting.Value.Status, "OPEN", StringComparison.Ordinal))
        {
            throw new LedgerAccountingPeriodException(
                "Ledger postings cannot be recorded directly in a closed weekly accounting period.");
        }

        return new(brandId, marketId, accountingPostedAt, original?.PeriodId, posting.Value.PeriodId);
    }

    private static async Task<Guid?> FindWalletBrandAsync(
        NpgsqlConnection connection,
        Guid walletId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "select brand_id from credit_wallet_service.wallet_scopes where wallet_id = @wallet_id";
        command.Parameters.AddWithValue("wallet_id", walletId);
        return await command.ExecuteScalarAsync(cancellationToken) is Guid value ? value : null;
    }

    private static async Task<Guid?> FindMarketBrandAsync(
        NpgsqlConnection connection,
        Guid marketId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "select brand_id from platform.markets where id = @market_id";
        command.Parameters.AddWithValue("market_id", marketId);
        return await command.ExecuteScalarAsync(cancellationToken) is Guid value ? value : null;
    }

    private static async Task<IReadOnlyList<Guid>> ListPeriodMarketsAsync(
        NpgsqlConnection connection,
        Guid brandId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select distinct market_id
from ledger_service.weekly_accounting_periods
where brand_id = @brand_id
order by market_id;
""";
        command.Parameters.AddWithValue("brand_id", brandId);
        var values = new List<Guid>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) values.Add(reader.GetGuid(0));
        return values;
    }

    private static async Task<(Guid PeriodId, string Status)?> FindPeriodAsync(
        NpgsqlConnection connection,
        Guid brandId,
        Guid marketId,
        DateTimeOffset timestamp,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select period_id, status
from ledger_service.weekly_accounting_periods
where brand_id = @brand_id and market_id = @market_id
  and period_start_at <= @timestamp and period_end_at > @timestamp
order by period_start_at desc
limit 1;
""";
        command.Parameters.AddWithValue("brand_id", brandId);
        command.Parameters.AddWithValue("market_id", marketId);
        command.Parameters.AddWithValue("timestamp", timestamp);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? (reader.GetGuid(0), reader.GetString(1))
            : null;
    }

    private async Task<NpgsqlConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}
