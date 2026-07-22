using System.Text.Json;
using LedgerService.Application;
using LedgerService.Configuration;
using LedgerService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace LedgerService.Infrastructure;

public sealed record LedgerRecoveryEventRecord(
    Guid EventId,
    Guid PostingRequestId,
    Guid? LedgerTransactionId,
    string RecoveryScope,
    LedgerRecoveryClassification Classification,
    string EvidenceHash,
    string? FailureReason,
    IReadOnlyDictionary<string, object?> Provenance,
    DateTimeOffset CreatedAt);

public sealed record SettlementInstructionReconciliationContext(
    Guid InstructionId,
    Guid SettlementId,
    string InstructionType,
    string InstructionStatus,
    string InstructionHash,
    string InstructionIdempotencyKey,
    string TargetService,
    long ExpectedAmount,
    string Currency,
    Guid? PostingRequestId,
    string? PostingInstructionHash,
    Guid? PostingSettlementId,
    long? PostedAmount,
    string? PostedCurrency,
    string? PostingIdempotencyKey,
    LedgerPostingRequestStatus? PostingStatus,
    Guid? LedgerTransactionId,
    Guid? CreditInstructionId,
    string? CreditInstructionStatus,
    string? SettlementTargetIdempotencyKey,
    string? CreditReference,
    bool CreditApplicationExists,
    string? CreditApplicationSettlementId,
    Guid? CreditCanonicalOperationId,
    string? CreditCanonicalOperationIdempotencyKey,
    string? CreditOperationSettlementTargetIdempotencyKey,
    string? CreditCanonicalRequestHash);

public sealed record LedgerReconciliationEventRecord(
    Guid EventId,
    Guid SettlementInstructionId,
    Guid? PostingRequestId,
    Guid? LedgerTransactionId,
    Guid? CreditInstructionId,
    string? CreditReference,
    LedgerReconciliationResult Result,
    string EvidenceHash,
    string? FailureReason,
    IReadOnlyDictionary<string, object?> Provenance,
    DateTimeOffset CreatedAt);

public sealed class LedgerRecoveryRepository(ServiceConfiguration configuration)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public bool Configured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<IReadOnlyList<Guid>> ListIncompleteRequestIdsAsync(CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select id
from ledger_service.ledger_posting_requests
where request_status <> 'COMPLETED'
order by created_at, id;
""";
        var ids = new List<Guid>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) ids.Add(reader.GetGuid(0));
        return ids;
    }

    public async Task<LedgerRecoveryEventRecord> AppendRecoveryAsync(
        Guid postingRequestId,
        Guid? transactionId,
        string scope,
        LedgerRecoveryClassification classification,
        string evidenceHash,
        string? failureReason,
        IReadOnlyDictionary<string, object?> provenance,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
with inserted as (
insert into ledger_service.ledger_recovery_events (
  event_id, posting_request_id, ledger_transaction_id, recovery_scope,
  classification, evidence_hash, failure_reason, provenance
)
values (@event_id, @posting_request_id, @ledger_transaction_id, @recovery_scope,
        @classification, @evidence_hash, @failure_reason, cast(@provenance as jsonb))
on conflict (evidence_hash) do nothing
returning event_id, posting_request_id, ledger_transaction_id, recovery_scope,
          classification, evidence_hash, failure_reason, provenance::text, created_at
)
select * from inserted
union all
select event_id, posting_request_id, ledger_transaction_id, recovery_scope,
       classification, evidence_hash, failure_reason, provenance::text, created_at
from ledger_service.ledger_recovery_events
where evidence_hash = @evidence_hash
limit 1;
""";
        command.Parameters.AddWithValue("event_id", Guid.NewGuid());
        command.Parameters.AddWithValue("posting_request_id", postingRequestId);
        AddNullableGuid(command, "ledger_transaction_id", transactionId);
        command.Parameters.AddWithValue("recovery_scope", scope);
        command.Parameters.AddWithValue("classification", classification.ToString());
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);
        AddNullableText(command, "failure_reason", failureReason);
        command.Parameters.AddWithValue("provenance", JsonSerializer.Serialize(provenance, JsonOptions));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new LedgerRecoveryException("Ledger recovery evidence could not be read back.");
        }
        return MapRecovery(reader);
    }

    public async Task<SettlementInstructionReconciliationContext?> LoadReconciliationContextAsync(
        Guid instructionId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
with target as (
  select fi.*, sr.currency, sr.stake_amount_minor, sr.gross_payout_amount_minor,
         case
           when fi.instruction_type = 'LEDGER_PAYOUT' then sr.gross_payout_amount_minor
           when fi.instruction_type in ('LEDGER_REFUND', 'LEDGER_REVERSAL') then sr.stake_amount_minor
           else coalesce((fi.provenance->>'amountMinor')::bigint, 0)
         end expected_amount
  from settlement_service.financial_instructions fi
  join settlement_service.authoritative_settlement_records sr on sr.settlement_id = fi.settlement_id
  where fi.instruction_id = @instruction_id
), paired_credit as (
  select fi.instruction_id, fi.instruction_status
  from settlement_service.financial_instructions fi, target t
  where fi.settlement_id = t.settlement_id
    and fi.target_service = 'credit-wallet-service'
    and fi.instruction_type <> 'CREDIT_NOOP'
  order by fi.instruction_sequence
  limit 1
), credit_attempt as (
  select a.instruction_id, a.target_idempotency_key, a.external_reference_id
  from settlement_service.financial_instruction_execution_attempts a
  join paired_credit pc on pc.instruction_id = a.instruction_id
  where a.status in ('Posted', 'Reused', 'RecoveryVerified')
  order by a.attempt_number desc
  limit 1
)
select t.instruction_id, t.settlement_id, t.instruction_type, t.instruction_status,
       t.canonical_payload_hash, t.idempotency_key, t.target_service,
       t.expected_amount, t.currency,
       pr.id, pr.instruction_hash, pr.settlement_record_id, pr.amount_minor,
       pr.currency, pr.idempotency_key, pr.request_status, pr.journal_transaction_id,
       pc.instruction_id, pc.instruction_status,
       ca.target_idempotency_key, ca.external_reference_id,
       (csa.id is not null), coalesce(csa.metadata->>'settlementId', csa.settlement_id),
       csa.operation_id, csa.idempotency_key, wor.idempotency_key, wor.canonical_request_hash
from target t
left join ledger_service.ledger_posting_requests pr
  on pr.instruction_id = t.instruction_id::text
left join paired_credit pc on true
left join credit_attempt ca on ca.instruction_id = pc.instruction_id
left join public.credit_settlement_applications csa
  on csa.id::text = ca.external_reference_id
left join credit_wallet_service.wallet_operation_requests wor
  on wor.operation_id = csa.operation_id;
""";
        command.Parameters.AddWithValue("instruction_id", instructionId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return new SettlementInstructionReconciliationContext(
            reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2), reader.GetString(3),
            reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.GetInt64(7),
            reader.GetString(8), GetGuid(reader, 9), GetString(reader, 10), GetGuid(reader, 11),
            GetInt64(reader, 12), GetString(reader, 13), GetString(reader, 14),
            reader.IsDBNull(15) ? null : Enum.Parse<LedgerPostingRequestStatus>(reader.GetString(15)),
            GetGuid(reader, 16), GetGuid(reader, 17), GetString(reader, 18), GetString(reader, 19),
            GetString(reader, 20), !reader.IsDBNull(21) && reader.GetBoolean(21),
            GetString(reader, 22), GetGuid(reader, 23), GetString(reader, 24),
            GetString(reader, 25), GetString(reader, 26));
    }

    public async Task<LedgerReconciliationEventRecord> AppendReconciliationAsync(
        SettlementInstructionReconciliationContext context,
        LedgerReconciliationResult result,
        string evidenceHash,
        string? failureReason,
        IReadOnlyDictionary<string, object?> provenance,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
with inserted as (
insert into ledger_service.ledger_reconciliation_events (
  event_id, settlement_instruction_id, posting_request_id, ledger_transaction_id,
  credit_instruction_id, credit_reference, reconciliation_result, evidence_hash,
  failure_reason, provenance
)
values (@event_id, @settlement_instruction_id, @posting_request_id, @ledger_transaction_id,
        @credit_instruction_id, @credit_reference, @reconciliation_result, @evidence_hash,
        @failure_reason, cast(@provenance as jsonb))
on conflict (evidence_hash) do nothing
returning event_id, settlement_instruction_id, posting_request_id, ledger_transaction_id,
          credit_instruction_id, credit_reference, reconciliation_result, evidence_hash,
          failure_reason, provenance::text, created_at
)
select * from inserted
union all
select event_id, settlement_instruction_id, posting_request_id, ledger_transaction_id,
       credit_instruction_id, credit_reference, reconciliation_result, evidence_hash,
       failure_reason, provenance::text, created_at
from ledger_service.ledger_reconciliation_events
where evidence_hash = @evidence_hash
limit 1;
""";
        command.Parameters.AddWithValue("event_id", Guid.NewGuid());
        command.Parameters.AddWithValue("settlement_instruction_id", context.InstructionId);
        AddNullableGuid(command, "posting_request_id", context.PostingRequestId);
        AddNullableGuid(command, "ledger_transaction_id", context.LedgerTransactionId);
        AddNullableGuid(command, "credit_instruction_id", context.CreditInstructionId);
        AddNullableText(command, "credit_reference", context.CreditReference);
        command.Parameters.AddWithValue("reconciliation_result", result.ToString());
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);
        AddNullableText(command, "failure_reason", failureReason);
        command.Parameters.AddWithValue("provenance", JsonSerializer.Serialize(provenance, JsonOptions));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new LedgerRecoveryException("Ledger reconciliation evidence could not be read back.");
        }
        return MapReconciliation(reader);
    }

    public async Task<LedgerReconciliationEventRecord?> FindLatestReconciliationAsync(Guid instructionId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select event_id, settlement_instruction_id, posting_request_id, ledger_transaction_id,
       credit_instruction_id, credit_reference, reconciliation_result, evidence_hash,
       failure_reason, provenance::text, created_at
from ledger_service.ledger_reconciliation_events
where settlement_instruction_id = @instruction_id
order by created_at desc, event_id desc
limit 1;
""";
        command.Parameters.AddWithValue("instruction_id", instructionId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapReconciliation(reader) : null;
    }

    public async Task<LedgerRecoveryReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        if (!Configured) return new(false, false, false, false, false, false, false, 0, 0, ["DATABASE_URL is not configured."]);
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
with latest as (
  select distinct on (settlement_instruction_id) settlement_instruction_id, reconciliation_result
  from ledger_service.ledger_reconciliation_events
  order by settlement_instruction_id, created_at desc, event_id desc
)
select
  to_regclass('ledger_service.ledger_recovery_events') is not null,
  to_regclass('ledger_service.ledger_reconciliation_events') is not null,
  count(*) filter (where reconciliation_result in ('PAYLOAD_MISMATCH', 'STATUS_MISMATCH'))::int,
  count(*) filter (where reconciliation_result = 'INCONCLUSIVE')::int
from latest;
""";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            await reader.ReadAsync(cancellationToken);
            var recovery = reader.GetBoolean(0);
            var reconciliation = reader.GetBoolean(1);
            var mismatches = reader.GetInt32(2);
            var inconclusive = reader.GetInt32(3);
            var blockers = new List<string>();
            if (!recovery) blockers.Add("Ledger recovery evidence table is missing.");
            if (!reconciliation) blockers.Add("Ledger reconciliation evidence table is missing.");
            if (mismatches > 0) blockers.Add($"{mismatches} unresolved reconciliation mismatch(es).");
            if (inconclusive > 0) blockers.Add($"{inconclusive} unresolved inconclusive reconciliation result(s).");
            var ready = recovery && reconciliation && mismatches == 0 && inconclusive == 0;
            return new(true, true, recovery, recovery, recovery, reconciliation, recovery, mismatches, inconclusive, blockers);
        }
        catch (Exception error) when (error is NpgsqlException or InvalidOperationException)
        {
            return new(true, false, false, false, false, false, false, 0, 0, [error.Message]);
        }
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!Configured) throw new LedgerRecoveryException("DATABASE_URL is required for Ledger recovery.");
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url!));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static LedgerRecoveryEventRecord MapRecovery(NpgsqlDataReader reader) => new(
        reader.GetGuid(0), reader.GetGuid(1), GetGuid(reader, 2), reader.GetString(3),
        Enum.Parse<LedgerRecoveryClassification>(reader.GetString(4)), reader.GetString(5),
        GetString(reader, 6), Deserialize(reader.GetString(7)), reader.GetFieldValue<DateTimeOffset>(8));

    private static LedgerReconciliationEventRecord MapReconciliation(NpgsqlDataReader reader) => new(
        reader.GetGuid(0), reader.GetGuid(1), GetGuid(reader, 2), GetGuid(reader, 3), GetGuid(reader, 4),
        GetString(reader, 5), Enum.Parse<LedgerReconciliationResult>(reader.GetString(6)), reader.GetString(7),
        GetString(reader, 8), Deserialize(reader.GetString(9)), reader.GetFieldValue<DateTimeOffset>(10));

    private static IReadOnlyDictionary<string, object?> Deserialize(string value) =>
        JsonSerializer.Deserialize<Dictionary<string, object?>>(value, JsonOptions) ?? new Dictionary<string, object?>();
    private static string? GetString(NpgsqlDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    private static Guid? GetGuid(NpgsqlDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? null : reader.GetGuid(ordinal);
    private static long? GetInt64(NpgsqlDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? null : reader.GetInt64(ordinal);
    private static void AddNullableText(NpgsqlCommand command, string name, string? value) =>
        command.Parameters.Add(name, NpgsqlDbType.Text).Value = (object?)value ?? DBNull.Value;
    private static void AddNullableGuid(NpgsqlCommand command, string name, Guid? value) =>
        command.Parameters.Add(name, NpgsqlDbType.Uuid).Value = (object?)value ?? DBNull.Value;
}
