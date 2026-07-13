using System.Text.Json;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;
using NpgsqlTypes;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresSettlementInputRepository : ISettlementInputRepository
{
    private readonly string connectionString;

    public PostgresSettlementInputRepository(string databaseUrl)
    {
        connectionString = PostgresConnectionString.Normalize(databaseUrl);
    }

    public async Task<SettlementInput?> FindByMathEvaluationCertificateAsync(
        Guid mathEvaluationCertificateId,
        string mathEvaluationCertificateHash,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"{SelectSql} where math_evaluation_certificate_id = @certificate_id and math_evaluation_certificate_hash = @certificate_hash order by created_at desc limit 1;";
        command.Parameters.AddWithValue("certificate_id", mathEvaluationCertificateId);
        command.Parameters.AddWithValue("certificate_hash", mathEvaluationCertificateHash);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapInput(reader) : null;
    }

    public async Task<SettlementInput?> FindByCanonicalPayloadHashAsync(
        string canonicalPayloadHash,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"{SelectSql} where canonical_payload_hash = @canonical_payload_hash order by created_at desc limit 1;";
        command.Parameters.AddWithValue("canonical_payload_hash", canonicalPayloadHash);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapInput(reader) : null;
    }

    public async Task<SettlementInput> SaveAsync(
        SettlementInput input,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        var existing = await FindByMathEvaluationCertificateAsync(
            input.MathEvaluationCertificateId,
            input.MathEvaluationCertificateHash,
            cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.CanonicalPayloadHash, input.CanonicalPayloadHash, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Conflicting SettlementInput payload for the same Math Evaluation Certificate.");
            }

            return existing;
        }

        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.settlement_input_records (
  settlement_input_id,
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
  prize_facts,
  prize_facts_hash,
  payout_units,
  multiplier,
  replay_hash,
  idempotency_key,
  issued_at,
  provenance,
  canonical_payload,
  canonical_payload_hash)
values (
  @settlement_input_id,
  @math_evaluation_certificate_id,
  @math_evaluation_certificate_hash,
  @outcome_certificate_id,
  @outcome_certificate_hash,
  @ticket_reference,
  @game_manifest_id,
  @game_manifest_version,
  @game_manifest_hash,
  @math_model_id,
  @math_model_version,
  @math_model_hash,
  @paytable_id,
  @paytable_version,
  @paytable_hash,
  @evaluator_version,
  @evaluation_outcome,
  @prize_tier,
  @prize_facts,
  @prize_facts_hash,
  @payout_units,
  @multiplier,
  @replay_hash,
  @idempotency_key,
  @issued_at,
  @provenance,
  @canonical_payload,
  @canonical_payload_hash)
on conflict (math_evaluation_certificate_id, math_evaluation_certificate_hash)
do nothing;
""";
        AddInputParameters(command, input);
        var inserted = await command.ExecuteNonQueryAsync(cancellationToken);
        if (inserted == 1)
        {
            return input;
        }

        var afterConflict = await FindByMathEvaluationCertificateAsync(
            input.MathEvaluationCertificateId,
            input.MathEvaluationCertificateHash,
            cancellationToken)
            ?? throw new InvalidOperationException("SettlementInput conflict could not be read deterministically.");
        if (!string.Equals(afterConflict.CanonicalPayloadHash, input.CanonicalPayloadHash, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Conflicting SettlementInput payload for the same Math Evaluation Certificate.");
        }

        return afterConflict;
    }

    public async Task<SettlementInputReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        try
        {
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "select to_regclass('game_engine.settlement_input_records') is not null;";
            var exists = await command.ExecuteScalarAsync(cancellationToken) as bool? == true;
            if (!exists)
            {
                blockers.Add("game_engine.settlement_input_records is missing.");
            }
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or InvalidOperationException)
        {
            blockers.Add(error.Message);
        }

        return new SettlementInputReadiness(
            SettlementHandoffReady: blockers.Count == 0,
            AdapterReady: true,
            CertificateValidationReady: true,
            CanonicalPayloadReady: true,
            ReplayReady: true,
            RepositoryConfigured: true,
            RepositoryReachable: blockers.Count == 0,
            ProductionActivationDisabled: true,
            Blockers: blockers);
    }

    private static void AddInputParameters(NpgsqlCommand command, SettlementInput input)
    {
        command.Parameters.AddWithValue("settlement_input_id", input.SettlementInputId);
        command.Parameters.AddWithValue("math_evaluation_certificate_id", input.MathEvaluationCertificateId);
        command.Parameters.AddWithValue("math_evaluation_certificate_hash", input.MathEvaluationCertificateHash);
        command.Parameters.AddWithValue("outcome_certificate_id", input.OutcomeCertificateId);
        command.Parameters.AddWithValue("outcome_certificate_hash", input.OutcomeCertificateHash);
        command.Parameters.AddWithValue("ticket_reference", input.TicketReference);
        command.Parameters.AddWithValue("game_manifest_id", input.GameManifestId);
        command.Parameters.AddWithValue("game_manifest_version", input.GameManifestVersion);
        command.Parameters.AddWithValue("game_manifest_hash", input.GameManifestHash);
        command.Parameters.AddWithValue("math_model_id", input.MathModelId);
        command.Parameters.AddWithValue("math_model_version", input.MathModelVersion);
        command.Parameters.AddWithValue("math_model_hash", input.MathModelHash);
        command.Parameters.AddWithValue("paytable_id", input.PaytableId);
        command.Parameters.AddWithValue("paytable_version", input.PaytableVersion);
        command.Parameters.AddWithValue("paytable_hash", input.PaytableHash);
        command.Parameters.AddWithValue("evaluator_version", input.EvaluatorVersion);
        command.Parameters.AddWithValue("evaluation_outcome", input.EvaluationOutcome.ToString());
        command.Parameters.AddWithValue("prize_tier", input.PrizeTier);
        command.Parameters.AddWithValue("prize_facts", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(input.PrizeFacts));
        command.Parameters.AddWithValue("prize_facts_hash", input.PrizeFactsHash);
        command.Parameters.AddWithValue("payout_units", input.PayoutUnits);
        command.Parameters.AddWithValue("multiplier", input.Multiplier);
        command.Parameters.AddWithValue("replay_hash", input.ReplayHash);
        command.Parameters.AddWithValue("idempotency_key", input.IdempotencyKey);
        command.Parameters.AddWithValue("issued_at", input.IssuedAt);
        command.Parameters.AddWithValue("provenance", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(input.Provenance));
        command.Parameters.AddWithValue("canonical_payload", NpgsqlDbType.Jsonb, input.CanonicalPayloadJson);
        command.Parameters.AddWithValue("canonical_payload_hash", input.CanonicalPayloadHash);
    }

    private static SettlementInput MapInput(NpgsqlDataReader reader)
    {
        var prizeFacts = JsonSerializer.Deserialize<PrizeFacts>(reader.GetString(18))
            ?? throw new InvalidOperationException("Stored SettlementInput PrizeFacts could not be deserialized.");
        var provenance = JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(26))
            ?? throw new InvalidOperationException("Stored SettlementInput provenance could not be deserialized.");
        return new SettlementInput(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetString(2),
            reader.GetGuid(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetString(6),
            reader.GetString(7),
            reader.GetString(8),
            reader.GetString(9),
            reader.GetString(10),
            reader.GetString(11),
            reader.GetString(12),
            reader.GetString(13),
            reader.GetString(14),
            reader.GetString(15),
            Enum.Parse<PrizeOutcome>(reader.GetString(16)),
            reader.GetString(17),
            prizeFacts,
            reader.GetString(19),
            reader.GetDecimal(20),
            reader.GetDecimal(21),
            reader.GetString(22),
            reader.GetString(23),
            reader.GetFieldValue<DateTimeOffset>(24),
            provenance,
            reader.GetString(25),
            reader.GetString(27));
    }

    private const string SelectSql = """
select
  settlement_input_id,
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
  prize_facts::text,
  prize_facts_hash,
  payout_units,
  multiplier,
  replay_hash,
  idempotency_key,
  issued_at,
  canonical_payload::text,
  provenance::text,
  canonical_payload_hash
from game_engine.settlement_input_records
""";
}
