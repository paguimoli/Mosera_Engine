using System.Text.Json;
using Npgsql;
using NpgsqlTypes;
using SettlementService.Configuration;

namespace SettlementService.Infrastructure;

public enum TicketCompletionStatus
{
    NotCanonical,
    Pending,
    Completed
}

public sealed record TicketCompletionResult(
    TicketCompletionStatus Status,
    Guid? TicketId,
    string? CompletionEvidence);

public sealed class TicketCompletionRepository(ServiceConfiguration configuration)
{
    private sealed record CompletionSource(
        Guid TicketItemId,
        Guid SettlementId,
        Guid LedgerExecutionAttemptId,
        Guid? LedgerPostingRequestId,
        Guid WalletExecutionAttemptId,
        Guid? WalletOperationId);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<TicketCompletionResult> TryCompleteAsync(
        Guid settlementId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var ticketId = await FindCanonicalTicketIdAsync(connection, settlementId, cancellationToken);
        if (ticketId is null)
        {
            return new TicketCompletionResult(TicketCompletionStatus.NotCanonical, null, null);
        }

        if (await HasCompletionEvidenceAsync(connection, ticketId.Value, cancellationToken))
        {
            return new TicketCompletionResult(TicketCompletionStatus.Completed, ticketId, null);
        }

        var sources = await LoadCompletionSourcesAsync(connection, ticketId.Value, cancellationToken);
        if (sources is null)
        {
            return new TicketCompletionResult(TicketCompletionStatus.Pending, ticketId, null);
        }

        await using var command = connection.CreateCommand();
        command.CommandText = """
select ticket_completion_authority.complete_ticket(
  @ticket_id,
  @sources,
  @idempotency_key,
  'settlement-service',
  @correlation_id,
  @causation_id
)::text;
""";
        command.Parameters.Add("ticket_id", NpgsqlDbType.Uuid).Value = ticketId.Value;
        command.Parameters.Add("sources", NpgsqlDbType.Jsonb).Value = JsonSerializer.Serialize(
            sources.Select(source => new
            {
                source.TicketItemId,
                source.SettlementId,
                source.LedgerExecutionAttemptId,
                source.LedgerPostingRequestId,
                source.WalletExecutionAttemptId,
                source.WalletOperationId
            }),
            JsonOptions);
        command.Parameters.Add("idempotency_key", NpgsqlDbType.Text).Value = $"ticket-financial-completion:{ticketId:N}";
        command.Parameters.Add("correlation_id", NpgsqlDbType.Text).Value = correlationId;
        command.Parameters.Add("causation_id", NpgsqlDbType.Text).Value = settlementId.ToString("D");

        var evidence = (string?)await command.ExecuteScalarAsync(cancellationToken)
            ?? throw new InvalidOperationException("Ticket Completion Authority returned no evidence.");
        return new TicketCompletionResult(TicketCompletionStatus.Completed, ticketId, evidence);
    }

    private static async Task<Guid?> FindCanonicalTicketIdAsync(
        NpgsqlConnection connection,
        Guid settlementId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select ticket.ticket_id
from settlement_service.authoritative_settlement_records settlement
join ticket_authority.tickets ticket
  on settlement.ticket_id = ticket.ticket_id::text
where settlement.settlement_id = @settlement_id;
""";
        command.Parameters.Add("settlement_id", NpgsqlDbType.Uuid).Value = settlementId;
        return await command.ExecuteScalarAsync(cancellationToken) is Guid ticketId ? ticketId : null;
    }

    private static async Task<bool> HasCompletionEvidenceAsync(
        NpgsqlConnection connection,
        Guid ticketId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select exists (
  select 1
  from ticket_completion_authority.completion_evidence
  where ticket_id = @ticket_id
);
""";
        command.Parameters.Add("ticket_id", NpgsqlDbType.Uuid).Value = ticketId;
        return await command.ExecuteScalarAsync(cancellationToken) is true;
    }

    private static async Task<IReadOnlyList<CompletionSource>?> LoadCompletionSourcesAsync(
        NpgsqlConnection connection,
        Guid ticketId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  item.ticket_item_id,
  settlement.source_count settlement_count,
  settlement.settlement_id,
  ledger_attempt.source_count ledger_count,
  ledger_attempt.attempt_id ledger_attempt_id,
  ledger_request.id posting_request_id,
  wallet_attempt.source_count wallet_count,
  wallet_attempt.attempt_id wallet_attempt_id,
  wallet_operation.operation_id
from ticket_authority.ticket_items item
left join lateral (
  select count(*)::integer source_count,
         (array_agg(record.settlement_id order by record.issued_at))[1] settlement_id
  from settlement_service.authoritative_settlement_records record
  where record.ticket_id = item.ticket_id::text
    and record.ticket_line_id = item.ticket_item_id::text
) settlement on true
left join lateral (
  select count(*)::integer source_count,
         (array_agg(attempt.attempt_id order by attempt.created_at))[1] attempt_id,
         (array_agg(attempt.external_reference_id order by attempt.created_at))[1] external_reference_id
  from settlement_service.financial_instruction_execution_attempts attempt
  where attempt.settlement_id = settlement.settlement_id
    and attempt.target_service = 'ledger-service'
    and attempt.status in ('Posted', 'Skipped')
) ledger_attempt on true
left join ledger_service.ledger_posting_requests ledger_request
  on ledger_request.id = case
       when ledger_attempt.external_reference_id ~* '^[0-9a-f-]{36}$'
       then ledger_attempt.external_reference_id::uuid
     end
left join lateral (
  select count(*)::integer source_count,
         (array_agg(attempt.attempt_id order by attempt.created_at))[1] attempt_id,
         (array_agg(attempt.external_reference_id order by attempt.created_at))[1] external_reference_id
  from settlement_service.financial_instruction_execution_attempts attempt
  where attempt.settlement_id = settlement.settlement_id
    and attempt.target_service = 'credit-wallet-service'
    and attempt.status in ('Posted', 'Skipped')
) wallet_attempt on true
left join credit_wallet_service.wallet_operation_requests wallet_operation
  on wallet_operation.operation_id = case
       when wallet_attempt.external_reference_id ~* '^[0-9a-f-]{36}$'
       then wallet_attempt.external_reference_id::uuid
     end
where item.ticket_id = @ticket_id
order by item.ticket_item_id;
""";
        command.Parameters.Add("ticket_id", NpgsqlDbType.Uuid).Value = ticketId;

        var sources = new List<CompletionSource>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var settlementCount = reader.GetInt32(reader.GetOrdinal("settlement_count"));
            var ledgerCount = reader.GetInt32(reader.GetOrdinal("ledger_count"));
            var walletCount = reader.GetInt32(reader.GetOrdinal("wallet_count"));
            if (settlementCount > 1 || ledgerCount > 1 || walletCount > 1)
            {
                throw new InvalidOperationException(
                    "Ticket Completion Authority found ambiguous financial evidence for a ticket item.");
            }

            if (settlementCount == 0 || ledgerCount == 0 || walletCount == 0)
            {
                return null;
            }

            sources.Add(new CompletionSource(
                reader.GetGuid(reader.GetOrdinal("ticket_item_id")),
                reader.GetGuid(reader.GetOrdinal("settlement_id")),
                reader.GetGuid(reader.GetOrdinal("ledger_attempt_id")),
                reader.IsDBNull(reader.GetOrdinal("posting_request_id"))
                    ? null
                    : reader.GetGuid(reader.GetOrdinal("posting_request_id")),
                reader.GetGuid(reader.GetOrdinal("wallet_attempt_id")),
                reader.IsDBNull(reader.GetOrdinal("operation_id"))
                    ? null
                    : reader.GetGuid(reader.GetOrdinal("operation_id"))));
        }

        return sources.Count == 0 ? null : sources;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(configuration.Database.Url))
        {
            throw new InvalidOperationException("DATABASE_URL is not configured for Ticket Completion Authority.");
        }

        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}
