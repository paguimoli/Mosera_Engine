using System.Text.Json;
using SettlementService.Application;
using SettlementService.Configuration;
using SettlementService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace SettlementService.Infrastructure;

public sealed record SettlementPromotionOperationalSnapshot(
    int UnresolvedFailedInstructions,
    int AwaitingVerificationItems,
    int MissingImmutableReferenceItems,
    int LegacyDryRunArtifacts,
    int SettlementInputRequestCount);

public sealed class SettlementPromotionRepository(ServiceConfiguration configuration)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public bool DurablePersistenceConfigured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<SettlementPromotionOperationalSnapshot> GetOperationalSnapshotAsync(
        CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            return new SettlementPromotionOperationalSnapshot(0, 0, 0, 0, 0);
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        var failed = await CountAsync(connection, """
select count(*)::int
from settlement_service.financial_instruction_execution_attempts latest
where latest.status = 'Failed'
  and latest.created_at = (
    select max(inner_attempt.created_at)
    from settlement_service.financial_instruction_execution_attempts inner_attempt
    where inner_attempt.instruction_id = latest.instruction_id
  )
  and not exists (
    select 1
    from settlement_service.financial_instruction_execution_attempts terminal
    where terminal.instruction_id = latest.instruction_id
      and terminal.status in ('Posted', 'Skipped')
  );
""", cancellationToken);
        var awaitingVerification = await CountAsync(connection, """
select (
  select count(*)::int
  from settlement_service.recovery_events
  where recovery_state = 'SettlementAwaitingVerification'
) + (
  select count(*)::int
  from settlement_service.reconciliation_events
  where reconciliation_status = 'AwaitingVerification'
);
""", cancellationToken);
        var missingReferences = await CountAsync(connection, """
select count(*)::int
from settlement_service.authoritative_settlement_records record
left join settlement_service.settlement_requests request
  on request.settlement_request_id = record.settlement_request_id
where request.settlement_request_id is null
  or record.canonical_settlement_hash is null
  or record.canonical_settlement_hash = ''
  or request.settlement_input_hash is null
  or request.math_evaluation_certificate_hash is null;
""", cancellationToken);
        var legacyArtifacts = await CountAsync(connection, """
select count(*)::int
from settlement_service.settlement_runs
where coalesce(notes, '') like '%resettlement dry run%';
""", cancellationToken);
        var requestCount = await CountAsync(connection, """
select count(*)::int
from settlement_service.settlement_requests;
""", cancellationToken);

        return new SettlementPromotionOperationalSnapshot(
            failed,
            awaitingVerification,
            missingReferences,
            legacyArtifacts,
            requestCount);
    }

    public async Task<IReadOnlyList<Guid>> ListRepresentativeSettlementRequestsAsync(
        int limit,
        CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            return [];
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select settlement_request_id
from settlement_service.settlement_requests
order by accepted_at desc
limit @limit;
""";
        command.Parameters.AddWithValue("limit", limit);

        var ids = new List<Guid>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            ids.Add(reader.GetGuid(0));
        }

        return ids;
    }

    public async Task<IReadOnlyList<SettlementPromotionComparisonResult>> CompareSettlementRequestsAsync(
        IReadOnlyList<Guid> requestIds,
        CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured || requestIds.Count == 0)
        {
            return [];
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        var results = new List<SettlementPromotionComparisonResult>();
        foreach (var requestId in requestIds)
        {
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  request.settlement_request_id,
  request.settlement_input_hash,
  record.canonical_settlement_hash,
  record.settlement_outcome,
  record.stake_amount_minor,
  record.gross_payout_amount_minor,
  record.net_result_amount_minor,
  record.currency,
  record.minor_unit_precision
from settlement_service.settlement_requests request
left join settlement_service.authoritative_settlement_records record
  on record.settlement_request_id = request.settlement_request_id
where request.settlement_request_id = @request_id
order by record.issued_at asc
limit 1;
""";
            command.Parameters.AddWithValue("request_id", requestId);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                results.Add(new SettlementPromotionComparisonResult(
                    requestId,
                    SettlementPromotionComparisonStatus.INCONCLUSIVE,
                    "missing",
                    "missing",
                    ["SettlementRequest was not found."]));
                continue;
            }

            var expected = reader.GetString(reader.GetOrdinal("settlement_input_hash"));
            var actualOrdinal = reader.GetOrdinal("canonical_settlement_hash");
            if (reader.IsDBNull(actualOrdinal))
            {
                results.Add(new SettlementPromotionComparisonResult(
                    requestId,
                    SettlementPromotionComparisonStatus.INCONCLUSIVE,
                    expected,
                    "missing",
                    ["Authoritative SettlementRecord was not found for request."]));
                continue;
            }

            var actual = reader.GetString(actualOrdinal);
            var material = string.Join("|", [
                reader.GetString(reader.GetOrdinal("settlement_outcome")),
                reader.GetInt64(reader.GetOrdinal("stake_amount_minor")).ToString(),
                reader.GetInt64(reader.GetOrdinal("gross_payout_amount_minor")).ToString(),
                reader.GetInt64(reader.GetOrdinal("net_result_amount_minor")).ToString(),
                reader.GetString(reader.GetOrdinal("currency")),
                reader.GetInt32(reader.GetOrdinal("minor_unit_precision")).ToString()
            ]);

            results.Add(new SettlementPromotionComparisonResult(
                requestId,
                SettlementPromotionComparisonStatus.MATCH,
                expected,
                actual,
                [$"Matched settlement material {FinancialInstructionService.HashCanonical(material)}."]));
        }

        return results;
    }

    public async Task<SettlementPromotionRehearsalDto> PersistRehearsalAsync(
        Guid rehearsalId,
        SettlementAuthorityMode authorityMode,
        string serviceBuildVersion,
        string configurationHash,
        string readinessReportHash,
        string testRequestSetHash,
        string resultSummary,
        string comparisonSummary,
        int unresolvedBlockerCount,
        DateTimeOffset startedAt,
        DateTimeOffset completedAt,
        string operatorReference,
        IReadOnlyDictionary<string, object?> approvalMetadata,
        string canonicalEvidenceHash,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into settlement_service.settlement_promotion_rehearsals (
  promotion_rehearsal_id,
  authority_mode,
  service_build_version,
  configuration_hash,
  readiness_report_hash,
  test_request_set_hash,
  result_summary,
  comparison_summary,
  unresolved_blocker_count,
  started_at,
  completed_at,
  operator_reference,
  approval_metadata,
  canonical_evidence_hash
)
values (
  @promotion_rehearsal_id,
  @authority_mode,
  @service_build_version,
  @configuration_hash,
  @readiness_report_hash,
  @test_request_set_hash,
  @result_summary,
  @comparison_summary,
  @unresolved_blocker_count,
  @started_at,
  @completed_at,
  @operator_reference,
  cast(@approval_metadata as jsonb),
  @canonical_evidence_hash
)
on conflict (canonical_evidence_hash) do nothing;
""";
        command.Parameters.AddWithValue("promotion_rehearsal_id", rehearsalId);
        command.Parameters.AddWithValue("authority_mode", authorityMode.ToString());
        command.Parameters.AddWithValue("service_build_version", serviceBuildVersion);
        command.Parameters.AddWithValue("configuration_hash", configurationHash);
        command.Parameters.AddWithValue("readiness_report_hash", readinessReportHash);
        command.Parameters.AddWithValue("test_request_set_hash", testRequestSetHash);
        command.Parameters.AddWithValue("result_summary", resultSummary);
        command.Parameters.AddWithValue("comparison_summary", comparisonSummary);
        command.Parameters.AddWithValue("unresolved_blocker_count", unresolvedBlockerCount);
        command.Parameters.AddWithValue("started_at", startedAt);
        command.Parameters.AddWithValue("completed_at", completedAt);
        command.Parameters.AddWithValue("operator_reference", operatorReference);
        command.Parameters.AddWithValue("approval_metadata", JsonSerializer.Serialize(approvalMetadata, JsonOptions));
        command.Parameters.AddWithValue("canonical_evidence_hash", canonicalEvidenceHash);
        await command.ExecuteNonQueryAsync(cancellationToken);

        return await GetRehearsalByHashAsync(canonicalEvidenceHash, cancellationToken)
            ?? throw new InvalidOperationException("Settlement promotion rehearsal did not read back.");
    }

    private async Task<SettlementPromotionRehearsalDto?> GetRehearsalByHashAsync(
        string evidenceHash,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select *
from settlement_service.settlement_promotion_rehearsals
where canonical_evidence_hash = @canonical_evidence_hash;
""";
        command.Parameters.AddWithValue("canonical_evidence_hash", evidenceHash);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new SettlementPromotionRehearsalDto(
            reader.GetGuid(reader.GetOrdinal("promotion_rehearsal_id")),
            Enum.Parse<SettlementAuthorityMode>(reader.GetString(reader.GetOrdinal("authority_mode"))),
            reader.GetString(reader.GetOrdinal("service_build_version")),
            reader.GetString(reader.GetOrdinal("configuration_hash")),
            reader.GetString(reader.GetOrdinal("readiness_report_hash")),
            reader.GetString(reader.GetOrdinal("test_request_set_hash")),
            reader.GetString(reader.GetOrdinal("result_summary")),
            reader.GetString(reader.GetOrdinal("comparison_summary")),
            reader.GetInt32(reader.GetOrdinal("unresolved_blocker_count")),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("started_at")),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("completed_at")),
            reader.GetString(reader.GetOrdinal("operator_reference")),
            JsonSerializer.Deserialize<Dictionary<string, object?>>(
                reader.GetString(reader.GetOrdinal("approval_metadata")),
                JsonOptions) ?? new Dictionary<string, object?>(),
            reader.GetString(reader.GetOrdinal("canonical_evidence_hash")));
    }

    private static async Task<int> CountAsync(
        NpgsqlConnection connection,
        string sql,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken));
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            throw new InvalidOperationException("DATABASE_URL is not configured for settlement promotion guardrails.");
        }

        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "set search_path to settlement_service, public;";
        await command.ExecuteNonQueryAsync(cancellationToken);
        return connection;
    }
}
