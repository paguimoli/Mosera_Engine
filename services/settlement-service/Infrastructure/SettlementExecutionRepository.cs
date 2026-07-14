using System.Text.Json;
using SettlementService.Application;
using SettlementService.Configuration;
using SettlementService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace SettlementService.Infrastructure;

public sealed record SettlementRequestExecutionContext(
    Guid SettlementRequestId,
    string IdempotencyKey,
    string CanonicalRequestHash,
    Guid SettlementInputId,
    string SettlementInputHash,
    Guid MathEvaluationCertificateId,
    string MathEvaluationCertificateHash,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    string TicketId,
    string TicketLineId,
    string PlayerAccountReference,
    long AcceptedStakeAmountMinor,
    string Currency,
    int MinorUnitPrecision,
    string SettlementPolicyVersion,
    StoredSettlementInputDto StoredSettlementInput);

public sealed class SettlementExecutionRepository(ServiceConfiguration configuration)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public bool DurablePersistenceConfigured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<SettlementRequestExecutionContext?> GetSettlementRequestAsync(
        Guid settlementRequestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  request.settlement_request_id,
  request.idempotency_key,
  request.canonical_request_hash,
  request.settlement_input_id,
  request.settlement_input_hash,
  request.math_evaluation_certificate_id,
  request.math_evaluation_certificate_hash,
  request.outcome_certificate_id,
  request.outcome_certificate_hash,
  request.ticket_id,
  request.ticket_line_id,
  request.player_account_reference,
  request.accepted_stake_amount_minor,
  request.currency,
  request.minor_unit_precision,
  request.settlement_policy_version,
  input.ticket_reference,
  input.game_manifest_id,
  input.game_manifest_version,
  input.game_manifest_hash,
  input.math_model_id,
  input.math_model_version,
  input.math_model_hash,
  input.paytable_id,
  input.paytable_version,
  input.paytable_hash,
  input.evaluator_version,
  input.evaluation_outcome,
  input.prize_tier,
  input.prize_facts_hash,
  input.payout_units,
  input.multiplier,
  input.canonical_payload_hash
from settlement_service.settlement_requests request
join game_engine.settlement_input_records input
  on input.settlement_input_id = request.settlement_input_id
where request.settlement_request_id = @settlement_request_id;
""";
        command.Parameters.AddWithValue("settlement_request_id", settlementRequestId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? MapExecutionContext(reader)
            : null;
    }

    public async Task<SettlementRecordResponse?> GetRecordByRequestIdAsync(
        Guid settlementRequestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await GetRecordByRequestIdAsync(connection, null, settlementRequestId, cancellationToken);
    }

    public async Task<SettlementExecutionResult> CompleteAsync(
        SettlementRequestExecutionContext request,
        SettlementComputation computation,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var existing = await GetRecordByRequestIdAsync(connection, transaction, request.SettlementRequestId, cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.CanonicalSettlementHash, computation.CanonicalSettlementHash, StringComparison.Ordinal))
            {
                var conflictAttemptId = Guid.NewGuid();
                var conflictHash = await AppendAttemptAsync(
                    connection,
                    transaction,
                    request.SettlementRequestId,
                    conflictAttemptId,
                    SettlementExecutionStatus.Conflict,
                    computation.CanonicalSettlementHash,
                    ["Conflicting canonical settlement hash for completed request."],
                    cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                throw new SettlementExecutionConflictException("Conflicting settlement execution payload for completed request.");
            }

            var duplicateAttemptId = Guid.NewGuid();
            var duplicateHash = await AppendAttemptAsync(
                connection,
                transaction,
                request.SettlementRequestId,
                duplicateAttemptId,
                SettlementExecutionStatus.Completed,
                existing.CanonicalSettlementHash,
                [],
                cancellationToken);
            await transaction.CommitAsync(cancellationToken);

            return new SettlementExecutionResult(
                SettlementExecutionStatus.Completed,
                true,
                existing,
                duplicateAttemptId,
                duplicateHash,
                correlationId);
        }

        await InsertRecordAsync(connection, transaction, request, computation, cancellationToken);
        var attemptId = Guid.NewGuid();
        var attemptHash = await AppendAttemptAsync(
            connection,
            transaction,
            request.SettlementRequestId,
            attemptId,
            SettlementExecutionStatus.Completed,
            computation.CanonicalSettlementHash,
            [],
            cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        var record = await GetRecordByRequestIdAsync(request.SettlementRequestId, cancellationToken)
            ?? throw new InvalidOperationException("SettlementRecord insert did not read back.");
        return new SettlementExecutionResult(
            SettlementExecutionStatus.Completed,
            false,
            record,
            attemptId,
            attemptHash,
            correlationId);
    }

    public async Task<SettlementExecutionResult> AppendReplayVerifiedAsync(
        SettlementRecordResponse record,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var attemptId = Guid.NewGuid();
        var evidenceHash = await AppendAttemptAsync(
            connection,
            transaction,
            record.SettlementRequestId,
            attemptId,
            SettlementExecutionStatus.ReplayVerified,
            record.CanonicalSettlementHash,
            [],
            cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        return new SettlementExecutionResult(
            SettlementExecutionStatus.ReplayVerified,
            true,
            record,
            attemptId,
            evidenceHash,
            correlationId);
    }

    public async Task<SettlementExecutionResult> AppendReplayMismatchAsync(
        Guid settlementRequestId,
        string computedHash,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var existing = await GetRecordByRequestIdAsync(connection, transaction, settlementRequestId, cancellationToken)
            ?? throw new SettlementExecutionValidationException(["SettlementRecord was not found for replay mismatch evidence."]);
        var attemptId = Guid.NewGuid();
        var evidenceHash = await AppendAttemptAsync(
            connection,
            transaction,
            settlementRequestId,
            attemptId,
            SettlementExecutionStatus.ReplayMismatch,
            computedHash,
            ["Replay recomputation did not match completed SettlementRecord."],
            cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        return new SettlementExecutionResult(
            SettlementExecutionStatus.ReplayMismatch,
            true,
            existing,
            attemptId,
            evidenceHash,
            correlationId);
    }

    public async Task<SettlementExecutionReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            return new SettlementExecutionReadiness(
                false,
                false,
                true,
                true,
                false,
                true,
                true,
                ["DATABASE_URL is not configured for Settlement execution."]);
        }

        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('settlement_service.authoritative_settlement_records') is not null
  and to_regclass('settlement_service.settlement_execution_attempts') is not null
  and to_regclass('settlement_service.settlement_requests') is not null
  and to_regclass('game_engine.settlement_input_records') is not null;
""";
            var ready = await command.ExecuteScalarAsync(cancellationToken) is true;
            return new SettlementExecutionReadiness(
                true,
                ready,
                ready,
                true,
                ready,
                ready,
                true,
                ready ? [] : ["Settlement execution tables are missing."]);
        }
        catch (Exception error) when (error is NpgsqlException or InvalidOperationException or OperationCanceledException)
        {
            return new SettlementExecutionReadiness(
                true,
                false,
                true,
                true,
                false,
                false,
                true,
                [error.Message]);
        }
    }

    private static async Task InsertRecordAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        SettlementRequestExecutionContext request,
        SettlementComputation computation,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into settlement_service.authoritative_settlement_records (
  settlement_id,
  settlement_request_id,
  settlement_input_id,
  settlement_input_hash,
  math_evaluation_certificate_id,
  math_evaluation_certificate_hash,
  outcome_certificate_id,
  outcome_certificate_hash,
  ticket_id,
  ticket_line_id,
  player_account_reference,
  currency,
  minor_unit_precision,
  stake_amount_minor,
  gross_payout_amount_minor,
  net_result_amount_minor,
  settlement_outcome,
  policy_version,
  canonical_settlement_hash,
  idempotency_key,
  issued_at,
  provenance
)
values (
  @settlement_id,
  @settlement_request_id,
  @settlement_input_id,
  @settlement_input_hash,
  @math_evaluation_certificate_id,
  @math_evaluation_certificate_hash,
  @outcome_certificate_id,
  @outcome_certificate_hash,
  @ticket_id,
  @ticket_line_id,
  @player_account_reference,
  @currency,
  @minor_unit_precision,
  @stake_amount_minor,
  @gross_payout_amount_minor,
  @net_result_amount_minor,
  @settlement_outcome,
  @policy_version,
  @canonical_settlement_hash,
  @idempotency_key,
  @issued_at,
  cast(@provenance as jsonb)
);
""";
        command.Parameters.AddWithValue("settlement_id", computation.SettlementId);
        command.Parameters.AddWithValue("settlement_request_id", request.SettlementRequestId);
        command.Parameters.AddWithValue("settlement_input_id", request.SettlementInputId);
        command.Parameters.AddWithValue("settlement_input_hash", request.SettlementInputHash);
        command.Parameters.AddWithValue("math_evaluation_certificate_id", request.MathEvaluationCertificateId);
        command.Parameters.AddWithValue("math_evaluation_certificate_hash", request.MathEvaluationCertificateHash);
        command.Parameters.AddWithValue("outcome_certificate_id", request.OutcomeCertificateId);
        command.Parameters.AddWithValue("outcome_certificate_hash", request.OutcomeCertificateHash);
        command.Parameters.AddWithValue("ticket_id", request.TicketId);
        command.Parameters.AddWithValue("ticket_line_id", request.TicketLineId);
        command.Parameters.AddWithValue("player_account_reference", request.PlayerAccountReference);
        command.Parameters.AddWithValue("currency", request.Currency);
        command.Parameters.AddWithValue("minor_unit_precision", request.MinorUnitPrecision);
        command.Parameters.AddWithValue("stake_amount_minor", request.AcceptedStakeAmountMinor);
        command.Parameters.AddWithValue("gross_payout_amount_minor", computation.GrossPayoutAmountMinor);
        command.Parameters.AddWithValue("net_result_amount_minor", computation.NetResultAmountMinor);
        command.Parameters.AddWithValue("settlement_outcome", computation.SettlementOutcome);
        command.Parameters.AddWithValue("policy_version", request.SettlementPolicyVersion);
        command.Parameters.AddWithValue("canonical_settlement_hash", computation.CanonicalSettlementHash);
        command.Parameters.AddWithValue("idempotency_key", request.IdempotencyKey);
        command.Parameters.AddWithValue("issued_at", DateTimeOffset.UtcNow);
        command.Parameters.AddWithValue("provenance", JsonSerializer.Serialize(computation.Provenance, JsonOptions));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<SettlementRecordResponse?> GetRecordByRequestIdAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        Guid settlementRequestId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select *
from settlement_service.authoritative_settlement_records
where settlement_request_id = @settlement_request_id
for update;
""";
        command.Parameters.AddWithValue("settlement_request_id", settlementRequestId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapRecord(reader) : null;
    }

    private static async Task<string> AppendAttemptAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid settlementRequestId,
        Guid attemptId,
        SettlementExecutionStatus status,
        string? canonicalSettlementHash,
        IReadOnlyList<string> errors,
        CancellationToken cancellationToken)
    {
        var attemptNumber = await NextAttemptNumberAsync(connection, transaction, settlementRequestId, cancellationToken);
        var evidenceHash = SettlementExecutionService.HashCanonical(
            $"{settlementRequestId:N}|{attemptId:N}|{attemptNumber}|{status}|{canonicalSettlementHash}|{string.Join("|", errors)}");

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into settlement_service.settlement_execution_attempts (
  attempt_id,
  settlement_request_id,
  attempt_number,
  status,
  canonical_settlement_hash,
  evidence_hash,
  errors
)
values (
  @attempt_id,
  @settlement_request_id,
  @attempt_number,
  @status,
  @canonical_settlement_hash,
  @evidence_hash,
  cast(@errors as jsonb)
);
""";
        command.Parameters.AddWithValue("attempt_id", attemptId);
        command.Parameters.AddWithValue("settlement_request_id", settlementRequestId);
        command.Parameters.AddWithValue("attempt_number", attemptNumber);
        command.Parameters.AddWithValue("status", status.ToString());
        AddNullable(command, "canonical_settlement_hash", NpgsqlDbType.Text, canonicalSettlementHash);
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);
        command.Parameters.AddWithValue("errors", JsonSerializer.Serialize(errors, JsonOptions));
        await command.ExecuteNonQueryAsync(cancellationToken);
        return evidenceHash;
    }

    private static async Task<int> NextAttemptNumberAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid settlementRequestId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select coalesce(max(attempt_number), 0) + 1
from settlement_service.settlement_execution_attempts
where settlement_request_id = @settlement_request_id;
""";
        command.Parameters.AddWithValue("settlement_request_id", settlementRequestId);
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken));
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            throw new InvalidOperationException("DATABASE_URL is not configured.");
        }

        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(configuration.Database.Url));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static SettlementRequestExecutionContext MapExecutionContext(NpgsqlDataReader reader)
    {
        var storedInput = new StoredSettlementInputDto(
            reader.GetGuid(reader.GetOrdinal("settlement_input_id")),
            reader.GetString(reader.GetOrdinal("canonical_payload_hash")),
            reader.GetGuid(reader.GetOrdinal("math_evaluation_certificate_id")),
            reader.GetString(reader.GetOrdinal("math_evaluation_certificate_hash")),
            reader.GetGuid(reader.GetOrdinal("outcome_certificate_id")),
            reader.GetString(reader.GetOrdinal("outcome_certificate_hash")),
            reader.GetString(reader.GetOrdinal("ticket_reference")),
            reader.GetString(reader.GetOrdinal("game_manifest_id")),
            reader.GetString(reader.GetOrdinal("game_manifest_version")),
            reader.GetString(reader.GetOrdinal("game_manifest_hash")),
            reader.GetString(reader.GetOrdinal("math_model_id")),
            reader.GetString(reader.GetOrdinal("math_model_version")),
            reader.GetString(reader.GetOrdinal("math_model_hash")),
            reader.GetString(reader.GetOrdinal("paytable_id")),
            reader.GetString(reader.GetOrdinal("paytable_version")),
            reader.GetString(reader.GetOrdinal("paytable_hash")),
            reader.GetString(reader.GetOrdinal("evaluator_version")),
            reader.GetString(reader.GetOrdinal("evaluation_outcome")),
            reader.GetString(reader.GetOrdinal("prize_tier")),
            reader.GetString(reader.GetOrdinal("prize_facts_hash")),
            reader.GetDecimal(reader.GetOrdinal("payout_units")),
            reader.GetDecimal(reader.GetOrdinal("multiplier")),
            reader.GetString(reader.GetOrdinal("canonical_payload_hash")));

        return new SettlementRequestExecutionContext(
            reader.GetGuid(reader.GetOrdinal("settlement_request_id")),
            reader.GetString(reader.GetOrdinal("idempotency_key")),
            reader.GetString(reader.GetOrdinal("canonical_request_hash")),
            reader.GetGuid(reader.GetOrdinal("settlement_input_id")),
            reader.GetString(reader.GetOrdinal("settlement_input_hash")),
            reader.GetGuid(reader.GetOrdinal("math_evaluation_certificate_id")),
            reader.GetString(reader.GetOrdinal("math_evaluation_certificate_hash")),
            reader.GetGuid(reader.GetOrdinal("outcome_certificate_id")),
            reader.GetString(reader.GetOrdinal("outcome_certificate_hash")),
            reader.GetString(reader.GetOrdinal("ticket_id")),
            reader.GetString(reader.GetOrdinal("ticket_line_id")),
            reader.GetString(reader.GetOrdinal("player_account_reference")),
            reader.GetInt64(reader.GetOrdinal("accepted_stake_amount_minor")),
            reader.GetString(reader.GetOrdinal("currency")),
            reader.GetInt32(reader.GetOrdinal("minor_unit_precision")),
            reader.GetString(reader.GetOrdinal("settlement_policy_version")),
            storedInput);
    }

    private static SettlementRecordResponse MapRecord(NpgsqlDataReader reader)
    {
        var provenance = JsonSerializer.Deserialize<Dictionary<string, object?>>(
            reader.GetString(reader.GetOrdinal("provenance")),
            JsonOptions) ?? new Dictionary<string, object?>();

        return new SettlementRecordResponse(
            reader.GetGuid(reader.GetOrdinal("settlement_id")),
            reader.GetGuid(reader.GetOrdinal("settlement_request_id")),
            reader.GetGuid(reader.GetOrdinal("settlement_input_id")),
            reader.GetString(reader.GetOrdinal("settlement_input_hash")),
            reader.GetGuid(reader.GetOrdinal("math_evaluation_certificate_id")),
            reader.GetString(reader.GetOrdinal("math_evaluation_certificate_hash")),
            reader.GetGuid(reader.GetOrdinal("outcome_certificate_id")),
            reader.GetString(reader.GetOrdinal("outcome_certificate_hash")),
            reader.GetString(reader.GetOrdinal("ticket_id")),
            reader.GetString(reader.GetOrdinal("ticket_line_id")),
            reader.GetString(reader.GetOrdinal("player_account_reference")),
            reader.GetString(reader.GetOrdinal("currency")),
            reader.GetInt32(reader.GetOrdinal("minor_unit_precision")),
            reader.GetInt64(reader.GetOrdinal("stake_amount_minor")),
            reader.GetInt64(reader.GetOrdinal("gross_payout_amount_minor")),
            reader.GetInt64(reader.GetOrdinal("net_result_amount_minor")),
            reader.GetString(reader.GetOrdinal("settlement_outcome")),
            reader.GetString(reader.GetOrdinal("policy_version")),
            reader.GetString(reader.GetOrdinal("canonical_settlement_hash")),
            reader.GetString(reader.GetOrdinal("idempotency_key")),
            reader.GetFieldValue<DateTimeOffset>(reader.GetOrdinal("issued_at")),
            provenance);
    }

    private static void AddNullable(NpgsqlCommand command, string name, NpgsqlDbType type, object? value)
    {
        var parameter = command.Parameters.Add(name, type);
        parameter.Value = value ?? DBNull.Value;
    }
}
