using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;
using NpgsqlTypes;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresSchedulerOutcomeFanoutRepository(string connectionString) :
    ICanonicalOutcomeCertificateRepository,
    ISchedulerOutcomeFanoutRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    public async Task<CanonicalOutcomeCertificateSource?> FindSourceAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  manifest.execution_manifest_id,
  manifest.draw_id,
  evidence.evidence_id,
  evidence.execution_id,
  evidence.evidence_hash,
  game_manifest.id,
  game_manifest.semantic_version,
  game_manifest.content_hash,
  game_manifest.outcome_strategy_references::text,
  csprng.linked_rng_provider_id,
  csprng.linked_rng_provider_version,
  evidence.provider_evidence_payload::text,
  evidence.result_hash,
  evidence.completed_at,
  signing.provider_id,
  signing.provider_version,
  signing.provider_type,
  signing.production_eligible,
  signing.algorithm,
  signing.key_identifier,
  signing.algorithm_version,
  signing.verification_support,
  signing.key_rotation_support,
  signing.failure_mode,
  signing.content_hash,
  signing.lifecycle_state
from game_engine.draw_execution_manifests manifest
join game_engine.outcome_provider_execution_evidence evidence
  on evidence.execution_manifest_id = manifest.execution_manifest_id
 and evidence.status = 'GENERATED'
join game_engine.game_definition_versions version
  on version.id = manifest.game_definition_version_id
join game_engine.game_manifests game_manifest
  on game_manifest.id = version.game_manifest_id
 and game_manifest.content_hash = version.game_manifest_hash
join game_engine.csprng_provider_definitions csprng
  on csprng.outcome_provider_id = manifest.outcome_provider_id
 and csprng.outcome_provider_version = manifest.outcome_provider_version
join lateral (
  select event.signing_provider_id, event.signing_provider_version,
         event.signing_key_version
  from game_engine.game_engine_production_activation_events event
  where event.provider_id = manifest.outcome_provider_id
    and event.provider_version = manifest.outcome_provider_version
    and event.configuration_version = manifest.provider_configuration_version
    and event.stage = 'PRODUCTION_ACTIVE'
  order by event.created_at desc, event.activation_event_id desc
  limit 1
) activation on true
join game_engine.signing_providers signing
  on signing.provider_id = activation.signing_provider_id
 and signing.provider_version = activation.signing_provider_version
 and signing.key_identifier = activation.signing_key_version
where manifest.execution_manifest_id = @execution_manifest_id;
""";
        command.Parameters.AddWithValue("execution_manifest_id", executionManifestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        var (strategyId, strategyVersion) = ParseExactReference(reader.GetString(8), "Outcome Strategy");
        var sourcePayload = BuildCanonicalSourcePayload(
            reader.GetGuid(1),
            reader.GetGuid(0),
            await LoadGameDefinitionVersionIdAsync(executionManifestId, cancellationToken),
            reader.GetString(11));
        var sourceHash = Hash(sourcePayload);
        if (!string.Equals(sourceHash, reader.GetString(12), StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Generated provider evidence cannot reproduce the exact canonical outcome source bytes.");
        }

        return new CanonicalOutcomeCertificateSource(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetGuid(2),
            reader.GetGuid(3),
            reader.GetString(4),
            reader.GetGuid(5),
            reader.GetString(6),
            reader.GetString(7),
            strategyId,
            strategyVersion,
            reader.GetString(9),
            reader.GetString(10),
            sourcePayload,
            sourceHash,
            reader.GetFieldValue<DateTimeOffset>(13),
            MapSigningProvider(reader, 14));
    }

    public async Task<CanonicalOutcomeCertificateIssueResult?> FindByExecutionManifestAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await FindByExecutionManifestAsync(connection, null, executionManifestId, cancellationToken);
    }

    public async Task<CanonicalOutcomeCertificateIssueResult> PersistAsync(
        CanonicalOutcomeCertificateSource source,
        OutcomeCertificate certificate,
        CertificateSignature signature,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        await using (var lockCommand = connection.CreateCommand())
        {
            lockCommand.Transaction = transaction;
            lockCommand.CommandText = "select pg_advisory_xact_lock(hashtextextended(@scope, 0));";
            lockCommand.Parameters.AddWithValue("scope", $"outcome-certificate:{source.ExecutionManifestId:N}");
            await lockCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        var existing = await FindByExecutionManifestAsync(
            connection,
            transaction,
            source.ExecutionManifestId,
            cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.Certificate.CanonicalOutcomeHash, source.CanonicalOutcomeHash, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Outcome Certificate idempotency conflict detected.");
            }
            await transaction.CommitAsync(cancellationToken);
            return existing with { Duplicate = true };
        }

        await using (var eventCommand = connection.CreateCommand())
        {
            eventCommand.Transaction = transaction;
            eventCommand.CommandText = """
insert into game_engine.outcome_events (
  outcome_id, request_id, draw_id, game_manifest_reference,
  strategy_id, strategy_version, rng_provider_id, rng_provider_version,
  rng_evidence_hash, idempotency_key, outcome_mode, outcome_payload,
  canonical_payload, canonical_outcome_hash, generated_at,
  execution_manifest_id, provider_evidence_id)
values (
  @outcome_id, @request_id, @draw_id, @game_manifest_reference,
  @strategy_id, @strategy_version, @rng_provider_id, @rng_provider_version,
  @rng_evidence_hash, @idempotency_key, 'CertifiedProvider', @outcome_payload,
  @canonical_payload, @canonical_outcome_hash, @generated_at,
  @execution_manifest_id, @provider_evidence_id);
""";
            eventCommand.Parameters.AddWithValue("outcome_id", certificate.OutcomeId);
            eventCommand.Parameters.AddWithValue(
                "request_id",
                DeterministicGuid($"scheduler-outcome-request:{source.ExecutionManifestId:N}:{source.CanonicalOutcomeHash}"));
            eventCommand.Parameters.AddWithValue("draw_id", source.DrawId);
            eventCommand.Parameters.AddWithValue(
                "game_manifest_reference",
                $"{source.GameManifestId:N}:{source.GameManifestVersion}:{source.GameManifestHash}");
            eventCommand.Parameters.AddWithValue("strategy_id", source.OutcomeStrategyId);
            eventCommand.Parameters.AddWithValue("strategy_version", source.OutcomeStrategyVersion);
            eventCommand.Parameters.AddWithValue("rng_provider_id", source.RngProviderId);
            eventCommand.Parameters.AddWithValue("rng_provider_version", source.RngProviderVersion);
            eventCommand.Parameters.AddWithValue("rng_evidence_hash", source.ProviderEvidenceHash);
            eventCommand.Parameters.AddWithValue(
                "idempotency_key",
                $"scheduler-outcome-certificate:{source.ExecutionManifestId:N}");
            eventCommand.Parameters.AddWithValue("outcome_payload", NpgsqlDbType.Jsonb, source.CanonicalOutcomeJson);
            eventCommand.Parameters.AddWithValue("canonical_payload", source.CanonicalOutcomeJson);
            eventCommand.Parameters.AddWithValue("canonical_outcome_hash", source.CanonicalOutcomeHash);
            eventCommand.Parameters.AddWithValue("generated_at", source.GeneratedAt);
            eventCommand.Parameters.AddWithValue("execution_manifest_id", source.ExecutionManifestId);
            eventCommand.Parameters.AddWithValue("provider_evidence_id", source.ProviderEvidenceId);
            await eventCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var certificateCommand = connection.CreateCommand())
        {
            certificateCommand.Transaction = transaction;
            certificateCommand.CommandText = """
insert into game_engine.outcome_certificates (
  certificate_id, outcome_id, draw_id, strategy_id, strategy_version,
  rng_provider_id, rng_provider_version, canonical_outcome_hash,
  evidence_hash_reference, previous_certificates, signing_metadata,
  custody_state, issued_at)
values (
  @certificate_id, @outcome_id, @draw_id, @strategy_id, @strategy_version,
  @rng_provider_id, @rng_provider_version, @canonical_outcome_hash,
  @evidence_hash_reference, '[]'::jsonb, @signing_metadata,
  'Certified', @issued_at);
""";
            certificateCommand.Parameters.AddWithValue("certificate_id", certificate.CertificateId);
            certificateCommand.Parameters.AddWithValue("outcome_id", certificate.OutcomeId);
            certificateCommand.Parameters.AddWithValue("draw_id", certificate.DrawId);
            certificateCommand.Parameters.AddWithValue("strategy_id", certificate.StrategyId);
            certificateCommand.Parameters.AddWithValue("strategy_version", certificate.StrategyVersion);
            certificateCommand.Parameters.AddWithValue("rng_provider_id", certificate.RngProviderId);
            certificateCommand.Parameters.AddWithValue("rng_provider_version", certificate.RngProviderVersion);
            certificateCommand.Parameters.AddWithValue("canonical_outcome_hash", certificate.CanonicalOutcomeHash);
            certificateCommand.Parameters.AddWithValue("evidence_hash_reference", certificate.EvidenceHashReference);
            certificateCommand.Parameters.AddWithValue(
                "signing_metadata",
                NpgsqlDbType.Jsonb,
                JsonSerializer.Serialize(new
                {
                    authority = "CanonicalOutcomeCertificateAuthority",
                    qualificationOnly = true,
                    source.ProviderEvidenceId,
                    source.ExecutionManifestId
                }, JsonOptions));
            certificateCommand.Parameters.AddWithValue("issued_at", certificate.IssuedAt);
            await certificateCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var signatureCommand = connection.CreateCommand())
        {
            signatureCommand.Transaction = transaction;
            signatureCommand.CommandText = """
insert into game_engine.certificate_signatures (
  signature_id, certificate_reference_type, certificate_id,
  provider_id, provider_version, algorithm, algorithm_version,
  canonical_payload_hash, signature_value, verification_status,
  signing_context, issued_at)
values (
  @signature_id, @certificate_reference_type, @certificate_id,
  @provider_id, @provider_version, @algorithm, @algorithm_version,
  @canonical_payload_hash, @signature_value, 'Verified',
  'Production', @issued_at);
""";
            signatureCommand.Parameters.AddWithValue("signature_id", signature.SignatureId);
            signatureCommand.Parameters.AddWithValue("certificate_reference_type", signature.CertificateReferenceType);
            signatureCommand.Parameters.AddWithValue("certificate_id", signature.CertificateId);
            signatureCommand.Parameters.AddWithValue("provider_id", signature.ProviderId);
            signatureCommand.Parameters.AddWithValue("provider_version", signature.ProviderVersion);
            signatureCommand.Parameters.AddWithValue("algorithm", signature.Algorithm);
            signatureCommand.Parameters.AddWithValue("algorithm_version", signature.AlgorithmVersion);
            signatureCommand.Parameters.AddWithValue("canonical_payload_hash", signature.CanonicalPayloadHash);
            signatureCommand.Parameters.AddWithValue("signature_value", signature.SignatureValue);
            signatureCommand.Parameters.AddWithValue("issued_at", signature.IssuedAt);
            await signatureCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        var persisted = await FindByExecutionManifestAsync(
            connection,
            transaction,
            source.ExecutionManifestId,
            cancellationToken)
            ?? throw new InvalidOperationException("Outcome Certificate evidence was not persisted.");
        await transaction.CommitAsync(cancellationToken);
        return persisted;
    }

    public async Task<OutcomeCertificate> LoadOutcomeCertificateAsync(
        Guid certificateId,
        string certificateHash,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select certificate_id, outcome_id, draw_id, strategy_id, strategy_version,
  rng_provider_id, rng_provider_version, canonical_outcome_hash,
  evidence_hash_reference, custody_state, issued_at
from game_engine.outcome_certificates
where certificate_id = @certificate_id
  and canonical_outcome_hash = @certificate_hash
  and custody_state = 'Certified';
""";
        command.Parameters.AddWithValue("certificate_id", certificateId);
        command.Parameters.AddWithValue("certificate_hash", certificateHash);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException("Certified Outcome Certificate was not found for scheduler fanout.");
        }
        return MapOutcomeCertificate(reader);
    }

    public async Task<SchedulerVerifiedOutcomePayload> LoadOutcomePayloadAsync(
        CanonicalOutcomeVersion outcome,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select event.canonical_payload::text,
  bullseye.bullseye_number,
  bullseye.canonical_evidence_hash,
  bullseye.primary_result_hash,
  bullseye.provider_configuration_hash,
  bullseye.execution_manifest_id
from game_engine.outcome_events event
left join game_engine.hot_spot_bullseye_evidence bullseye
  on bullseye.draw_id = event.draw_id
 and bullseye.execution_manifest_id = event.execution_manifest_id
where event.outcome_id = @outcome_id
  and event.draw_id = @draw_id
  and event.execution_manifest_id = @execution_manifest_id
  and event.canonical_outcome_hash = @outcome_hash;
""";
        command.Parameters.AddWithValue("outcome_id", outcome.OutcomeId);
        command.Parameters.AddWithValue("draw_id", outcome.DrawId);
        command.Parameters.AddWithValue("execution_manifest_id", outcome.ExecutionManifestId);
        command.Parameters.AddWithValue("outcome_hash", outcome.OutcomeCertificateHash);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException("Exact certified canonical Outcome payload was not found for scheduler fanout.");
        }
        var canonicalJson = reader.GetString(0);
        using var document = JsonDocument.Parse(canonicalJson);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("Certified canonical Outcome payload is invalid.");
        }
        var payload = document.RootElement.EnumerateObject().ToDictionary(
            property => property.Name,
            property => NormalizeJsonValue(property.Value),
            StringComparer.Ordinal);
        if (reader.IsDBNull(1))
        {
            return new SchedulerVerifiedOutcomePayload(canonicalJson, payload, null, null, null, null, null);
        }
        return new SchedulerVerifiedOutcomePayload(
            canonicalJson,
            payload,
            reader.GetInt32(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetGuid(5));
    }

    private static object? NormalizeJsonValue(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => value.EnumerateObject().ToDictionary(
            property => property.Name,
            property => NormalizeJsonValue(property.Value),
            StringComparer.Ordinal),
        JsonValueKind.Array => value.EnumerateArray().Select(NormalizeJsonValue).ToArray(),
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Number when value.TryGetInt32(out var integer) => integer,
        JsonValueKind.Number when value.TryGetInt64(out var longInteger) => longInteger,
        JsonValueKind.Number => value.GetDecimal(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Null => null,
        _ => throw new InvalidOperationException("Certified canonical Outcome payload contains an unsupported JSON value.")
    };

    public async Task<SchedulerTicketPage> ListEligibleTicketItemsAsync(
        CanonicalOutcomeVersion outcome,
        Guid? afterTicketId,
        int limit,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  ticket.ticket_id, item.ticket_item_id, item.item_index,
  @execution_manifest_id::uuid, @execution_manifest_hash,
  ticket.product_version_id, ticket.game_configuration_hash,
  ticket.currency, item.stake_minor, item.wager_type,
  item.normalized_selections::text,
  manifest.id, manifest.game_id, manifest.game_code, manifest.game_name,
  manifest.game_family, manifest.jurisdiction_bindings::text,
  manifest.wager_schemas::text, manifest.outcome_strategy_references::text,
  manifest.math_model_references::text, manifest.paytable_references::text,
  manifest.settlement_policy_references::text, manifest.sales_rules::text,
  manifest.cancellation_correction_rules::text,
  manifest.replay_resettlement_policy::text,
  manifest.certification_pack_reference, manifest.regulator_profile,
  manifest.operator_approval_state, manifest.lifecycle_state,
  manifest.effective_from, manifest.effective_to, manifest.semantic_version,
  manifest.content_hash,
  math.id, math.math_model_id, math.version,
  math.game_family_compatibility::text, math.supported_wager_schemas::text,
  math.expected_rtp, math.expected_value, math.volatility_profile,
  math.hit_frequency, math.prize_liability_profile::text,
  math.jackpot_contribution_model::text, math.rounding_policy::text,
  math.currency_minor_unit_policy::text,
  math.jurisdiction_profile_references::text,
  math.rtp_policy_constraints::text, math.lifecycle_state,
  math.content_hash, math.certification_binding_state,
  paytable.id, paytable.paytable_id, paytable.version,
  paytable.math_model_id, paytable.math_model_version,
  paytable.prize_matrix_rows::text, paytable.bonus_side_bet_rows::text,
  paytable.caps::text, paytable.jurisdiction_profile_references::text,
  paytable.lifecycle_state, paytable.content_hash,
  paytable.certification_binding_state
from ticket_authority.tickets ticket
join ticket_authority.ticket_items item on item.ticket_id = ticket.ticket_id
left join game_engine.hot_spot_multi_draw_participations participation
  on participation.ticket_item_id = item.ticket_item_id
left join game_engine.hot_spot_multi_draw_participation_events participation_cancellation
  on participation_cancellation.participation_id = participation.participation_id
 and participation_cancellation.event_type = 'CANCELLED'
join public.credit_reservations reservation
  on reservation.id = ticket.reservation_id
 and reservation.ticket_id = ticket.ticket_id::text
join game_engine.game_definition_versions version
  on version.id = ticket.product_version_id
 and version.game_definition_id = ticket.product_id
 and version.version_number = ticket.product_version
 and version.definition_hash = ticket.game_configuration_hash
and version.paytable_version in (
  ticket.paytable_version,
  ticket.paytable_id || ':' || ticket.paytable_version
)
join game_engine.game_manifests manifest
  on manifest.id = ticket.manifest_id
 and manifest.game_id = ticket.product_id
 and manifest.semantic_version = ticket.manifest_version
 and manifest.content_hash = ticket.manifest_hash
 and manifest.id = version.game_manifest_id
 and manifest.content_hash = version.game_manifest_hash
join game_engine.math_model_definitions math
  on math.id = version.math_model_definition_id
 and math.content_hash = version.math_model_hash
join game_engine.paytable_definitions paytable
  on paytable.id = ticket.paytable_definition_id
 and paytable.id = version.paytable_definition_id
 and paytable.paytable_id = ticket.paytable_id
 and paytable.version = ticket.paytable_version
 and paytable.content_hash = ticket.paytable_hash
 and paytable.content_hash = version.paytable_hash
where coalesce(participation.draw_id, ticket.draw_id) = @draw_id
  and participation_cancellation.participation_id is null
  and (
    participation.participation_id is not null
    or (
      ticket.execution_manifest_id = @execution_manifest_id
      and ticket.execution_manifest_hash = @execution_manifest_hash
    )
  )
  and ticket.product_version_id = @product_version_id
  and ticket.game_configuration_hash = @product_version_hash
  and ticket.lineage_model = 'CANONICAL_V1'
  and ticket.status in ('ACCEPTED','AWAITING_DRAW','CLOSED','SETTLEMENT_PENDING')
  and ticket.lifecycle_state in (
    'ACCEPTED','RESERVATION_CREATED','SETTLEMENT_REQUESTED',
    'SETTLEMENT_EXECUTED','LEDGER_POSTED','WALLET_APPLIED')
  and reservation.status in ('RESERVED','PARTIALLY_CAPTURED')
  and ticket.ticket_id in (
    select candidate.ticket_id
    from ticket_authority.tickets candidate
    join public.credit_reservations candidate_reservation
      on candidate_reservation.id = candidate.reservation_id
     and candidate_reservation.ticket_id = candidate.ticket_id::text
    where (
        (
          candidate.draw_id = @draw_id
          and candidate.execution_manifest_id = @execution_manifest_id
          and candidate.execution_manifest_hash = @execution_manifest_hash
          and not exists (
            select 1 from game_engine.hot_spot_multi_draw_participations mapped
            where mapped.ticket_id = candidate.ticket_id
          )
        )
        or exists (
          select 1
          from game_engine.hot_spot_multi_draw_participations mapped
          left join game_engine.hot_spot_multi_draw_participation_events cancelled
            on cancelled.participation_id = mapped.participation_id
           and cancelled.event_type = 'CANCELLED'
          where mapped.ticket_id = candidate.ticket_id
            and mapped.draw_id = @draw_id
            and cancelled.participation_id is null
        )
      )
      and candidate.product_version_id = @product_version_id
      and candidate.game_configuration_hash = @product_version_hash
      and candidate.lineage_model = 'CANONICAL_V1'
      and candidate.status in ('ACCEPTED','AWAITING_DRAW','CLOSED','SETTLEMENT_PENDING')
      and candidate.lifecycle_state in (
        'ACCEPTED','RESERVATION_CREATED','SETTLEMENT_REQUESTED',
        'SETTLEMENT_EXECUTED','LEDGER_POSTED','WALLET_APPLIED')
      and candidate_reservation.status in ('RESERVED','PARTIALLY_CAPTURED')
      and (@after_ticket_id is null or candidate.ticket_id > @after_ticket_id)
    order by candidate.ticket_id
    limit @limit
  )
order by ticket.ticket_id, item.item_index
""";
        command.Parameters.AddWithValue("draw_id", outcome.DrawId);
        command.Parameters.AddWithValue("execution_manifest_id", outcome.ExecutionManifestId);
        command.Parameters.AddWithValue("execution_manifest_hash", outcome.ExecutionManifestHash);
        command.Parameters.AddWithValue("product_version_id", outcome.GameDefinitionVersionId);
        command.Parameters.AddWithValue("product_version_hash", outcome.GameDefinitionHash);
        command.Parameters.Add("after_ticket_id", NpgsqlDbType.Uuid).Value =
            afterTicketId is null ? DBNull.Value : afterTicketId.Value;
        command.Parameters.AddWithValue("limit", Math.Clamp(limit, 1, 500));

        var items = new List<SchedulerTicketEvaluationItem>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            items.Add(MapTicketItem(reader));
        }
        var last = items.LastOrDefault();
        var distinctTickets = items.Select(item => item.TicketId).Distinct().Count();
        return new SchedulerTicketPage(
            items,
            distinctTickets == Math.Clamp(limit, 1, 500) ? last?.TicketId : null);
    }

    private async Task<Guid> LoadGameDefinitionVersionIdAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "select game_definition_version_id from game_engine.draw_execution_manifests where execution_manifest_id=@id;";
        command.Parameters.AddWithValue("id", executionManifestId);
        return (Guid)(await command.ExecuteScalarAsync(cancellationToken)
            ?? throw new InvalidOperationException("Execution Manifest was not found."));
    }

    private static async Task<CanonicalOutcomeCertificateIssueResult?> FindByExecutionManifestAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        Guid executionManifestId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select certificate.certificate_id, certificate.outcome_id, certificate.draw_id,
  certificate.strategy_id, certificate.strategy_version,
  certificate.rng_provider_id, certificate.rng_provider_version,
  certificate.canonical_outcome_hash, certificate.evidence_hash_reference,
  certificate.custody_state, certificate.issued_at,
  signature.signature_id, signature.certificate_reference_type,
  signature.provider_id, signature.provider_version, signature.algorithm,
  signature.algorithm_version, signature.canonical_payload_hash,
  signature.signature_value, signature.verification_status, signature.issued_at
from game_engine.outcome_events event
join game_engine.outcome_certificates certificate on certificate.outcome_id = event.outcome_id
join game_engine.certificate_signatures signature
  on signature.certificate_reference_type = 'OutcomeCertificate'
 and signature.certificate_id = certificate.certificate_id
where event.execution_manifest_id = @execution_manifest_id
  and event.outcome_mode = 'CertifiedProvider'
  and signature.verification_status = 'Verified';
""";
        command.Parameters.AddWithValue("execution_manifest_id", executionManifestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }
        var certificate = MapOutcomeCertificate(reader);
        var signature = new CertificateSignature(
            reader.GetGuid(11),
            reader.GetString(12),
            certificate.CertificateId,
            reader.GetString(13),
            reader.GetString(14),
            reader.GetString(15),
            reader.GetString(16),
            reader.GetString(17),
            reader.GetString(18),
            Enum.Parse<SignatureVerificationStatus>(reader.GetString(19)),
            reader.GetFieldValue<DateTimeOffset>(20));
        if (await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException("Multiple certified Outcome Certificates exist for one Execution Manifest.");
        }
        return new CanonicalOutcomeCertificateIssueResult(certificate, signature, Duplicate: true);
    }

    private static SchedulerTicketEvaluationItem MapTicketItem(NpgsqlDataReader reader)
    {
        var wagerPayload = ParseWagerPayload(reader.GetString(10), reader.GetInt64(8), reader.GetGuid(0), reader.GetGuid(1));
        var issuedAt = reader.GetFieldValue<DateTimeOffset>(29);
        var manifest = new GameManifestV1(
            reader.GetGuid(11), reader.GetGuid(12), reader.GetString(13), reader.GetString(14), reader.GetString(15),
            ParseStringList(reader.GetString(16)), ParseWagerSchemas(reader.GetString(17)),
            ParseStringList(reader.GetString(18)), ParseStringList(reader.GetString(19)),
            ParseStringList(reader.GetString(20)), ParseStringList(reader.GetString(21)),
            ParseDictionary(reader.GetString(22)), ParseDictionary(reader.GetString(23)),
            ParseDictionary(reader.GetString(24)), reader.GetString(25), reader.GetString(26),
            Enum.Parse<OperatorApprovalState>(reader.GetString(27)),
            Enum.Parse<GameManifestLifecycleState>(reader.GetString(28)),
            issuedAt, reader.IsDBNull(30) ? null : reader.GetFieldValue<DateTimeOffset>(30),
            reader.GetString(31), reader.GetString(32),
            new SignatureMetadata("manifest-metadata", "sha256-v1", "metadata-v1", "not-disclosed", issuedAt));
        var math = new MathModelDefinitionV1(
            reader.GetGuid(33), reader.GetString(34), reader.GetString(35),
            ParseStringList(reader.GetString(36)), ParseStringList(reader.GetString(37)),
            reader.GetDecimal(38), reader.GetDecimal(39), reader.GetString(40), reader.GetDecimal(41),
            ParseDictionary(reader.GetString(42)), ParseDictionary(reader.GetString(43)),
            ParseDictionary(reader.GetString(44)), ParseDictionary(reader.GetString(45)),
            reader.IsDBNull(46) ? [] : ParseStringList(reader.GetString(46)),
            reader.IsDBNull(47) ? new Dictionary<string, object?>() : ParseDictionary(reader.GetString(47)),
            Enum.Parse<MathGovernanceLifecycleState>(reader.GetString(48)), reader.GetString(49),
            Enum.Parse<MathCertificationBindingState>(reader.GetString(50)), null);
        var paytable = new PaytableDefinitionV1(
            reader.GetGuid(51), reader.GetString(52), reader.GetString(53),
            reader.GetString(54), reader.GetString(55),
            ParsePrizeRows(reader.GetString(56)), ParsePrizeRows(reader.GetString(57)),
            ParseDictionary(reader.GetString(58)), reader.IsDBNull(59) ? [] : ParseStringList(reader.GetString(59)),
            Enum.Parse<MathGovernanceLifecycleState>(reader.GetString(60)), reader.GetString(61),
            Enum.Parse<MathCertificationBindingState>(reader.GetString(62)), null);
        return new SchedulerTicketEvaluationItem(
            reader.GetGuid(0), reader.GetGuid(1), reader.GetInt32(2), reader.GetGuid(3), reader.GetString(4),
            reader.GetGuid(5), reader.GetString(6), reader.GetString(7), reader.GetInt64(8),
            manifest, math, paytable, reader.GetString(9), wagerPayload);
    }

    private static OutcomeCertificate MapOutcomeCertificate(NpgsqlDataReader reader) => new(
        reader.GetGuid(0), reader.GetGuid(1), reader.GetGuid(2), reader.GetString(3), reader.GetString(4),
        reader.GetString(5), reader.GetString(6), reader.GetString(7), reader.GetString(8), [], null,
        Enum.Parse<OutcomeCustodyState>(reader.GetString(9)), reader.GetFieldValue<DateTimeOffset>(10));

    private static SigningProviderDefinition MapSigningProvider(NpgsqlDataReader reader, int start) => new(
        reader.GetString(start), reader.GetString(start + 1),
        reader.GetString(start + 2) switch
        {
            "SOFTWARE_KEY" => SigningProviderType.SoftwareKey,
            "KMS" => SigningProviderType.Kms,
            "HSM" => SigningProviderType.Hsm,
            "LOCAL_TEST" => SigningProviderType.LocalTest,
            "SIMULATION" => SigningProviderType.Simulation,
            var value => throw new InvalidOperationException($"Unsupported signing provider type {value}.")
        },
        reader.GetBoolean(start + 3), reader.GetString(start + 4), reader.GetString(start + 5),
        reader.GetString(start + 6), reader.GetBoolean(start + 7), reader.GetBoolean(start + 8),
        Enum.Parse<SigningFailureMode>(reader.GetString(start + 9)), reader.GetString(start + 10),
        Enum.Parse<SigningProviderLifecycleState>(reader.GetString(start + 11)));

    private static string BuildCanonicalSourcePayload(
        Guid drawId,
        Guid executionManifestId,
        Guid gameDefinitionVersionId,
        string providerEvidenceJson)
    {
        using var evidence = JsonDocument.Parse(providerEvidenceJson);
        var root = evidence.RootElement;
        var numbers = root.TryGetProperty("generatedNumbers", out var camel)
            ? camel.EnumerateArray().Select(value => value.GetInt32()).ToArray()
            : root.GetProperty("GeneratedNumbers").EnumerateArray().Select(value => value.GetInt32()).ToArray();
        return JsonSerializer.Serialize(new
        {
            drawId,
            executionManifestId,
            gameDefinitionVersionId,
            numbers,
            executionSucceeded = true
        }, JsonOptions);
    }

    private static (string Id, string Version) ParseExactReference(string json, string label)
    {
        var reference = ParseStringList(json).SingleOrDefault()
            ?? throw new InvalidOperationException($"{label} exact reference is missing or ambiguous.");
        var parts = reference.Split(':', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2)
        {
            throw new InvalidOperationException($"{label} exact version reference is invalid.");
        }
        return (parts[0], parts[1]);
    }

    private static IReadOnlyCollection<string> ParseWagerSchemas(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.EnumerateArray().Select(value =>
            value.ValueKind == JsonValueKind.String
                ? value.GetString()!
                : value.TryGetProperty("wagerType", out var wagerType)
                    ? wagerType.GetString()!
                    : throw new InvalidOperationException("Game Manifest wager schema is invalid.")).ToArray();
    }

    private static IReadOnlyCollection<string> ParseStringList(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.EnumerateArray().Select(value =>
            value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetRawText()).ToArray();
    }

    private static IReadOnlyDictionary<string, object?> ParseDictionary(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.ValueKind == JsonValueKind.Object
            ? document.RootElement.EnumerateObject().ToDictionary(
                property => property.Name,
                property => (object?)property.Value.Clone(),
                StringComparer.Ordinal)
            : new Dictionary<string, object?>(StringComparer.Ordinal);
    }

    private static IReadOnlyCollection<PrizeMatrixRow> ParsePrizeRows(string json) =>
        JsonSerializer.Deserialize<PrizeMatrixRow[]>(json, JsonOptions)
        ?? throw new InvalidOperationException("Paytable prize rows are invalid.");

    private static IReadOnlyDictionary<string, object?> ParseWagerPayload(
        string json,
        long stakeMinor,
        Guid ticketId,
        Guid ticketItemId)
    {
        using var document = JsonDocument.Parse(json);
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (document.RootElement.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in document.RootElement.EnumerateObject())
            {
                payload[property.Name] = NormalizeJsonValue(property.Value);
            }
        }
        else if (document.RootElement.ValueKind == JsonValueKind.Array)
        {
            payload["numbers"] = NormalizeJsonValue(document.RootElement);
        }
        else
        {
            throw new InvalidOperationException("Ticket item selections must be an object or array.");
        }
        payload["stakeMinor"] = stakeMinor;
        payload["ticketId"] = ticketId;
        payload["ticketItemId"] = ticketItemId;
        return payload;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static Guid DeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes.AsSpan(0, 16));
    }

    private static string Hash(string value) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
}
