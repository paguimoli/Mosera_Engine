using System.Text.Json;
using LedgerService.Configuration;
using LedgerService.Contracts;
using Npgsql;

namespace LedgerService.Infrastructure;

public sealed record LedgerPromotionOperationalSnapshot(
    int IncompletePostingRequests,
    int ReplayMismatches,
    int ReconciliationMismatches,
    int ReconciliationInconclusive,
    int UnbalancedJournals);

public sealed class LedgerPromotionRepository(ServiceConfiguration configuration)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public bool Configured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<LedgerPromotionOperationalSnapshot> GetOperationalSnapshotAsync(CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return new LedgerPromotionOperationalSnapshot(
            await CountAsync(connection, "select count(*)::int from ledger_service.ledger_posting_requests where request_status in ('CLAIMED','UNKNOWN');", cancellationToken),
            await CountAsync(connection, """
select count(*)::int from ledger_service.ledger_replay_evidence evidence
where evidence.replay_result = 'MISMATCH'
  and not exists (
    select 1 from ledger_service.ledger_replay_evidence later
    where later.posting_request_id = evidence.posting_request_id
      and later.verified_at > evidence.verified_at
      and later.replay_result = 'MATCH');
""", cancellationToken),
            await CountAsync(connection, """
select count(*)::int from ledger_service.ledger_reconciliation_events evidence
where evidence.reconciliation_result in ('LEDGER_MISSING','CREDIT_MISSING','PAYLOAD_MISMATCH','STATUS_MISMATCH')
  and evidence.created_at = (select max(later.created_at) from ledger_service.ledger_reconciliation_events later
    where later.settlement_instruction_id = evidence.settlement_instruction_id);
""", cancellationToken),
            await CountAsync(connection, """
select count(*)::int from ledger_service.ledger_reconciliation_events evidence
where evidence.reconciliation_result = 'INCONCLUSIVE'
  and evidence.created_at = (select max(later.created_at) from ledger_service.ledger_reconciliation_events later
    where later.settlement_instruction_id = evidence.settlement_instruction_id);
""", cancellationToken),
            await CountAsync(connection, """
select count(*)::int
from ledger_service.ledger_transactions transaction
where exists (
  select 1 from ledger_service.ledger_entries entry
  where entry.transaction_id = transaction.id
  group by entry.transaction_id
  having sum(entry.debit_amount) <> sum(entry.credit_amount) or count(*) <> 2);
""", cancellationToken));
    }

    public async Task<IReadOnlyList<LedgerPromotionComparison>> CompareRepresentativePostingsAsync(CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        var comparisons = new List<LedgerPromotionComparison>();
        foreach (var family in new[]
        {
            "SETTLEMENT_PAYOUT", "SETTLEMENT_REFUND", "SETTLEMENT_REVERSAL",
            "CORRECTED_SETTLEMENT", "PLAYER_REBATE_CREDIT", "PROMOTIONAL_CREDIT",
            "AGENT_COMMISSION_ACCRUAL", "GOVERNED_MANUAL_ADJUSTMENT"
        })
        {
            var (count, invalid) = await ReadFamilyEvidenceAsync(connection, family, cancellationToken);
            var status = invalid > 0
                ? LedgerPromotionComparisonStatus.DIVERGENCE
                : count == 0
                    ? LedgerPromotionComparisonStatus.INCONCLUSIVE
                    : family == "CORRECTED_SETTLEMENT"
                        ? LedgerPromotionComparisonStatus.ACCEPTABLE_DIFFERENCE
                        : LedgerPromotionComparisonStatus.MATCH;
            var differences = status switch
            {
                LedgerPromotionComparisonStatus.DIVERGENCE => new[] { "At least one journal violates the balanced two-line invariant." },
                LedgerPromotionComparisonStatus.INCONCLUSIVE => new[] { "No immutable representative artifact is available." },
                LedgerPromotionComparisonStatus.ACCEPTABLE_DIFFERENCE => new[] { "Correction is represented by immutable reversal plus replacement posting rather than mutation." },
                _ => Array.Empty<string>()
            };
            comparisons.Add(new LedgerPromotionComparison(
                family,
                status,
                count,
                "One immutable, balanced, exactly versioned, idempotent journal artifact.",
                $"artifacts={count};invalidJournals={invalid}",
                differences));
        }
        return comparisons;
    }

    public async Task<bool> HasPassingPromotionRehearsalAsync(CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await CountAsync(connection, """
select count(*)::int
from ledger_service.ledger_promotion_rehearsals
where authority_mode in ('SERVICE_SHADOW', 'SERVICE_DRY_RUN')
  and result_summary = 'PASS'
  and unresolved_blocker_count = 0;
""", cancellationToken) > 0;
    }

    public async Task<LedgerPromotionRehearsalDto> PersistRehearsalAsync(
        Guid id,
        LedgerAuthorityMode mode,
        string buildVersion,
        string configurationHash,
        string readinessHash,
        string requestSetHash,
        string resultSummary,
        string comparisonSummary,
        int blockerCount,
        DateTimeOffset startedAt,
        DateTimeOffset completedAt,
        string operatorReference,
        IReadOnlyDictionary<string, object?> approvalMetadata,
        string evidenceHash,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
with inserted as (
  insert into ledger_service.ledger_promotion_rehearsals (
    promotion_rehearsal_id, authority_mode, service_build_version, configuration_hash,
    readiness_report_hash, test_request_set_hash, result_summary, comparison_summary,
    unresolved_blocker_count, started_at, completed_at, operator_reference,
    approval_metadata, canonical_evidence_hash)
  values (@id, @mode, @build, @config_hash, @readiness_hash, @request_hash,
          @result, cast(@comparison as jsonb), @blockers, @started, @completed,
          @operator, cast(@approval as jsonb), @evidence_hash)
  on conflict (canonical_evidence_hash) do nothing
  returning promotion_rehearsal_id, authority_mode, service_build_version, configuration_hash,
            readiness_report_hash, test_request_set_hash, result_summary, comparison_summary::text,
            unresolved_blocker_count, started_at, completed_at, operator_reference,
            approval_metadata::text, canonical_evidence_hash, created_at
)
select * from inserted
union all
select promotion_rehearsal_id, authority_mode, service_build_version, configuration_hash,
       readiness_report_hash, test_request_set_hash, result_summary, comparison_summary::text,
       unresolved_blocker_count, started_at, completed_at, operator_reference,
       approval_metadata::text, canonical_evidence_hash, created_at
from ledger_service.ledger_promotion_rehearsals
where canonical_evidence_hash = @evidence_hash
limit 1;
""";
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("mode", mode.ToString());
        command.Parameters.AddWithValue("build", buildVersion);
        command.Parameters.AddWithValue("config_hash", configurationHash);
        command.Parameters.AddWithValue("readiness_hash", readinessHash);
        command.Parameters.AddWithValue("request_hash", requestSetHash);
        command.Parameters.AddWithValue("result", resultSummary);
        command.Parameters.AddWithValue("comparison", comparisonSummary);
        command.Parameters.AddWithValue("blockers", blockerCount);
        command.Parameters.AddWithValue("started", startedAt);
        command.Parameters.AddWithValue("completed", completedAt);
        command.Parameters.AddWithValue("operator", operatorReference);
        command.Parameters.AddWithValue("approval", JsonSerializer.Serialize(approvalMetadata, JsonOptions));
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) throw new InvalidOperationException("Ledger promotion evidence could not be read back.");
        return new LedgerPromotionRehearsalDto(
            reader.GetGuid(0), Enum.Parse<LedgerAuthorityMode>(reader.GetString(1)), reader.GetString(2),
            reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.GetString(7),
            reader.GetInt32(8), reader.GetFieldValue<DateTimeOffset>(9), reader.GetFieldValue<DateTimeOffset>(10),
            reader.GetString(11), JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(12), JsonOptions)!,
            reader.GetString(13), reader.GetFieldValue<DateTimeOffset>(14));
    }

    private static async Task<(int Count, int Invalid)> ReadFamilyEvidenceAsync(NpgsqlConnection connection, string family, CancellationToken cancellationToken)
    {
        var predicate = family switch
        {
            "SETTLEMENT_REVERSAL" => "exists (select 1 from ledger_service.ledger_entries e where e.transaction_id = tx.id and e.reversal_of_entry_id is not null)",
            "CORRECTED_SETTLEMENT" => "tx.posting_rule_id = 'SETTLEMENT_PAYOUT' and exists (select 1 from ledger_service.ledger_entries reversal where reversal.reversal_of_entry_id is not null)",
            "GOVERNED_MANUAL_ADJUSTMENT" => "tx.posting_rule_id in ('MANUAL_CREDIT_ADJUSTMENT','MANUAL_DEBIT_ADJUSTMENT')",
            _ => "tx.posting_rule_id = @family"
        };
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
select count(*)::int,
       count(*) filter (where
         (select coalesce(sum(e.debit_amount), 0) from ledger_service.ledger_entries e where e.transaction_id = tx.id)
           <> (select coalesce(sum(e.credit_amount), 0) from ledger_service.ledger_entries e where e.transaction_id = tx.id)
         or (select count(*) from ledger_service.ledger_entries e where e.transaction_id = tx.id) <> 2)::int
from ledger_service.ledger_transactions tx
where {predicate};
""";
        if (predicate.Contains("@family", StringComparison.Ordinal)) command.Parameters.AddWithValue("family", family);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);
        return (reader.GetInt32(0), reader.GetInt32(1));
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static async Task<int> CountAsync(NpgsqlConnection connection, string sql, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken));
    }
}
