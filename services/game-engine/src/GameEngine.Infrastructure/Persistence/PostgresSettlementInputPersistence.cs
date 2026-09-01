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
            connection,
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
  canonical_payload_hash,
  input_kind)
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
  @canonical_payload_hash,
  @input_kind)
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
            connection,
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

    public async Task<SettlementInput?> FindTicketDrawAggregateAsync(
        Guid ticketId,
        Guid drawId,
        Guid outcomeCertificateId,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
{SelectSql}
join game_engine.ticket_draw_settlement_aggregates aggregate
  on aggregate.settlement_input_id = settlement_input_records.settlement_input_id
where aggregate.ticket_id = @ticket_id
  and aggregate.draw_id = @draw_id
  and settlement_input_records.outcome_certificate_id = @outcome_certificate_id
limit 1;
""";
        command.Parameters.AddWithValue("ticket_id", ticketId);
        command.Parameters.AddWithValue("draw_id", drawId);
        command.Parameters.AddWithValue("outcome_certificate_id", outcomeCertificateId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapInput(reader) : null;
    }

    public async Task<SettlementInput> SaveTicketDrawAggregateAsync(
        SettlementInput input,
        TicketDrawSettlementAggregateEvidence aggregate,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var lockCommand = connection.CreateCommand())
        {
            lockCommand.Transaction = transaction;
            lockCommand.CommandText = "select pg_advisory_xact_lock(hashtextextended(@scope, 0));";
            lockCommand.Parameters.AddWithValue("scope", $"ticket-draw-settlement:{aggregate.TicketId:N}:{aggregate.DrawId:N}:{input.OutcomeCertificateId:N}");
            await lockCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        var existing = await FindAggregateAsync(
            connection, transaction, aggregate.TicketId, aggregate.DrawId,
            input.OutcomeCertificateId, cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.CanonicalPayloadHash, input.CanonicalPayloadHash, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Conflicting aggregate SettlementInput payload for the same ticket and draw.");
            }
            await transaction.CommitAsync(cancellationToken);
            return existing;
        }

        await using (var inputCommand = connection.CreateCommand())
        {
            inputCommand.Transaction = transaction;
            inputCommand.CommandText = """
insert into game_engine.settlement_input_records (
  settlement_input_id, math_evaluation_certificate_id, math_evaluation_certificate_hash,
  outcome_certificate_id, outcome_certificate_hash, ticket_reference,
  game_manifest_id, game_manifest_version, game_manifest_hash,
  math_model_id, math_model_version, math_model_hash,
  paytable_id, paytable_version, paytable_hash, evaluator_version,
  evaluation_outcome, prize_tier, prize_facts, prize_facts_hash,
  payout_units, multiplier, replay_hash, idempotency_key, issued_at,
  provenance, canonical_payload, canonical_payload_hash, input_kind)
values (
  @settlement_input_id, @math_evaluation_certificate_id, @math_evaluation_certificate_hash,
  @outcome_certificate_id, @outcome_certificate_hash, @ticket_reference,
  @game_manifest_id, @game_manifest_version, @game_manifest_hash,
  @math_model_id, @math_model_version, @math_model_hash,
  @paytable_id, @paytable_version, @paytable_hash, @evaluator_version,
  @evaluation_outcome, @prize_tier, @prize_facts, @prize_facts_hash,
  @payout_units, @multiplier, @replay_hash, @idempotency_key, @issued_at,
  @provenance, @canonical_payload, @canonical_payload_hash, @input_kind);
""";
            AddInputParameters(inputCommand, input);
            await inputCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var aggregateCommand = connection.CreateCommand())
        {
            aggregateCommand.Transaction = transaction;
            aggregateCommand.CommandText = """
insert into game_engine.ticket_draw_settlement_aggregates (
  settlement_input_id, ticket_id, draw_id, outcome_certificate_id,
  product_version_id, product_version_hash, currency, item_count,
  total_reserved_stake_minor, pre_cap_gross_return_minor,
  effective_cap_minor, cap_scope, post_cap_gross_return_minor,
  capture_amount_minor, release_amount_minor, credit_amount_minor,
  item_evidence_hash, canonical_aggregate_hash)
values (
  @settlement_input_id, @ticket_id, @draw_id, @outcome_certificate_id,
  @product_version_id, @product_version_hash, @currency, @item_count,
  @total_reserved_stake_minor, @pre_cap_gross_return_minor,
  @effective_cap_minor, @cap_scope, @post_cap_gross_return_minor,
  @capture_amount_minor, @release_amount_minor, @credit_amount_minor,
  @item_evidence_hash, @canonical_aggregate_hash);
""";
            aggregateCommand.Parameters.AddWithValue("settlement_input_id", aggregate.SettlementInputId);
            aggregateCommand.Parameters.AddWithValue("ticket_id", aggregate.TicketId);
            aggregateCommand.Parameters.AddWithValue("draw_id", aggregate.DrawId);
            aggregateCommand.Parameters.AddWithValue("outcome_certificate_id", input.OutcomeCertificateId);
            aggregateCommand.Parameters.AddWithValue("product_version_id", aggregate.ProductVersionId);
            aggregateCommand.Parameters.AddWithValue("product_version_hash", aggregate.ProductVersionHash);
            aggregateCommand.Parameters.AddWithValue("currency", aggregate.Currency);
            aggregateCommand.Parameters.AddWithValue("item_count", aggregate.Items.Count);
            aggregateCommand.Parameters.AddWithValue("total_reserved_stake_minor", aggregate.TotalReservedStakeMinor);
            aggregateCommand.Parameters.AddWithValue("pre_cap_gross_return_minor", aggregate.PreCapGrossReturnMinor);
            aggregateCommand.Parameters.AddWithValue("effective_cap_minor", aggregate.EffectiveCapMinor is null ? DBNull.Value : aggregate.EffectiveCapMinor.Value);
            aggregateCommand.Parameters.AddWithValue("cap_scope", aggregate.CapScope);
            aggregateCommand.Parameters.AddWithValue("post_cap_gross_return_minor", aggregate.PostCapGrossReturnMinor);
            aggregateCommand.Parameters.AddWithValue("capture_amount_minor", aggregate.CaptureAmountMinor);
            aggregateCommand.Parameters.AddWithValue("release_amount_minor", aggregate.ReleaseAmountMinor);
            aggregateCommand.Parameters.AddWithValue("credit_amount_minor", aggregate.CreditAmountMinor);
            aggregateCommand.Parameters.AddWithValue("item_evidence_hash", aggregate.ItemEvidenceHash);
            aggregateCommand.Parameters.AddWithValue("canonical_aggregate_hash", aggregate.CanonicalAggregateHash);
            await aggregateCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var itemBatch = new NpgsqlBatch(connection, transaction))
        {
            foreach (var item in aggregate.Items)
            {
                var itemCommand = new NpgsqlBatchCommand("""
insert into game_engine.ticket_draw_settlement_aggregate_items (
  settlement_input_id, ticket_item_id, item_index, stake_minor,
  math_evaluation_id, math_evaluation_certificate_id, math_evaluation_certificate_hash,
  evaluation_outcome, prize_tier, gross_return_minor, refund_return_minor,
  loss_stake_minor, prize_facts_hash)
values (
  @settlement_input_id, @ticket_item_id, @item_index, @stake_minor,
  @math_evaluation_id, @math_evaluation_certificate_id, @math_evaluation_certificate_hash,
  @evaluation_outcome, @prize_tier, @gross_return_minor, @refund_return_minor,
  @loss_stake_minor, @prize_facts_hash);
""");
            itemCommand.Parameters.AddWithValue("settlement_input_id", aggregate.SettlementInputId);
            itemCommand.Parameters.AddWithValue("ticket_item_id", item.TicketItemId);
            itemCommand.Parameters.AddWithValue("item_index", item.ItemIndex);
            itemCommand.Parameters.AddWithValue("stake_minor", item.StakeMinor);
            itemCommand.Parameters.AddWithValue("math_evaluation_id", item.MathEvaluationId);
            itemCommand.Parameters.AddWithValue("math_evaluation_certificate_id", item.MathEvaluationCertificateId);
            itemCommand.Parameters.AddWithValue("math_evaluation_certificate_hash", item.MathEvaluationCertificateHash);
            itemCommand.Parameters.AddWithValue("evaluation_outcome", item.EvaluationOutcome.ToString());
            itemCommand.Parameters.AddWithValue("prize_tier", item.PrizeTier);
            itemCommand.Parameters.AddWithValue("gross_return_minor", item.GrossReturnMinor);
            itemCommand.Parameters.AddWithValue("refund_return_minor", item.RefundReturnMinor);
            itemCommand.Parameters.AddWithValue("loss_stake_minor", item.LossStakeMinor);
            itemCommand.Parameters.AddWithValue("prize_facts_hash", item.PrizeFactsHash);
                itemBatch.BatchCommands.Add(itemCommand);
            }
            await itemBatch.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
        return input;
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
        command.Parameters.AddWithValue("input_kind", input.InputKind);
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
            reader.GetString(27),
            reader.GetString(28));
    }

    private static async Task<SettlementInput?> FindAggregateAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid ticketId,
        Guid drawId,
        Guid outcomeCertificateId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
{SelectSql}
join game_engine.ticket_draw_settlement_aggregates aggregate
  on aggregate.settlement_input_id = settlement_input_records.settlement_input_id
where aggregate.ticket_id = @ticket_id
  and aggregate.draw_id = @draw_id
  and settlement_input_records.outcome_certificate_id = @outcome_certificate_id
limit 1;
""";
        command.Parameters.AddWithValue("ticket_id", ticketId);
        command.Parameters.AddWithValue("draw_id", drawId);
        command.Parameters.AddWithValue("outcome_certificate_id", outcomeCertificateId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapInput(reader) : null;
    }

    private static async Task<SettlementInput?> FindByMathEvaluationCertificateAsync(
        NpgsqlConnection connection,
        Guid certificateId,
        string certificateHash,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"{SelectSql} where math_evaluation_certificate_id = @certificate_id and math_evaluation_certificate_hash = @certificate_hash order by created_at desc limit 1;";
        command.Parameters.AddWithValue("certificate_id", certificateId);
        command.Parameters.AddWithValue("certificate_hash", certificateHash);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapInput(reader) : null;
    }

    private const string SelectSql = """
select
  settlement_input_records.settlement_input_id,
  settlement_input_records.math_evaluation_certificate_id,
  settlement_input_records.math_evaluation_certificate_hash,
  settlement_input_records.outcome_certificate_id,
  settlement_input_records.outcome_certificate_hash,
  settlement_input_records.ticket_reference,
  settlement_input_records.game_manifest_id,
  settlement_input_records.game_manifest_version,
  settlement_input_records.game_manifest_hash,
  settlement_input_records.math_model_id,
  settlement_input_records.math_model_version,
  settlement_input_records.math_model_hash,
  settlement_input_records.paytable_id,
  settlement_input_records.paytable_version,
  settlement_input_records.paytable_hash,
  settlement_input_records.evaluator_version,
  settlement_input_records.evaluation_outcome,
  settlement_input_records.prize_tier,
  settlement_input_records.prize_facts::text,
  settlement_input_records.prize_facts_hash,
  settlement_input_records.payout_units,
  settlement_input_records.multiplier,
  settlement_input_records.replay_hash,
  settlement_input_records.idempotency_key,
  settlement_input_records.issued_at,
  settlement_input_records.canonical_payload::text,
  settlement_input_records.provenance::text,
  settlement_input_records.canonical_payload_hash,
  settlement_input_records.input_kind
from game_engine.settlement_input_records settlement_input_records
""";
}
