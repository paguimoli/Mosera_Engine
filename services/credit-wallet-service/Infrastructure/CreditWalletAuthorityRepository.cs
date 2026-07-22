using System.Text.Json;
using CreditWalletService.Configuration;
using CreditWalletService.Contracts;
using Npgsql;

namespace CreditWalletService.Infrastructure;

public sealed class CreditWalletAuthorityRepository(ServiceConfiguration configuration)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public bool Configured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<bool> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        if (!Configured) return false;
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select to_regclass('credit_wallet_service.wallet_authority_evidence') is not null
   and to_regclass('credit_wallet_service.wallet_operation_requests') is not null
   and to_regclass('credit_wallet_service.wallet_recovery_evidence') is not null;
""";
        return await command.ExecuteScalarAsync(cancellationToken) is true;
    }

    public async Task<string> GetMigrationVersionAsync(CancellationToken cancellationToken)
    {
        if (!Configured) return "NOT_CONFIGURED";
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select coalesce(max(migration_id), 'UNKNOWN')
from platform_migrations.migration_history
where status = 'APPLIED';
""";
        return Convert.ToString(await command.ExecuteScalarAsync(cancellationToken)) ?? "UNKNOWN";
    }

    public async Task<CreditWalletAuthorityOperationalSnapshot> GetOperationalSnapshotAsync(
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  count(*) filter (where r.operation_type = 'RESERVE' and t.terminal_status = 'COMMITTED')::integer,
  count(*) filter (where r.operation_type = 'RELEASE' and t.terminal_status = 'COMMITTED')::integer,
  count(*) filter (where r.operation_type = 'CANCEL' and t.terminal_status = 'COMMITTED')::integer,
  count(*) filter (where r.operation_type = 'SETTLE' and t.terminal_status = 'COMMITTED')::integer,
  count(*) filter (where r.operation_type = 'SETTLE' and t.terminal_status = 'COMMITTED')::integer,
  count(*) filter (where r.operation_type = 'REVERSE' and t.terminal_status = 'COMMITTED')::integer,
  count(*) filter (where r.operation_type = 'SETTLE' and r.corrects_operation_id is not null and t.terminal_status = 'COMMITTED')::integer,
  (select count(*)::integer from credit_wallet_service.wallet_recovery_evidence),
  (select count(*)::integer from credit_wallet_service.wallet_replay_evidence where replay_result = 'MATCH'),
  count(*) filter (where t.operation_id is null)::integer,
  count(*) filter (where t.terminal_status = 'COMMITTED' and (t.effect_reference_type is null or t.effect_reference_id is null))::integer,
  (select count(*)::integer from (
     select distinct on (wallet_id) verification_result
     from credit_wallet_service.wallet_projection_verifications
     order by wallet_id, verified_at desc
   ) latest where verification_result = 'DRIFT'),
  coalesce((select mismatch_count from credit_wallet_service.wallet_reconciliation_evidence
    where reconciliation_type = 'LEDGER' order by verified_at desc limit 1), 0),
  coalesce((select mismatch_count from credit_wallet_service.wallet_reconciliation_evidence
    where reconciliation_type = 'SETTLEMENT' order by verified_at desc limit 1), 0),
  (select count(*)::integer from public.credit_settlement_applications
    where ledger_posting_required and (ledger_instruction_id is null or ledger_posting_request_id is null or ledger_journal_id is null or ledger_entry_id is null)),
  (select count(*)::integer from credit_wallet_service.settlement_instruction_authentication_evidence where authentication_result = 'AUTHENTICATED')
from credit_wallet_service.wallet_operation_requests r
left join credit_wallet_service.wallet_operation_terminal_results t using (operation_id);
""";
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);
        return new(
            reader.GetInt32(0), reader.GetInt32(1), reader.GetInt32(2), reader.GetInt32(3),
            reader.GetInt32(4), reader.GetInt32(5), reader.GetInt32(6), reader.GetInt32(7),
            reader.GetInt32(8), reader.GetInt32(9), reader.GetInt32(10), reader.GetInt32(11),
            reader.GetInt32(12), reader.GetInt32(13), reader.GetInt32(14), reader.GetInt32(15));
    }

    public async Task<CreditWalletAuthorityEvidenceReference?> GetLatestEvidenceReferenceAsync(
        string evidenceType,
        CancellationToken cancellationToken)
    {
        if (!Configured) return null;
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select evidence_type, authority_mode, result, evidence_payload_hash
from credit_wallet_service.wallet_authority_evidence
where evidence_type = @type
order by created_at desc, evidence_id desc
limit 1;
""";
        command.Parameters.AddWithValue("type", evidenceType);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return new(
            reader.GetString(0),
            Enum.Parse<CreditWalletAuthorityMode>(reader.GetString(1)),
            reader.GetString(2),
            reader.GetString(3));
    }

    public async Task<CreditWalletAuthorityEvidenceDto> PersistEvidenceAsync(
        Guid evidenceId,
        string evidenceType,
        CreditWalletAuthorityMode authorityMode,
        string result,
        string configurationHash,
        string readinessFingerprint,
        string evidencePayloadHash,
        IReadOnlyDictionary<string, object?> evidencePayload,
        string operatorReference,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
with inserted as (
  insert into credit_wallet_service.wallet_authority_evidence (
    evidence_id, evidence_type, authority_mode, result, configuration_hash,
    readiness_fingerprint, evidence_payload_hash, evidence_payload, operator_reference)
  values (@id, @type, @mode, @result, @configuration_hash,
          @readiness_fingerprint, @payload_hash, cast(@payload as jsonb), @operator)
  on conflict (evidence_payload_hash) do nothing
  returning evidence_id, evidence_type, authority_mode, result, configuration_hash,
            readiness_fingerprint, evidence_payload_hash, evidence_payload::text,
            operator_reference, created_at
)
select * from inserted
union all
select evidence_id, evidence_type, authority_mode, result, configuration_hash,
       readiness_fingerprint, evidence_payload_hash, evidence_payload::text,
       operator_reference, created_at
from credit_wallet_service.wallet_authority_evidence
where evidence_payload_hash = @payload_hash
limit 1;
""";
        command.Parameters.AddWithValue("id", evidenceId);
        command.Parameters.AddWithValue("type", evidenceType);
        command.Parameters.AddWithValue("mode", authorityMode.ToString());
        command.Parameters.AddWithValue("result", result);
        command.Parameters.AddWithValue("configuration_hash", configurationHash);
        command.Parameters.AddWithValue("readiness_fingerprint", readinessFingerprint);
        command.Parameters.AddWithValue("payload_hash", evidencePayloadHash);
        command.Parameters.AddWithValue("payload", JsonSerializer.Serialize(evidencePayload, JsonOptions));
        command.Parameters.AddWithValue("operator", operatorReference);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException("Credit Wallet authority evidence could not be read back.");
        }
        return new(
            reader.GetGuid(0), reader.GetString(1), Enum.Parse<CreditWalletAuthorityMode>(reader.GetString(2)),
            reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.GetString(6),
            JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(7), JsonOptions)!,
            reader.GetString(8), reader.GetFieldValue<DateTimeOffset>(9));
    }

    private async Task<NpgsqlConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}
