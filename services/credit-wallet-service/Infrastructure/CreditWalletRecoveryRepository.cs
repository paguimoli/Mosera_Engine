using System.Text.Json;
using CreditWalletService.Application;
using CreditWalletService.Configuration;
using CreditWalletService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace CreditWalletService.Infrastructure;

public sealed class CreditWalletRecoveryRepository(ServiceConfiguration configuration)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public bool Configured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<bool> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        if (!Configured) return false;
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select to_regclass('credit_wallet_service.wallet_recovery_runs') is not null
   and to_regclass('credit_wallet_service.wallet_recovery_evidence') is not null
   and to_regclass('credit_wallet_service.wallet_replay_evidence') is not null
   and to_regclass('credit_wallet_service.wallet_projection_baselines') is not null
   and to_regclass('credit_wallet_service.wallet_projection_verifications') is not null
   and to_regclass('credit_wallet_service.wallet_reconciliation_evidence') is not null;
""";
        return await command.ExecuteScalarAsync(cancellationToken) is true;
    }

    public async Task<IReadOnlyList<WalletOperationRecoverySnapshot>> ListRecoveryCandidatesAsync(
        int limit, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = SnapshotSql + """

where tr.operation_id is null
   or (tr.terminal_status = 'COMMITTED' and coalesce(effect.effect_count, 0) <> 1)
order by r.created_at, r.operation_id
limit @limit;
""";
        command.Parameters.AddWithValue("limit", Math.Clamp(limit, 1, 1000));
        return await ReadSnapshotsAsync(command, cancellationToken);
    }

    public async Task<WalletOperationRecoverySnapshot?> GetSnapshotAsync(
        Guid operationId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = SnapshotSql + "\nwhere r.operation_id = @operation_id;";
        command.Parameters.AddWithValue("operation_id", operationId);
        return (await ReadSnapshotsAsync(command, cancellationToken)).SingleOrDefault();
    }

    public async Task<WalletRecoveryOperationalReport> GetOperationalReportAsync(
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
with states as (
  select tr.terminal_status,
         case when tr.operation_id is null and exists (
           select 1 from public.credit_reservations cr
           where cr.idempotency_key = 'canonical-wallet:' || replace(r.operation_id::text, '-', '') || ':RESERVE'
         ) then true else false end as has_unterminalled_reserve,
         exists (select 1 from credit_wallet_service.wallet_replay_evidence re where re.operation_id = r.operation_id) replayed
  from credit_wallet_service.wallet_operation_requests r
  left join credit_wallet_service.wallet_operation_terminal_results tr using(operation_id)
)
select count(*) filter (where terminal_status is null and not has_unterminalled_reserve)::integer,
       count(*) filter (where terminal_status is null and has_unterminalled_reserve)::integer,
       (select count(*)::integer from credit_wallet_service.wallet_recovery_evidence where classification = 'CONFLICT'),
       count(*) filter (where terminal_status = 'COMMITTED' and not replayed)::integer,
       (select count(*)::integer from credit_wallet_service.wallet_projection_verifications where verification_result = 'DRIFT'),
       (select coalesce(sum(mismatch_count),0)::integer from credit_wallet_service.wallet_reconciliation_evidence where reconciliation_type = 'LEDGER'),
       (select coalesce(sum(mismatch_count),0)::integer from credit_wallet_service.wallet_reconciliation_evidence where reconciliation_type = 'SETTLEMENT'),
       (select count(*)::integer from credit_wallet_service.wallet_recovery_runs)
from states;
""";
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);
        return new(reader.GetInt32(0), reader.GetInt32(1), reader.GetInt32(2), reader.GetInt32(3),
            reader.GetInt32(4), reader.GetInt32(5), reader.GetInt32(6), reader.GetInt32(7), DateTimeOffset.UtcNow);
    }

    public async Task<CanonicalWalletOperationRequest?> LoadRequestAsync(
        Guid operationId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select request_id, tenant_id, brand_id, player_id, wallet_id, instrument_code,
       operation_type, amount_minor, currency, balance_impact_minor, authority,
       effective_at, ticket_id, reservation_id, settlement_id, settlement_batch_id,
       settlement_instruction_id, settlement_instruction_sequence,
       settlement_instruction_hash, settlement_version, settlement_hash,
       settlement_outcome, ledger_instruction_id, ledger_posting_required,
       original_operation_id, corrects_operation_id, reason_code, source_service,
       audit_metadata::text
from credit_wallet_service.wallet_operation_requests
where operation_id = @operation_id;
""";
        command.Parameters.AddWithValue("operation_id", operationId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        var currency = reader.GetString(8);
        return new CanonicalWalletOperationRequest(
            reader.GetGuid(0), reader.GetGuid(1), reader.GetGuid(2), reader.GetGuid(3), reader.GetGuid(4),
            Enum.Parse<WalletInstrumentType>(reader.GetString(5)),
            Enum.Parse<WalletOperationType>(reader.GetString(6)),
            new MoneyDto(reader.GetInt64(7), currency),
            reader.IsDBNull(9) ? null : new MoneyDto(reader.GetInt64(9), currency),
            reader.GetString(10), reader.GetFieldValue<DateTimeOffset>(11),
            GetGuid(reader, 12), GetGuid(reader, 13), GetGuid(reader, 14), GetGuid(reader, 15),
            GetGuid(reader, 16), reader.IsDBNull(17) ? null : reader.GetInt64(17),
            GetString(reader, 18), GetString(reader, 19), GetString(reader, 20),
            reader.IsDBNull(21) ? null : Enum.Parse<SettlementOutcome>(reader.GetString(21)),
            GetGuid(reader, 22), reader.IsDBNull(23) ? null : reader.GetBoolean(23),
            GetGuid(reader, 24), GetGuid(reader, 25), GetString(reader, 26), GetString(reader, 27),
            JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(28), JsonOptions));
    }

    public async Task<string?> GetResultHashAsync(Guid operationId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "select result_hash from credit_wallet_service.wallet_operation_terminal_results where operation_id = @id;";
        command.Parameters.AddWithValue("id", operationId);
        return (string?)await command.ExecuteScalarAsync(cancellationToken);
    }

    public async Task<WalletTerminalEvidence?> GetTerminalEvidenceAsync(
        Guid operationId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select terminal_status, effect_reference_type, effect_reference_id, result_payload::text,
       result_hash, failure_code, failure_reason
from credit_wallet_service.wallet_operation_terminal_results where operation_id = @id;
""";
        command.Parameters.AddWithValue("id", operationId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new WalletTerminalEvidence(reader.GetString(0), GetString(reader, 1), GetString(reader, 2),
                JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(3), JsonOptions)
                    ?? new Dictionary<string, object?>(), reader.GetString(4), GetString(reader, 5), GetString(reader, 6))
            : null;
    }

    public async Task<IReadOnlyList<string>> GetReplayReferenceMismatchesAsync(
        Guid operationId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select r.operation_type,
       exists(select 1 from credit_wallet_service.wallet_operation_attempts a where a.operation_id = r.operation_id),
       case when r.operation_type in ('SETTLE','REVERSE') then exists(
         select 1 from credit_wallet_service.settlement_instruction_authentication_evidence e
         where e.operation_id = r.operation_id and e.authentication_result = 'AUTHENTICATED'
           and e.settlement_id = r.settlement_id and e.settlement_instruction_id = r.settlement_instruction_id
           and e.ledger_instruction_id = r.ledger_instruction_id) else true end,
       case when r.operation_type in ('SETTLE','REVERSE') and r.ledger_posting_required then exists(
         select 1 from public.credit_settlement_applications app
         join ledger_service.ledger_posting_requests p on p.id = app.ledger_posting_request_id
         where app.operation_id = r.operation_id and p.request_status = 'COMPLETED'
           and app.ledger_instruction_id = r.ledger_instruction_id
           and app.ledger_journal_id = p.journal_transaction_id
           and app.ledger_entry_id = p.ledger_entry_id) else true end,
       case when r.reservation_id is not null then exists(
         select 1 from public.credit_reservations cr where cr.id = r.reservation_id
           and cr.wallet_id = r.wallet_id and cr.ticket_id = r.ticket_id::text
           and cr.instrument_code = r.instrument_code) else true end
from credit_wallet_service.wallet_operation_requests r where r.operation_id = @operation_id;
""";
        command.Parameters.AddWithValue("operation_id", operationId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return ["CANONICAL_REQUEST_MISSING"];
        var mismatches = new List<string>();
        if (!reader.GetBoolean(1)) mismatches.Add("ATTEMPT_EVIDENCE_MISSING");
        if (!reader.GetBoolean(2)) mismatches.Add("SETTLEMENT_AUTHENTICATION_EVIDENCE_MISMATCH");
        if (!reader.GetBoolean(3)) mismatches.Add("LEDGER_COMPLETION_REFERENCE_MISMATCH");
        if (!reader.GetBoolean(4)) mismatches.Add("RESERVATION_REFERENCE_MISMATCH");
        return mismatches;
    }

    public async Task<Guid> AppendRecoveryRunAsync(
        string trigger, string status, int scanned, int recovered, int blocked, int conflicts,
        DateTimeOffset started, DateTimeOffset completed, string hash, CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid();
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into credit_wallet_service.wallet_recovery_runs(
 recovery_run_id, trigger_type, run_status, scanned_count, recovered_count,
 blocked_count, conflict_count, canonical_evidence_hash, started_at, completed_at)
values (@id,@trigger,@status,@scanned,@recovered,@blocked,@conflicts,@hash,@started,@completed);
""";
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("trigger", trigger);
        command.Parameters.AddWithValue("status", status);
        command.Parameters.AddWithValue("scanned", scanned);
        command.Parameters.AddWithValue("recovered", recovered);
        command.Parameters.AddWithValue("blocked", blocked);
        command.Parameters.AddWithValue("conflicts", conflicts);
        command.Parameters.AddWithValue("hash", hash);
        command.Parameters.AddWithValue("started", started);
        command.Parameters.AddWithValue("completed", completed);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return id;
    }

    public async Task<string> AppendRecoveryEvidenceAsync(
        Guid? runId, WalletOperationRecoverySnapshot snapshot, string action, string reason,
        object before, object after, string correlationId, CancellationToken cancellationToken)
    {
        var hash = CanonicalWalletRequestHasher.ComputeEvidenceHash(new(StringComparer.Ordinal)
        {
            ["action"] = action, ["after"] = after, ["before"] = before,
            ["classification"] = snapshot.Classification.ToString(),
            ["correlationId"] = correlationId, ["operationId"] = snapshot.OperationId.ToString("D"),
            ["reason"] = reason, ["runId"] = runId?.ToString("D"), ["time"] = DateTimeOffset.UtcNow.ToString("O")
        });
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into credit_wallet_service.wallet_recovery_evidence(
 recovery_run_id, operation_id, classification, action, before_state, after_state,
 reason_code, canonical_request_hash, canonical_evidence_hash, correlation_id)
values (@run_id,@operation_id,@classification,@action,cast(@before as jsonb),cast(@after as jsonb),
 @reason,@request_hash,@hash,@correlation_id);
""";
        command.Parameters.Add("run_id", NpgsqlDbType.Uuid).Value = (object?)runId ?? DBNull.Value;
        command.Parameters.AddWithValue("operation_id", snapshot.OperationId);
        command.Parameters.AddWithValue("classification", snapshot.Classification.ToString());
        command.Parameters.AddWithValue("action", action);
        command.Parameters.AddWithValue("before", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(before, JsonOptions));
        command.Parameters.AddWithValue("after", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(after, JsonOptions));
        command.Parameters.AddWithValue("reason", reason);
        command.Parameters.AddWithValue("request_hash", snapshot.CanonicalRequestHash);
        command.Parameters.AddWithValue("hash", hash);
        command.Parameters.AddWithValue("correlation_id", correlationId);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return hash;
    }

    public async Task<string> AppendReplayEvidenceAsync(
        WalletOperationRecoverySnapshot snapshot, string result, string? resultHash,
        IReadOnlyList<string> mismatches, string correlationId, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var hash = CanonicalWalletRequestHasher.ComputeEvidenceHash(new(StringComparer.Ordinal)
        {
            ["mismatches"] = mismatches, ["operationId"] = snapshot.OperationId.ToString("D"),
            ["requestHash"] = snapshot.CanonicalRequestHash, ["result"] = result,
            ["resultHash"] = resultHash, ["verifiedAt"] = now.ToString("O")
        });
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into credit_wallet_service.wallet_replay_evidence(
 operation_id, replay_result, original_request_hash, replay_request_hash,
 original_result_hash, replay_result_hash, mismatches, canonical_evidence_hash,
 correlation_id, verified_at)
values (@operation_id,@result,@request_hash,@request_hash,@result_hash,@result_hash,
 cast(@mismatches as jsonb),@hash,@correlation_id,@verified_at);
""";
        command.Parameters.AddWithValue("operation_id", snapshot.OperationId);
        command.Parameters.AddWithValue("result", result);
        command.Parameters.AddWithValue("request_hash", snapshot.CanonicalRequestHash);
        command.Parameters.Add("result_hash", NpgsqlDbType.Text).Value = (object?)resultHash ?? DBNull.Value;
        command.Parameters.AddWithValue("mismatches", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(mismatches));
        command.Parameters.AddWithValue("hash", hash);
        command.Parameters.AddWithValue("correlation_id", correlationId);
        command.Parameters.AddWithValue("verified_at", now);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return hash;
    }

    public async Task<WalletProjectionVerificationResult?> VerifyProjectionAsync(
        Guid walletId, string correlationId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var snapshot = connection.CreateCommand();
        snapshot.Transaction = transaction;
        snapshot.CommandText = """
select fw.balance::bigint, fw.currency_code, fw.wallet_type,
       coalesce((select sum(case when csa.operation_type = 'REVERSAL' then -csa.balance_impact else csa.balance_impact end)
                 from public.credit_settlement_applications csa where csa.wallet_id = fw.id and csa.operation_id is not null), 0)::bigint,
       coalesce((select sum(cr.remaining_exposure) from public.credit_reservations cr
                 where cr.wallet_id = fw.id and cr.scope_model = 'CANONICAL'), 0)::bigint,
       coalesce((select sum(cr.reserved_amount
                   - coalesce((select sum(rel.release_amount) from public.credit_reservation_releases rel where rel.reservation_id = cr.id), 0)
                   - coalesce((select sum(case when app.operation_type = 'REVERSAL' then -app.release_amount else app.release_amount end)
                               from public.credit_settlement_applications app where app.reservation_id = cr.id), 0))
                 from public.credit_reservations cr
                 where cr.wallet_id = fw.id and cr.scope_model = 'CANONICAL'), 0)::bigint
from public.financial_wallets fw where fw.id = @wallet_id;
""";
        snapshot.Parameters.AddWithValue("wallet_id", walletId);
        await using var reader = await snapshot.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        var observedBalance = reader.GetInt64(0);
        var currency = reader.GetString(1);
        var instrument = reader.GetString(2);
        var cumulativeImpact = reader.GetInt64(3);
        var observedExposure = reader.GetInt64(4);
        var expectedExposure = reader.GetInt64(5);
        await reader.CloseAsync();

        var sourceHash = CanonicalWalletRequestHasher.ComputeEvidenceHash(new(StringComparer.Ordinal)
        {
            ["balance"] = observedBalance, ["currency"] = currency, ["instrument"] = instrument,
            ["walletId"] = walletId.ToString("D")
        });
        await using var baseline = connection.CreateCommand();
        baseline.Transaction = transaction;
        baseline.CommandText = """
insert into credit_wallet_service.wallet_projection_baselines(
 wallet_id, baseline_balance, currency, instrument_code, source_snapshot_hash, canonical_evidence_hash)
values (@wallet_id,@baseline,@currency,@instrument,@source_hash,@evidence_hash)
on conflict (wallet_id) do nothing;
select baseline_balance from credit_wallet_service.wallet_projection_baselines where wallet_id = @wallet_id;
""";
        baseline.Parameters.AddWithValue("wallet_id", walletId);
        baseline.Parameters.AddWithValue("baseline", observedBalance - cumulativeImpact);
        baseline.Parameters.AddWithValue("currency", currency);
        baseline.Parameters.AddWithValue("instrument", instrument);
        baseline.Parameters.AddWithValue("source_hash", sourceHash);
        baseline.Parameters.AddWithValue("evidence_hash", CanonicalWalletRequestHasher.ComputeEvidenceHash(new(StringComparer.Ordinal)
        { ["baseline"] = observedBalance - cumulativeImpact, ["source"] = sourceHash, ["walletId"] = walletId.ToString("D") }));
        var baselineBalance = Convert.ToInt64(await baseline.ExecuteScalarAsync(cancellationToken));
        var expectedBalance = baselineBalance + cumulativeImpact;
        var findings = new List<string>();
        if (expectedBalance != observedBalance) findings.Add("WALLET_BALANCE_DRIFT");
        if (expectedExposure != observedExposure) findings.Add("RESERVATION_EXPOSURE_DRIFT");
        var result = findings.Count == 0 ? "MATCH" : "DRIFT";
        var now = DateTimeOffset.UtcNow;
        var evidenceHash = CanonicalWalletRequestHasher.ComputeEvidenceHash(new(StringComparer.Ordinal)
        {
            ["expectedBalance"] = expectedBalance, ["expectedExposure"] = expectedExposure,
            ["findings"] = findings, ["observedBalance"] = observedBalance,
            ["observedExposure"] = observedExposure, ["result"] = result,
            ["verifiedAt"] = now.ToString("O"), ["walletId"] = walletId.ToString("D")
        });
        await using var append = connection.CreateCommand();
        append.Transaction = transaction;
        append.CommandText = """
insert into credit_wallet_service.wallet_projection_verifications(
 wallet_id,verification_result,expected_balance,observed_balance,expected_exposure,
 observed_exposure,findings,canonical_evidence_hash,correlation_id,verified_at)
values (@wallet_id,@result,@expected_balance,@observed_balance,@expected_exposure,
 @observed_exposure,cast(@findings as jsonb),@hash,@correlation_id,@verified_at);
""";
        append.Parameters.AddWithValue("wallet_id", walletId);
        append.Parameters.AddWithValue("result", result);
        append.Parameters.AddWithValue("expected_balance", expectedBalance);
        append.Parameters.AddWithValue("observed_balance", observedBalance);
        append.Parameters.AddWithValue("expected_exposure", expectedExposure);
        append.Parameters.AddWithValue("observed_exposure", observedExposure);
        append.Parameters.AddWithValue("findings", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(findings));
        append.Parameters.AddWithValue("hash", evidenceHash);
        append.Parameters.AddWithValue("correlation_id", correlationId);
        append.Parameters.AddWithValue("verified_at", now);
        await append.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(walletId, result, expectedBalance, observedBalance, expectedExposure,
            observedExposure, findings, evidenceHash, correlationId);
    }

    public Task<WalletReconciliationResult> ReconcileLedgerAsync(
        string correlationId, CancellationToken cancellationToken) => ReconcileAsync("LEDGER", """
select array_remove(array[
  case when a.ledger_posting_required and (a.ledger_posting_request_id is null or p.request_status <> 'COMPLETED') then 'MISSING_COMPLETED_LEDGER_POSTING:' || a.id::text end,
  case when a.ledger_posting_required and (a.ledger_journal_id is distinct from p.journal_transaction_id or a.ledger_entry_id is distinct from p.ledger_entry_id) then 'LEDGER_REFERENCE_MISMATCH:' || a.id::text end,
  case when a.ledger_posting_required and a.ledger_instruction_id is distinct from p.instruction_id::uuid then 'LEDGER_INSTRUCTION_MISMATCH:' || a.id::text end
], null) findings
from public.credit_settlement_applications a
left join ledger_service.ledger_posting_requests p on p.id = a.ledger_posting_request_id
where a.operation_id is not null
""", correlationId, cancellationToken);

    public Task<WalletReconciliationResult> ReconcileSettlementAsync(
        string correlationId, CancellationToken cancellationToken) => ReconcileAsync("SETTLEMENT", """
select array_remove(array[
  case when i.instruction_status not in ('Ready','Skipped') then 'INSTRUCTION_NOT_EXECUTABLE:' || i.instruction_id::text end,
  case when count(a.id) = 0 then 'MISSING_WALLET_TERMINAL:' || i.instruction_id::text end,
  case when count(a.id) > 1 then 'DUPLICATE_WALLET_TERMINAL:' || i.instruction_id::text end
], null) findings
from settlement_service.financial_instructions i
left join public.credit_settlement_applications a
  on a.settlement_instruction_id = i.instruction_id::text and a.source_authority = 'settlement-service'
where i.target_service = 'credit-wallet-service' and i.instruction_type in ('CREDIT_APPLY','CREDIT_REFUND')
group by i.instruction_id, i.instruction_status
union all
select array['ORPHAN_WALLET_APPLICATION:' || a.id::text]
from public.credit_settlement_applications a
where a.operation_id is not null and not exists (
  select 1 from settlement_service.financial_instructions i
  where i.instruction_id::text = a.settlement_instruction_id and i.settlement_id::text = a.settlement_id)
union all
select array['BROKEN_REVERSAL_CORRECTION_CHAIN:' || a.id::text]
from public.credit_settlement_applications a
where a.operation_id is not null and (
 (a.operation_type = 'REVERSAL' and a.original_application_id is null) or
 (a.operation_type in ('PARTIAL_CORRECTION','FULL_CORRECTION') and a.original_application_id is null));
""", correlationId, cancellationToken);

    private async Task<WalletReconciliationResult> ReconcileAsync(
        string type, string query, string correlationId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = query;
        var findings = new List<string>();
        var checkedCount = 0;
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                checkedCount++;
                if (!reader.IsDBNull(0)) findings.AddRange(reader.GetFieldValue<string[]>(0));
            }
        }
        var result = findings.Count == 0 ? "MATCH" : "MISMATCH";
        var now = DateTimeOffset.UtcNow;
        var hash = CanonicalWalletRequestHasher.ComputeEvidenceHash(new(StringComparer.Ordinal)
        {
            ["checked"] = checkedCount, ["findings"] = findings, ["result"] = result,
            ["type"] = type, ["verifiedAt"] = now.ToString("O")
        });
        await using var append = connection.CreateCommand();
        append.CommandText = """
insert into credit_wallet_service.wallet_reconciliation_evidence(
 reconciliation_type,reconciliation_result,checked_count,mismatch_count,findings,
 canonical_evidence_hash,correlation_id,verified_at)
values (@type,@result,@checked,@mismatches,cast(@findings as jsonb),@hash,@correlation_id,@verified_at);
""";
        append.Parameters.AddWithValue("type", type);
        append.Parameters.AddWithValue("result", result);
        append.Parameters.AddWithValue("checked", checkedCount);
        append.Parameters.AddWithValue("mismatches", findings.Count);
        append.Parameters.AddWithValue("findings", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(findings));
        append.Parameters.AddWithValue("hash", hash);
        append.Parameters.AddWithValue("correlation_id", correlationId);
        append.Parameters.AddWithValue("verified_at", now);
        await append.ExecuteNonQueryAsync(cancellationToken);
        return new(type, result, checkedCount, findings.Count, findings, hash, correlationId, now);
    }

    private const string SnapshotSql = """
select r.operation_id, r.idempotency_key, r.canonical_request_hash, r.operation_type,
       tr.terminal_status, coalesce(effect.effect_count,0), effect.reference_type,
       effect.reference_id, r.created_at
from credit_wallet_service.wallet_operation_requests r
left join credit_wallet_service.wallet_operation_terminal_results tr on tr.operation_id = r.operation_id
left join lateral (
  select count(*)::integer effect_count, max(reference_type) reference_type, max(reference_id) reference_id
  from (
    select 'credit_reservation' reference_type, cr.id::text reference_id from public.credit_reservations cr
      where r.operation_type = 'RESERVE' and (
        cr.idempotency_key = 'canonical-wallet:' || replace(r.operation_id::text, '-', '') || ':RESERVE'
        or (tr.effect_reference_type = 'credit_reservation' and cr.id::text = tr.effect_reference_id))
    union all select 'credit_reservation', cr.id::text from public.credit_reservation_releases rel
      join public.credit_reservations cr on cr.id = rel.reservation_id
      where r.operation_type = 'RELEASE' and (rel.operation_id = r.operation_id
        or (tr.effect_reference_type = 'credit_reservation' and cr.id::text = tr.effect_reference_id))
    union all select 'credit_reservation_cancellation', cr.id::text from credit_wallet_service.wallet_reservation_cancellations c
      join public.credit_reservations cr on cr.id = c.reservation_id
      where r.operation_type = 'CANCEL' and (c.operation_id = r.operation_id
        or (tr.effect_reference_type = 'credit_reservation_cancellation' and cr.id::text = tr.effect_reference_id))
    union all select 'credit_settlement_application', a.id::text from public.credit_settlement_applications a
      where r.operation_type in ('SETTLE','REVERSE') and (a.operation_id = r.operation_id
        or (tr.effect_reference_type = 'credit_settlement_application' and a.id::text = tr.effect_reference_id))
  ) effects
) effect on true
""";

    private static async Task<IReadOnlyList<WalletOperationRecoverySnapshot>> ReadSnapshotsAsync(
        NpgsqlCommand command, CancellationToken cancellationToken)
    {
        var results = new List<WalletOperationRecoverySnapshot>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var terminal = GetString(reader, 4);
            var effectCount = reader.GetInt32(5);
            var classification = terminal switch
            {
                "COMMITTED" when effectCount == 1 => WalletRecoveryClassification.COMMITTED,
                "COMMITTED" => WalletRecoveryClassification.CONFLICT,
                "FAILED" => WalletRecoveryClassification.FAILED,
                null when effectCount == 0 => WalletRecoveryClassification.INCOMPLETE,
                null when effectCount == 1 => WalletRecoveryClassification.UNKNOWN,
                _ => WalletRecoveryClassification.CONFLICT
            };
            results.Add(new(reader.GetGuid(0), reader.GetString(1), reader.GetString(2),
                Enum.Parse<WalletOperationType>(reader.GetString(3)), terminal, effectCount,
                GetString(reader, 6), GetString(reader, 7), classification,
                reader.GetFieldValue<DateTimeOffset>(8)));
        }
        return results;
    }

    private async Task<NpgsqlConnection> OpenAsync(CancellationToken cancellationToken)
    {
        if (!Configured) throw new DurableCreditWalletRepositoryException("DATABASE_URL is not configured.");
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static Guid? GetGuid(NpgsqlDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetGuid(ordinal);
    private static string? GetString(NpgsqlDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
}

public sealed record WalletTerminalEvidence(
    string Status,
    string? ReferenceType,
    string? ReferenceId,
    IReadOnlyDictionary<string, object?> Payload,
    string ResultHash,
    string? FailureCode,
    string? FailureReason);
