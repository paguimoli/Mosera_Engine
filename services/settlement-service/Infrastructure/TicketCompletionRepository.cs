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

public sealed class TicketCompletionEvidenceConflictException(string message)
    : InvalidOperationException(message);

public sealed class TicketCompletionValidationException(string message, Exception innerException)
    : InvalidOperationException(message, innerException);

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

        string? evidence;
        try
        {
            evidence = (string?)await command.ExecuteScalarAsync(cancellationToken);
        }
        catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.RaiseException)
        {
            throw new TicketCompletionValidationException(
                $"Ticket Completion Authority rejected financial evidence: {error.MessageText}",
                error);
        }

        evidence = evidence
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
  settlement.canonical settlement_canonical,
  ledger_attempt.source_count ledger_count,
  ledger_attempt.attempt_id ledger_attempt_id,
  ledger_request.id posting_request_id,
  wallet_attempt.source_count wallet_count,
  wallet_attempt.attempt_id wallet_attempt_id,
  wallet_operation.operation_id
from ticket_authority.ticket_items item
join ticket_authority.tickets ticket
  on ticket.ticket_id = item.ticket_id
left join game_engine.hot_spot_multi_draw_participations participation
  on participation.ticket_item_id = item.ticket_item_id
left join game_engine.hot_spot_multi_draw_participation_events participation_cancellation
  on participation_cancellation.participation_id = participation.participation_id
 and participation_cancellation.event_type = 'CANCELLED'
left join lateral (
  with candidates as (
    select
      record.settlement_id,
      record.issued_at,
      version.outcome_version_id is not null as canonical
    from settlement_service.authoritative_settlement_records record
    left join game_engine.outcome_settlement_requests outcome_request
      on outcome_request.settlement_request_id = record.settlement_request_id
    left join game_engine.canonical_outcome_versions version
      on version.outcome_version_id = outcome_request.outcome_version_id
     and version.outcome_certificate_id = record.outcome_certificate_id
     and version.outcome_certificate_hash = record.outcome_certificate_hash
     and version.draw_id = coalesce(participation.draw_id, ticket.draw_id)
     and not exists (
       select 1
       from game_engine.canonical_outcome_versions successor
       where successor.previous_outcome_version_id = version.outcome_version_id
     )
    where record.ticket_id = item.ticket_id::text
      and (
        record.ticket_line_id = item.ticket_item_id::text
        or exists (
          select 1
          from game_engine.ticket_draw_settlement_aggregate_items aggregate_item
          join game_engine.ticket_draw_settlement_aggregates aggregate
            on aggregate.settlement_input_id = aggregate_item.settlement_input_id
          where aggregate_item.settlement_input_id = record.settlement_input_id
            and aggregate_item.ticket_item_id = item.ticket_item_id
            and aggregate.ticket_id = item.ticket_id
            and aggregate.draw_id = coalesce(participation.draw_id, ticket.draw_id)
        )
      )
  ), ranked as (
    select candidates.*, bool_or(canonical) over () has_canonical
    from candidates
  )
  select count(*)::integer source_count,
         (array_agg(settlement_id order by issued_at, settlement_id))[1] settlement_id,
         coalesce(bool_and(canonical), false) canonical
  from ranked
  where canonical or not has_canonical
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
  and participation_cancellation.participation_id is null
order by item.ticket_item_id;
""";
        command.Parameters.Add("ticket_id", NpgsqlDbType.Uuid).Value = ticketId;

        var sources = new List<CompletionSource>();
        var hasCanonicalSettlement = false;
        var hasLegacySettlement = false;
        var hasIncompleteSource = false;
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var settlementCount = reader.GetInt32(reader.GetOrdinal("settlement_count"));
            var ledgerCount = reader.GetInt32(reader.GetOrdinal("ledger_count"));
            var walletCount = reader.GetInt32(reader.GetOrdinal("wallet_count"));
            if (settlementCount > 1 || ledgerCount > 1 || walletCount > 1)
            {
                throw new TicketCompletionEvidenceConflictException(
                    "Ticket Completion Authority found ambiguous financial evidence for a ticket item.");
            }

            if (settlementCount > 0)
            {
                if (reader.GetBoolean(reader.GetOrdinal("settlement_canonical")))
                {
                    hasCanonicalSettlement = true;
                }
                else
                {
                    hasLegacySettlement = true;
                }
            }

            if (settlementCount == 0 || ledgerCount == 0 || walletCount == 0)
            {
                hasIncompleteSource = true;
                continue;
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

        if (hasCanonicalSettlement && hasLegacySettlement)
        {
            throw new TicketCompletionEvidenceConflictException(
                "Ticket Completion Authority found mixed canonical and legacy settlement evidence for one ticket.");
        }

        return hasIncompleteSource || sources.Count == 0 ? null : sources;
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
