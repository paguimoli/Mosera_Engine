using System.Text.Json;
using SettlementService.Application;
using SettlementService.Configuration;
using SettlementService.Contracts;
using Npgsql;
using NpgsqlTypes;

namespace SettlementService.Infrastructure;

public sealed class SettlementInputIngestionRepository(ServiceConfiguration configuration)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public bool DurablePersistenceConfigured => !string.IsNullOrWhiteSpace(configuration.Database.Url);

    public async Task<StoredSettlementInputDto?> GetSettlementInputAsync(
        Guid settlementInputId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  settlement_input_id,
  canonical_payload_hash,
  math_evaluation_certificate_id,
  math_evaluation_certificate_hash,
  outcome_certificate_id,
  outcome_certificate_hash,
  ticket_reference,
  game_manifest_id,
  game_manifest_version,
  game_manifest_hash,
  math_model_id,
  math_model_version,
  math_model_hash,
  paytable_id,
  paytable_version,
  paytable_hash,
  evaluator_version,
  evaluation_outcome,
  prize_tier,
  prize_facts_hash,
  payout_units,
  multiplier
from game_engine.settlement_input_records
where settlement_input_id = @settlement_input_id;
""";
        command.Parameters.AddWithValue("settlement_input_id", settlementInputId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? MapSettlementInput(reader)
            : null;
    }

    public async Task<SettlementIngestionResult> ClaimAsync(
        SettlementInputIngestionClaim claim,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var request = claim.Request;
        var requestId = request.SettlementRequestId ?? CreateDeterministicGuid($"{request.IdempotencyKey}:{claim.CanonicalRequestHash}");

        var existing = await FindByIdempotencyKeyAsync(
            connection,
            transaction,
            request.IdempotencyKey,
            cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.CanonicalRequestHash, claim.CanonicalRequestHash, StringComparison.Ordinal))
            {
                var conflictAttemptId = Guid.NewGuid();
                await AppendAttemptAsync(
                    connection,
                    transaction,
                    existing.SettlementRequestId,
                    conflictAttemptId,
                    SettlementIngestionStatus.Conflict,
                    ["Conflicting canonical request hash for idempotency key."],
                    cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                throw new SettlementInputIngestionConflictException("Conflicting SettlementInput ingestion payload for the same idempotency key.");
            }

            var duplicateAttemptId = Guid.NewGuid();
            var evidenceHash = await AppendAttemptAsync(
                connection,
                transaction,
                existing.SettlementRequestId,
                duplicateAttemptId,
                SettlementIngestionStatus.Accepted,
                [],
                cancellationToken);
            await transaction.CommitAsync(cancellationToken);

            return new SettlementIngestionResult(
                existing.SettlementRequestId,
                existing.IdempotencyKey,
                existing.CanonicalRequestHash,
                existing.SettlementInputId,
                existing.SettlementInputHash,
                SettlementIngestionStatus.Accepted,
                true,
                duplicateAttemptId,
                evidenceHash,
                correlationId);
        }

        await InsertRequestAsync(connection, transaction, requestId, claim, cancellationToken);
        var attemptId = Guid.NewGuid();
        var attemptEvidenceHash = await AppendAttemptAsync(
            connection,
            transaction,
            requestId,
            attemptId,
            SettlementIngestionStatus.Accepted,
            [],
            cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        return new SettlementIngestionResult(
            requestId,
            request.IdempotencyKey,
            claim.CanonicalRequestHash,
            request.SettlementInputId,
            request.SettlementInputHash,
            SettlementIngestionStatus.Accepted,
            false,
            attemptId,
            attemptEvidenceHash,
            correlationId);
    }

    public async Task<SettlementIngestionReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        if (!DurablePersistenceConfigured)
        {
            return new SettlementIngestionReadiness(
                false,
                false,
                true,
                true,
                false,
                true,
                ["DATABASE_URL is not configured for SettlementInput ingestion."]);
        }

        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('settlement_service.settlement_requests') is not null
  and to_regclass('settlement_service.settlement_request_attempts') is not null
  and to_regclass('game_engine.settlement_input_records') is not null;
""";
            var ready = await command.ExecuteScalarAsync(cancellationToken) is true;
            return new SettlementIngestionReadiness(
                true,
                ready,
                true,
                true,
                ready,
                true,
                ready ? [] : ["SettlementInput ingestion tables are missing."]);
        }
        catch (Exception error) when (error is NpgsqlException or InvalidOperationException or OperationCanceledException)
        {
            return new SettlementIngestionReadiness(
                true,
                false,
                true,
                true,
                false,
                true,
                [error.Message]);
        }
    }

    private async Task InsertRequestAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid requestId,
        SettlementInputIngestionClaim claim,
        CancellationToken cancellationToken)
    {
        var request = claim.Request;
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into settlement_service.settlement_requests (
  settlement_request_id,
  idempotency_key,
  canonical_request_hash,
  settlement_input_id,
  settlement_input_hash,
  math_evaluation_certificate_id,
  math_evaluation_certificate_hash,
  outcome_certificate_id,
  outcome_certificate_hash,
  ticket_id,
  ticket_line_id,
  player_account_reference,
  accepted_wager_financial_context_reference,
  accepted_stake_amount_minor,
  currency,
  minor_unit_precision,
  rounding_policy_reference,
  credit_reservation_reference,
  settlement_policy_version,
  accepted_at,
  mode,
  status,
  request_provenance
)
values (
  @settlement_request_id,
  @idempotency_key,
  @canonical_request_hash,
  @settlement_input_id,
  @settlement_input_hash,
  @math_evaluation_certificate_id,
  @math_evaluation_certificate_hash,
  @outcome_certificate_id,
  @outcome_certificate_hash,
  @ticket_id,
  @ticket_line_id,
  @player_account_reference,
  @accepted_wager_financial_context_reference,
  @accepted_stake_amount_minor,
  @currency,
  @minor_unit_precision,
  @rounding_policy_reference,
  @credit_reservation_reference,
  @settlement_policy_version,
  @accepted_at,
  @mode,
  @status,
  cast(@request_provenance as jsonb)
);
""";
        command.Parameters.AddWithValue("settlement_request_id", requestId);
        command.Parameters.AddWithValue("idempotency_key", request.IdempotencyKey);
        command.Parameters.AddWithValue("canonical_request_hash", claim.CanonicalRequestHash);
        command.Parameters.AddWithValue("settlement_input_id", request.SettlementInputId);
        command.Parameters.AddWithValue("settlement_input_hash", request.SettlementInputHash);
        command.Parameters.AddWithValue("math_evaluation_certificate_id", request.MathEvaluationCertificateId);
        command.Parameters.AddWithValue("math_evaluation_certificate_hash", request.MathEvaluationCertificateHash);
        command.Parameters.AddWithValue("outcome_certificate_id", request.OutcomeCertificateId);
        command.Parameters.AddWithValue("outcome_certificate_hash", request.OutcomeCertificateHash);
        command.Parameters.AddWithValue("ticket_id", request.TicketId);
        command.Parameters.AddWithValue("ticket_line_id", request.TicketLineId);
        command.Parameters.AddWithValue("player_account_reference", request.PlayerAccountReference);
        command.Parameters.AddWithValue("accepted_wager_financial_context_reference", request.AcceptedWagerFinancialContextReference);
        command.Parameters.AddWithValue("accepted_stake_amount_minor", request.AcceptedStakeAmountMinor);
        command.Parameters.AddWithValue("currency", request.Currency);
        command.Parameters.AddWithValue("minor_unit_precision", request.MinorUnitPrecision);
        command.Parameters.AddWithValue("rounding_policy_reference", request.RoundingPolicyReference);
        AddNullable(command, "credit_reservation_reference", NpgsqlDbType.Text, request.CreditReservationReference);
        command.Parameters.AddWithValue("settlement_policy_version", request.SettlementPolicyVersion);
        command.Parameters.AddWithValue("accepted_at", request.AcceptedAt);
        command.Parameters.AddWithValue("mode", request.Mode.ToString());
        command.Parameters.AddWithValue("status", SettlementIngestionStatus.Accepted.ToString());
        command.Parameters.AddWithValue("request_provenance", JsonSerializer.Serialize(request.RequestProvenance ?? new Dictionary<string, object?>(), JsonOptions));

        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<SettlementRequestRecord?> FindByIdempotencyKeyAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select
  settlement_request_id,
  idempotency_key,
  canonical_request_hash,
  settlement_input_id,
  settlement_input_hash
from settlement_service.settlement_requests
where idempotency_key = @idempotency_key
for update;
""";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new SettlementRequestRecord(
                reader.GetGuid(reader.GetOrdinal("settlement_request_id")),
                reader.GetString(reader.GetOrdinal("idempotency_key")),
                reader.GetString(reader.GetOrdinal("canonical_request_hash")),
                reader.GetGuid(reader.GetOrdinal("settlement_input_id")),
                reader.GetString(reader.GetOrdinal("settlement_input_hash")))
            : null;
    }

    private static async Task<string> AppendAttemptAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid requestId,
        Guid attemptId,
        SettlementIngestionStatus status,
        IReadOnlyList<string> validationErrors,
        CancellationToken cancellationToken)
    {
        var attemptNumber = await NextAttemptNumberAsync(connection, transaction, requestId, cancellationToken);
        var evidenceHash = SettlementInputIngestionService.HashCanonical(
            $"{requestId:N}|{attemptId:N}|{attemptNumber}|{status}|{string.Join("|", validationErrors)}");

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into settlement_service.settlement_request_attempts (
  attempt_id,
  settlement_request_id,
  attempt_number,
  status,
  evidence_hash,
  validation_errors
)
values (
  @attempt_id,
  @settlement_request_id,
  @attempt_number,
  @status,
  @evidence_hash,
  cast(@validation_errors as jsonb)
);
""";
        command.Parameters.AddWithValue("attempt_id", attemptId);
        command.Parameters.AddWithValue("settlement_request_id", requestId);
        command.Parameters.AddWithValue("attempt_number", attemptNumber);
        command.Parameters.AddWithValue("status", status.ToString());
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);
        command.Parameters.AddWithValue("validation_errors", JsonSerializer.Serialize(validationErrors, JsonOptions));
        await command.ExecuteNonQueryAsync(cancellationToken);
        return evidenceHash;
    }

    private static async Task<int> NextAttemptNumberAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid requestId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select coalesce(max(attempt_number), 0) + 1
from settlement_service.settlement_request_attempts
where settlement_request_id = @settlement_request_id;
""";
        command.Parameters.AddWithValue("settlement_request_id", requestId);
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

    private static StoredSettlementInputDto MapSettlementInput(NpgsqlDataReader reader)
    {
        return new StoredSettlementInputDto(
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
    }

    private static Guid CreateDeterministicGuid(string value)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value));
        return new Guid(bytes[..16]);
    }

    private static void AddNullable(NpgsqlCommand command, string name, NpgsqlDbType type, object? value)
    {
        var parameter = command.Parameters.Add(name, type);
        parameter.Value = value ?? DBNull.Value;
    }

    private sealed record SettlementRequestRecord(
        Guid SettlementRequestId,
        string IdempotencyKey,
        string CanonicalRequestHash,
        Guid SettlementInputId,
        string SettlementInputHash);
}
