using System.Text.Json;
using CreditWalletService.Configuration;
using CreditWalletService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace CreditWalletService.Infrastructure;

public sealed class DurableCreditWalletRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ServiceConfiguration configuration;

    public DurableCreditWalletRepository(ServiceConfiguration configuration)
    {
        this.configuration = configuration;
    }

    public bool DurablePersistenceConfigured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<CreditReservationDto> ReserveAsync(
        Guid playerId,
        ReserveExposureRequest request,
        string idempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from public.reserve_credit_exposure(
  @player_id,
  @ticket_id,
  @amount,
  @currency,
  @idempotency_key,
  @correlation_id,
  cast(@metadata as jsonb)
);
""";
        command.Parameters.AddWithValue("player_id", playerId);
        command.Parameters.AddWithValue("ticket_id", request.TicketId.ToString());
        command.Parameters.AddWithValue("amount", request.Amount.Amount);
        command.Parameters.AddWithValue("currency", request.Amount.Currency);
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        command.Parameters.AddWithValue("correlation_id", correlationId);
        command.Parameters.AddWithValue(
            "metadata",
            NpgsqlDbType.Jsonb,
            JsonSerializer.Serialize(request.Metadata ?? new Dictionary<string, object?>(), JsonOptions));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new DurableCreditWalletRepositoryException("Credit reservation did not return a reservation.");
        }

        return MapReservation(reader);
    }

    public async Task<CreditReservationDto> ReleaseAsync(
        Guid playerId,
        ReleaseExposureRequest request,
        string idempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var existingReservation = await FindReservationByIdAsync(request.ReservationId, cancellationToken);
        if (existingReservation is not null && existingReservation.PlayerId != playerId)
        {
            throw new DurableCreditWalletDomainException(
                CreditWalletErrorCodes.InvalidRelease,
                "Credit reservation does not belong to the requested player.");
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from public.release_credit_exposure(
  @reservation_id,
  @ticket_id,
  @release_amount,
  @idempotency_key,
  @correlation_id,
  @reason,
  cast(@metadata as jsonb)
);
""";
        command.Parameters.AddWithValue("reservation_id", request.ReservationId);
        command.Parameters.AddWithValue("ticket_id", request.TicketId.ToString());
        command.Parameters.AddWithValue("release_amount", request.ReleaseAmount.Amount);
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        command.Parameters.AddWithValue("correlation_id", correlationId);
        command.Parameters.Add("reason", NpgsqlDbType.Text).Value =
            string.IsNullOrWhiteSpace(request.ReasonCode) ? DBNull.Value : request.ReasonCode;
        command.Parameters.AddWithValue(
            "metadata",
            NpgsqlDbType.Jsonb,
            JsonSerializer.Serialize(request.Metadata ?? new Dictionary<string, object?>(), JsonOptions));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new DurableCreditWalletRepositoryException("Credit release did not return a reservation.");
        }

        var reservation = MapReservation(reader);
        if (reservation.PlayerId != playerId)
        {
            throw new DurableCreditWalletDomainException(
                CreditWalletErrorCodes.InvalidRelease,
                "Credit reservation does not belong to the requested player.");
        }

        return reservation;
    }

    public async Task<CreditSettlementApplicationDto> SettleAsync(
        Guid playerId,
        SettleCreditRequest request,
        string idempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var existingReservation = await FindReservationByIdAsync(request.ReservationId, cancellationToken);
        if (existingReservation is not null && existingReservation.PlayerId != playerId)
        {
            throw new DurableCreditWalletDomainException(
                CreditWalletErrorCodes.InvalidSettlement,
                "Credit reservation does not belong to the requested player.");
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from public.apply_credit_settlement(
  @player_id,
  @reservation_id,
  @ticket_id,
  @settlement_id,
  @settlement_batch_id,
  @release_amount,
  @balance_impact,
  @currency,
  @outcome,
  @idempotency_key,
  @correlation_id,
  cast(@metadata as jsonb)
);
""";
        command.Parameters.AddWithValue("player_id", playerId);
        command.Parameters.AddWithValue("reservation_id", request.ReservationId);
        command.Parameters.AddWithValue("ticket_id", request.TicketId.ToString());
        command.Parameters.AddWithValue("settlement_id", request.SettlementId.ToString());
        command.Parameters.AddWithValue("settlement_batch_id", request.SettlementBatchId.ToString());
        command.Parameters.AddWithValue("release_amount", request.ReleaseAmount.Amount);
        command.Parameters.AddWithValue("balance_impact", request.BalanceImpact.Amount);
        command.Parameters.AddWithValue("currency", request.ReleaseAmount.Currency);
        command.Parameters.AddWithValue("outcome", request.Outcome.ToString());
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        command.Parameters.AddWithValue("correlation_id", correlationId);
        command.Parameters.AddWithValue(
            "metadata",
            NpgsqlDbType.Jsonb,
            JsonSerializer.Serialize(request.Metadata ?? new Dictionary<string, object?>(), JsonOptions));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new DurableCreditWalletRepositoryException("Credit settlement did not return an application.");
        }

        var application = MapSettlementApplication(reader);
        if (application.PlayerId != playerId)
        {
            throw new DurableCreditWalletDomainException(
                CreditWalletErrorCodes.InvalidSettlement,
                "Credit settlement application does not belong to the requested player.");
        }

        return application;
    }

    public async Task<CreditWalletSummaryDto?> GetSummaryAsync(
        Guid playerId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "select public.get_player_credit_summary(@player_id);";
        command.Parameters.AddWithValue("player_id", playerId);

        var result = await command.ExecuteScalarAsync(cancellationToken);
        if (result is null or DBNull)
        {
            return null;
        }

        using var document = JsonDocument.Parse(result.ToString() ?? "{}");
        var root = document.RootElement;
        var walletId = Guid.Parse(GetJsonString(root, "walletId"));
        var resolvedPlayerId = Guid.Parse(GetJsonString(root, "playerId"));
        var currency = GetJsonString(root, "currency");

        return new CreditWalletSummaryDto(
            resolvedPlayerId,
            walletId,
            new MoneyDto(GetJsonInt64(root, "creditLimit"), currency),
            new MoneyDto(GetJsonInt64(root, "balance"), currency),
            new MoneyDto(GetJsonInt64(root, "pendingExposure"), currency),
            new MoneyDto(GetJsonInt64(root, "availableCredit"), currency),
            CreditWalletStatus.ACTIVE,
            HierarchyModel.NORTH_AMERICAN,
            correlationId);
    }

    public async Task<CreditExposureDto?> GetExposureAsync(
        Guid playerId,
        bool includeReservations,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var summary = await GetSummaryAsync(playerId, correlationId, cancellationToken);
        if (summary is null)
        {
            return null;
        }

        var reservations = includeReservations
            ? await ListOpenReservationsAsync(summary.PlayerId, cancellationToken)
            : Array.Empty<CreditExposureReservationDto>();

        return new CreditExposureDto(
            summary.PlayerId,
            summary.PendingExposure,
            reservations,
            correlationId);
    }

    public async Task<CreditWalletTransactionsDto?> ListTransactionsAsync(
        Guid playerId,
        int limit,
        int offset,
        bool ascending,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var summary = await GetSummaryAsync(playerId, correlationId, cancellationToken);
        if (summary is null)
        {
            return null;
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
select id::text,
       transaction_type,
       ticket_id,
       amount,
       status,
       reference_id,
       correlation_id,
       created_at
from (
  select id,
         'RESERVATION' as transaction_type,
         ticket_id,
         reserved_amount as amount,
         status,
         id::text as reference_id,
         correlation_id,
         created_at
  from public.credit_reservations
  where player_id = @player_id
  union all
  select id,
         'RELEASE' as transaction_type,
         ticket_id,
         release_amount as amount,
         'RELEASED' as status,
         reservation_id::text as reference_id,
         correlation_id,
         created_at
  from public.credit_reservation_releases
  where reservation_id in (
    select id from public.credit_reservations where player_id = @player_id
  )
  union all
  select id,
         'SETTLEMENT' as transaction_type,
         ticket_id,
         balance_impact as amount,
         operation_type as status,
         settlement_id as reference_id,
         correlation_id,
         created_at
  from public.credit_settlement_applications
  where player_id = @player_id
) transactions
order by created_at {(ascending ? "asc" : "desc")}, id {(ascending ? "asc" : "desc")}
limit @limit offset @offset;
""";
        command.Parameters.AddWithValue("player_id", summary.PlayerId);
        command.Parameters.AddWithValue("limit", limit + 1);
        command.Parameters.AddWithValue("offset", offset);

        var transactions = new List<CreditWalletTransactionDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            transactions.Add(MapTransaction(reader, summary.Balance.Currency));
        }

        var hasNext = transactions.Count > limit;
        if (hasNext)
        {
            transactions.RemoveAt(transactions.Count - 1);
        }

        var nextCursor = hasNext ? (offset + limit).ToString() : null;
        return new CreditWalletTransactionsDto(
            summary.PlayerId,
            transactions,
            new PaginationDto(limit, nextCursor),
            correlationId);
    }

    public async Task<CreditWalletReconciliationDto?> GetReconciliationAsync(
        Guid playerId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var summary = await GetSummaryAsync(playerId, correlationId, cancellationToken);
        if (summary is null)
        {
            return null;
        }

        var reservations = await ListReconciliationReservationsAsync(summary.PlayerId, cancellationToken);
        var settlements = await ListReconciliationSettlementApplicationsAsync(summary.PlayerId, cancellationToken);
        var discrepancies = DetectDiscrepancies(summary, reservations, settlements);

        return new CreditWalletReconciliationDto(
            summary.PlayerId,
            summary.CreditWalletId,
            summary.Balance,
            summary.PendingExposure,
            summary.AvailableCredit,
            reservations,
            settlements,
            discrepancies,
            correlationId,
            DateTimeOffset.UtcNow);
    }

    public async Task<CreditReservationDto?> FindReservationByIdAsync(
        Guid reservationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select id,
       player_id,
       ticket_id,
       amount,
       currency,
       status,
       reserved_amount,
       released_amount,
       settled_amount,
       remaining_exposure,
       idempotency_key,
       correlation_id,
       created_at,
       updated_at,
       released_at,
       settled_at,
       cancelled_at
from public.credit_reservations
where id = @reservation_id;
""";
        command.Parameters.AddWithValue("reservation_id", reservationId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapReservation(reader) : null;
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

    private async Task<IReadOnlyList<CreditExposureReservationDto>> ListOpenReservationsAsync(
        Guid playerId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select id,
       ticket_id,
       amount,
       currency,
       remaining_exposure,
       status,
       correlation_id,
       created_at
from public.credit_reservations
where player_id = @player_id
  and status in ('RESERVED', 'PARTIALLY_RELEASED')
order by created_at asc, id asc;
""";
        command.Parameters.AddWithValue("player_id", playerId);

        var reservations = new List<CreditExposureReservationDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            reservations.Add(new CreditExposureReservationDto(
                reader.GetGuid(0),
                reader.GetString(1),
                new MoneyDto(GetInt64(reader, 2), reader.GetString(3)),
                new MoneyDto(GetInt64(reader, 4), reader.GetString(3)),
                reader.GetString(5),
                reader.IsDBNull(6) ? null : reader.GetString(6),
                reader.GetFieldValue<DateTimeOffset>(7)));
        }

        return reservations;
    }

    private async Task<IReadOnlyList<CreditReconciliationReservationDto>> ListReconciliationReservationsAsync(
        Guid playerId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select id,
       ticket_id,
       reserved_amount,
       released_amount,
       settled_amount,
       remaining_exposure,
       currency,
       status,
       created_at
from public.credit_reservations
where player_id = @player_id
order by created_at asc, id asc;
""";
        command.Parameters.AddWithValue("player_id", playerId);

        var reservations = new List<CreditReconciliationReservationDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var currency = reader.GetString(6);
            reservations.Add(new CreditReconciliationReservationDto(
                reader.GetGuid(0),
                reader.GetString(1),
                new MoneyDto(GetInt64(reader, 2), currency),
                new MoneyDto(GetInt64(reader, 3), currency),
                new MoneyDto(GetInt64(reader, 4), currency),
                new MoneyDto(GetInt64(reader, 5), currency),
                reader.GetString(7),
                reader.GetFieldValue<DateTimeOffset>(8)));
        }

        return reservations;
    }

    private async Task<IReadOnlyList<CreditReconciliationSettlementApplicationDto>> ListReconciliationSettlementApplicationsAsync(
        Guid playerId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select id,
       reservation_id,
       ticket_id,
       settlement_id,
       release_amount,
       balance_impact,
       balance_before,
       balance_after,
       currency,
       operation_type,
       created_at
from public.credit_settlement_applications
where player_id = @player_id
order by created_at asc, id asc;
""";
        command.Parameters.AddWithValue("player_id", playerId);

        var settlements = new List<CreditReconciliationSettlementApplicationDto>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var currency = reader.GetString(8);
            settlements.Add(new CreditReconciliationSettlementApplicationDto(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetString(2),
                reader.GetString(3),
                new MoneyDto(GetInt64(reader, 4), currency),
                new MoneyDto(GetInt64(reader, 5), currency),
                new MoneyDto(GetInt64(reader, 6), currency),
                new MoneyDto(GetInt64(reader, 7), currency),
                reader.GetString(9),
                reader.GetFieldValue<DateTimeOffset>(10)));
        }

        return settlements;
    }

    private static IReadOnlyList<CreditReconciliationDiscrepancyDto> DetectDiscrepancies(
        CreditWalletSummaryDto summary,
        IReadOnlyList<CreditReconciliationReservationDto> reservations,
        IReadOnlyList<CreditReconciliationSettlementApplicationDto> settlements)
    {
        var discrepancies = new List<CreditReconciliationDiscrepancyDto>();
        var openExposure = reservations
            .Where(reservation => reservation.Status is "RESERVED" or "PARTIALLY_RELEASED")
            .Sum(reservation => reservation.RemainingExposure.Amount);
        var expectedAvailable = summary.CreditLimit.Amount + summary.Balance.Amount - openExposure;

        if (openExposure != summary.PendingExposure.Amount)
        {
            discrepancies.Add(new CreditReconciliationDiscrepancyDto(
                "PENDING_EXPOSURE_MISMATCH",
                "ERROR",
                "Summary pending exposure does not match open reservation exposure.",
                new Dictionary<string, object?>
                {
                    ["summaryPendingExposure"] = summary.PendingExposure.Amount,
                    ["computedPendingExposure"] = openExposure
                }));
        }

        if (expectedAvailable != summary.AvailableCredit.Amount)
        {
            discrepancies.Add(new CreditReconciliationDiscrepancyDto(
                "AVAILABLE_CREDIT_MISMATCH",
                "ERROR",
                "Summary available credit does not match computed available credit.",
                new Dictionary<string, object?>
                {
                    ["summaryAvailableCredit"] = summary.AvailableCredit.Amount,
                    ["computedAvailableCredit"] = expectedAvailable
                }));
        }

        foreach (var reservation in reservations)
        {
            var expectedRemaining = reservation.ReservedAmount.Amount
                - reservation.ReleasedAmount.Amount
                - reservation.SettledAmount.Amount;

            if (expectedRemaining != reservation.RemainingExposure.Amount)
            {
                discrepancies.Add(new CreditReconciliationDiscrepancyDto(
                    "RESERVATION_EXPOSURE_MISMATCH",
                    "ERROR",
                    "Reservation remaining exposure does not match reserved minus released minus settled.",
                    new Dictionary<string, object?>
                    {
                        ["reservationId"] = reservation.ReservationId,
                        ["computedRemainingExposure"] = expectedRemaining,
                        ["remainingExposure"] = reservation.RemainingExposure.Amount
                    }));
            }
        }

        foreach (var settlement in settlements)
        {
            var expectedBalanceAfter = settlement.BalanceBefore.Amount + settlement.BalanceImpact.Amount;
            if (expectedBalanceAfter != settlement.BalanceAfter.Amount)
            {
                discrepancies.Add(new CreditReconciliationDiscrepancyDto(
                    "SETTLEMENT_BALANCE_MISMATCH",
                    "ERROR",
                    "Settlement application balance_after does not match balance_before plus balance_impact.",
                    new Dictionary<string, object?>
                    {
                        ["settlementApplicationId"] = settlement.SettlementApplicationId,
                        ["computedBalanceAfter"] = expectedBalanceAfter,
                        ["balanceAfter"] = settlement.BalanceAfter.Amount
                    }));
            }
        }

        return discrepancies;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            throw new DurableCreditWalletRepositoryException("DATABASE_URL is not configured.");
        }

        var connection = new NpgsqlConnection(
            PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static CreditWalletTransactionDto MapTransaction(NpgsqlDataReader reader, string currency)
    {
        return new CreditWalletTransactionDto(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            new MoneyDto(GetInt64(reader, 3), currency),
            reader.GetString(4),
            reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.GetFieldValue<DateTimeOffset>(7));
    }

    private static CreditReservationDto MapReservation(NpgsqlDataReader reader)
    {
        var currency = reader.GetString(4);

        return new CreditReservationDto(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetString(2),
            new MoneyDto(GetInt64(reader, 3), currency),
            new MoneyDto(GetInt64(reader, 6), currency),
            new MoneyDto(GetInt64(reader, 7), currency),
            new MoneyDto(GetInt64(reader, 8), currency),
            new MoneyDto(GetInt64(reader, 9), currency),
            reader.GetString(5),
            reader.GetString(10),
            reader.IsDBNull(11) ? null : reader.GetString(11),
            reader.GetFieldValue<DateTimeOffset>(12),
            reader.IsDBNull(13) ? null : reader.GetFieldValue<DateTimeOffset>(13),
            reader.IsDBNull(14) ? null : reader.GetFieldValue<DateTimeOffset>(14),
            reader.IsDBNull(15) ? null : reader.GetFieldValue<DateTimeOffset>(15),
            reader.IsDBNull(16) ? null : reader.GetFieldValue<DateTimeOffset>(16));
    }

    private static CreditSettlementApplicationDto MapSettlementApplication(NpgsqlDataReader reader)
    {
        var currency = reader.GetString(8);

        return new CreditSettlementApplicationDto(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetGuid(2),
            reader.GetString(3),
            reader.GetString(4),
            new MoneyDto(GetInt64(reader, 5), currency),
            new MoneyDto(GetInt64(reader, 6), currency),
            new MoneyDto(GetInt64(reader, 7), currency),
            new MoneyDto(GetInt64(reader, 9), currency),
            reader.GetString(10),
            reader.GetString(11),
            reader.IsDBNull(12) ? null : reader.GetString(12),
            reader.GetFieldValue<DateTimeOffset>(13));
    }

    private static long GetInt64(NpgsqlDataReader reader, int ordinal)
    {
        var value = reader.GetValue(ordinal);

        return value switch
        {
            long longValue => longValue,
            int intValue => intValue,
            decimal decimalValue => decimal.ToInt64(decimalValue),
            _ => Convert.ToInt64(value)
        };
    }

    private static string GetJsonString(JsonElement root, string propertyName)
    {
        return root.GetProperty(propertyName).GetString()
            ?? throw new DurableCreditWalletRepositoryException($"{propertyName} was missing from credit summary.");
    }

    private static long GetJsonInt64(JsonElement root, string propertyName)
    {
        var property = root.GetProperty(propertyName);

        return property.ValueKind == JsonValueKind.Number
            ? property.GetInt64()
            : long.Parse(property.GetString() ?? "0");
    }
}

public sealed class DurableCreditWalletRepositoryException : Exception
{
    public DurableCreditWalletRepositoryException(string message)
        : base(message)
    {
    }
}

public sealed class DurableCreditWalletDomainException : Exception
{
    public DurableCreditWalletDomainException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    public string Code { get; }
}
