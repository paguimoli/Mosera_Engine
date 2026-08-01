using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;
using NpgsqlTypes;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresCanonicalOutcomePipelineRepository : ICanonicalOutcomePipelineRepository
{
    private readonly string connectionString;
    private readonly bool legacyPublicationEnabled;

    public PostgresCanonicalOutcomePipelineRepository(
        string databaseUrl,
        bool legacyPublicationEnabled = true)
    {
        connectionString = PostgresConnectionString.Normalize(databaseUrl);
        this.legacyPublicationEnabled = legacyPublicationEnabled;
    }

    public async Task<CanonicalOutcomeVersion> PublishAsync(
        CanonicalOutcomePublicationCommand command,
        CanonicalOutcomeAuthorityContext authorityContext,
        string canonicalRequestHash,
        CancellationToken cancellationToken)
    {
        var leaseToken = Guid.NewGuid();
        await ClaimExecutionLeaseAsync(command.DrawId, leaseToken, cancellationToken);
        try
        {
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
            await AcquireLockAsync(connection, transaction, $"canonical-outcome:{command.DrawId:N}", cancellationToken);

            var existing = await FindByIdempotencyAsync(
                connection,
                transaction,
                command.IdempotencyKey,
                cancellationToken);
            if (existing is not null)
            {
                EnsureSameHash(existing.CanonicalRequestHash, canonicalRequestHash, "outcome publication");
                await transaction.CommitAsync(cancellationToken);
                return existing;
            }

            var source = await LoadSourceOutcomeAsync(connection, transaction, command, cancellationToken);
            var manifest = await FindExecutionManifestAsync(connection, transaction, command.DrawId, cancellationToken)
                ?? throw new InvalidOperationException("The Draw Instance has no authoritative Execution Manifest.");
            ValidateAuthorityContext(command, authorityContext, manifest, source);
            var current = await FindCurrentAsync(connection, transaction, command.DrawId, cancellationToken);
            ValidateVersionTransition(command, current, source, authorityContext);

            var outcomeVersionId = Guid.NewGuid();
            var outboxEventId = Guid.NewGuid();
            var versionNumber = (current?.VersionNumber ?? 0) + 1;
            var publishedAt = DateTimeOffset.UtcNow;
            var outboxPayload = JsonSerializer.Serialize(new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["auditReference"] = command.AuditReference,
                ["authoritativeSource"] = command.AuthoritativeSource,
                ["causationId"] = command.CausationId,
                ["correlationId"] = command.CorrelationId,
                ["drawId"] = command.DrawId,
                ["engineName"] = command.EngineName,
                ["engineVersion"] = command.EngineVersion,
                ["generatedAt"] = source.GeneratedAt,
                ["gameDefinitionHash"] = authorityContext.GameDefinitionVersion.DefinitionHash,
                ["gameDefinitionVersionId"] = authorityContext.GameDefinitionVersion.Id,
                ["lifecycleEvidenceHash"] = command.LifecycleEvidenceHash,
                ["outcomeCertificateHash"] = command.OutcomeCertificateHash,
                ["outcomeCertificateId"] = command.OutcomeCertificateId,
                ["outcomeHash"] = source.CanonicalOutcomeHash,
                ["outcomeProviderCategory"] = authorityContext.Provider.Registration.ProviderCategory.ToString(),
                ["outcomeProviderId"] = authorityContext.Provider.Registration.ProviderId,
                ["outcomeProviderVersion"] = authorityContext.Provider.Registration.ProviderVersion,
                ["outcomeVersionId"] = outcomeVersionId,
                ["previousOutcomeVersionId"] = command.PreviousOutcomeVersionId,
                ["productReference"] = command.ProductReference,
                ["providerConfigurationVersion"] = authorityContext.Provider.Registration.ConfigurationVersion,
                ["providerEvidenceHash"] = authorityContext.Provider.Evidence.EvidenceHash,
                ["providerEvidenceId"] = authorityContext.Provider.Evidence.EvidenceId,
                ["reasonCode"] = command.ReasonCode,
                ["validatedOutcomeHash"] = authorityContext.ValidatedResultHash,
                ["versionKind"] = command.VersionKind.ToString(),
                ["versionNumber"] = versionNumber
            });

            await InsertOutboxAsync(
                connection,
                transaction,
                outboxEventId,
                $"outcome.{command.VersionKind.ToString().ToLowerInvariant()}",
                "canonical_outcome",
                outcomeVersionId.ToString("N"),
                outboxPayload,
                command.CorrelationId,
                cancellationToken);

            await using (var insert = connection.CreateCommand())
            {
                insert.Transaction = transaction;
                insert.CommandText = """
insert into game_engine.canonical_outcome_versions (
  authority_model_version,
  outcome_version_id,
  draw_id,
  execution_manifest_id,
  execution_manifest_hash,
  provider_evidence_id,
  provider_execution_id,
  outcome_provider_category,
  outcome_provider_id,
  outcome_provider_version,
  provider_configuration_version,
  provider_evidence_hash,
  game_definition_version_id,
  game_definition_hash,
  evaluator_version,
  certificate_signature_id,
  certificate_verification_hash,
  product_reference,
  engine_name,
  engine_version,
  version_number,
  version_kind,
  outcome_id,
  outcome_certificate_id,
  outcome_certificate_hash,
  previous_outcome_version_id,
  outcome_payload,
  canonical_outcome_hash,
  validated_outcome_payload,
  validated_outcome_hash,
  validated_primary_result,
  validated_bonus_result,
  derived_outcome_data,
  outcome_schema_version,
  generated_at,
  authoritative_source,
  correlation_id,
  causation_id,
  audit_reference,
  actor_reference,
  reason_code,
  lifecycle_evidence_hash,
  canonical_request_hash,
  idempotency_key,
  outbox_event_id,
  published_at)
values (
  'CANONICAL_V1',
  @outcome_version_id,
  @draw_id,
  @execution_manifest_id,
  @execution_manifest_hash,
  @provider_evidence_id,
  @provider_execution_id,
  @outcome_provider_category,
  @outcome_provider_id,
  @outcome_provider_version,
  @provider_configuration_version,
  @provider_evidence_hash,
  @game_definition_version_id,
  @game_definition_hash,
  @evaluator_version,
  @certificate_signature_id,
  @certificate_verification_hash,
  @product_reference,
  @engine_name,
  @engine_version,
  @version_number,
  @version_kind,
  @outcome_id,
  @outcome_certificate_id,
  @outcome_certificate_hash,
  @previous_outcome_version_id,
  @outcome_payload,
  @canonical_outcome_hash,
  @validated_outcome_payload,
  @validated_outcome_hash,
  @validated_primary_result,
  @validated_bonus_result,
  @derived_outcome_data,
  @outcome_schema_version,
  @generated_at,
  @authoritative_source,
  @correlation_id,
  @causation_id,
  @audit_reference,
  @actor_reference,
  @reason_code,
  @lifecycle_evidence_hash,
  @canonical_request_hash,
  @idempotency_key,
  @outbox_event_id,
  @published_at);
""";
                insert.Parameters.AddWithValue("outcome_version_id", outcomeVersionId);
                insert.Parameters.AddWithValue("draw_id", command.DrawId);
                insert.Parameters.AddWithValue("execution_manifest_id", manifest.ExecutionManifestId);
                insert.Parameters.AddWithValue("execution_manifest_hash", manifest.CanonicalManifestHash);
                insert.Parameters.AddWithValue("provider_evidence_id", authorityContext.Provider.Evidence.EvidenceId);
                insert.Parameters.AddWithValue("provider_execution_id", authorityContext.Provider.Evidence.ExecutionId);
                insert.Parameters.AddWithValue("outcome_provider_category", ToDatabaseCategory(authorityContext.Provider.Registration.ProviderCategory));
                insert.Parameters.AddWithValue("outcome_provider_id", authorityContext.Provider.Registration.ProviderId);
                insert.Parameters.AddWithValue("outcome_provider_version", authorityContext.Provider.Registration.ProviderVersion);
                insert.Parameters.AddWithValue("provider_configuration_version", authorityContext.Provider.Registration.ConfigurationVersion);
                insert.Parameters.AddWithValue("provider_evidence_hash", authorityContext.Provider.Evidence.EvidenceHash);
                insert.Parameters.AddWithValue("game_definition_version_id", authorityContext.GameDefinitionVersion.Id);
                insert.Parameters.AddWithValue("game_definition_hash", authorityContext.GameDefinitionVersion.DefinitionHash);
                insert.Parameters.AddWithValue("evaluator_version", manifest.EvaluatorVersion);
                insert.Parameters.AddWithValue("certificate_signature_id", authorityContext.CertificateEvidence.SignatureId);
                insert.Parameters.AddWithValue("certificate_verification_hash", authorityContext.CertificateEvidence.VerificationEvidenceHash);
                insert.Parameters.AddWithValue("product_reference", command.ProductReference);
                insert.Parameters.AddWithValue("engine_name", command.EngineName);
                insert.Parameters.AddWithValue("engine_version", command.EngineVersion);
                insert.Parameters.AddWithValue("version_number", versionNumber);
                insert.Parameters.AddWithValue("version_kind", command.VersionKind.ToString());
                insert.Parameters.AddWithValue("outcome_id", source.OutcomeId);
                insert.Parameters.AddWithValue("outcome_certificate_id", command.OutcomeCertificateId);
                insert.Parameters.AddWithValue("outcome_certificate_hash", command.OutcomeCertificateHash);
                insert.Parameters.AddWithValue(
                    "previous_outcome_version_id",
                    command.PreviousOutcomeVersionId is null ? DBNull.Value : command.PreviousOutcomeVersionId.Value);
                insert.Parameters.AddWithValue("outcome_payload", NpgsqlDbType.Jsonb, source.OutcomePayloadJson);
                insert.Parameters.AddWithValue("canonical_outcome_hash", source.CanonicalOutcomeHash);
                insert.Parameters.AddWithValue("validated_outcome_payload", NpgsqlDbType.Jsonb, authorityContext.ValidatedResultJson);
                insert.Parameters.AddWithValue("validated_outcome_hash", authorityContext.ValidatedResultHash);
                insert.Parameters.AddWithValue("validated_primary_result", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(authorityContext.ValidatedResult.PrimaryNumbers));
                insert.Parameters.AddWithValue("validated_bonus_result", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(authorityContext.ValidatedResult.BonusNumbers));
                insert.Parameters.AddWithValue("derived_outcome_data", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(authorityContext.ValidatedResult.DerivedOutcomeData));
                insert.Parameters.AddWithValue("outcome_schema_version", authorityContext.ValidatedResult.SchemaVersion);
                insert.Parameters.AddWithValue("generated_at", source.GeneratedAt);
                insert.Parameters.AddWithValue("authoritative_source", command.AuthoritativeSource);
                insert.Parameters.AddWithValue("correlation_id", command.CorrelationId);
                insert.Parameters.AddWithValue("causation_id", command.CausationId);
                insert.Parameters.AddWithValue("audit_reference", command.AuditReference);
                insert.Parameters.AddWithValue("actor_reference", command.ActorReference);
                insert.Parameters.AddWithValue("reason_code", command.ReasonCode);
                insert.Parameters.AddWithValue("lifecycle_evidence_hash", command.LifecycleEvidenceHash);
                insert.Parameters.AddWithValue("canonical_request_hash", canonicalRequestHash);
                insert.Parameters.AddWithValue("idempotency_key", command.IdempotencyKey);
                insert.Parameters.AddWithValue("outbox_event_id", outboxEventId);
                insert.Parameters.AddWithValue("published_at", publishedAt);
                await insert.ExecuteNonQueryAsync(cancellationToken);
            }

            if (command.VersionKind != CanonicalOutcomeVersionKind.Published)
            {
                await InsertLifecycleEventAsync(
                    connection,
                    transaction,
                    new CanonicalOutcomeLifecycleEvent(
                        Guid.NewGuid(),
                        command.VersionKind == CanonicalOutcomeVersionKind.Corrected
                            ? CanonicalOutcomeLifecycleOperation.Correction
                            : CanonicalOutcomeLifecycleOperation.Cancellation,
                        outcomeVersionId,
                        command.DrawId,
                        command.OutcomeCertificateId,
                        authorityContext.Provider.Evidence.EvidenceId,
                        command.PreviousOutcomeVersionId,
                        null,
                        null,
                        command.ActorReference,
                        command.ReasonCode,
                        command.CorrelationId,
                        command.CausationId,
                        canonicalRequestHash,
                        command.LifecycleEvidenceHash,
                        $"lifecycle:{command.IdempotencyKey}",
                        publishedAt),
                    cancellationToken);
            }

            var result = await FindByIdempotencyAsync(
                connection,
                transaction,
                command.IdempotencyKey,
                cancellationToken)
                ?? throw new InvalidOperationException("Canonical outcome publication was not persisted.");
            await transaction.CommitAsync(cancellationToken);
            return result;
        }
        finally
        {
            await ReleaseExecutionLeaseAsync(command.DrawId, leaseToken, CancellationToken.None);
        }
    }

    public async Task<OutcomeSettlementRequest> EmitSettlementRequestAsync(
        OutcomeSettlementRequestCommand command,
        string canonicalRequestHash,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await AcquireLockAsync(connection, transaction, $"outcome-settlement:{command.OutcomeVersionId:N}", cancellationToken);

        var existing = await FindSettlementRequestByIdempotencyAsync(
            connection,
            transaction,
            command.IdempotencyKey,
            cancellationToken);
        if (existing is not null)
        {
            EnsureSameHash(existing.CanonicalRequestHash, canonicalRequestHash, "settlement request");
            await transaction.CommitAsync(cancellationToken);
            return existing;
        }

        var version = await FindByIdAsync(connection, transaction, command.OutcomeVersionId, cancellationToken)
            ?? throw new InvalidOperationException("Canonical outcome version was not found.");
        var current = await FindCurrentAsync(connection, transaction, version.DrawId, cancellationToken);
        if (current?.OutcomeVersionId != version.OutcomeVersionId)
        {
            throw new InvalidOperationException("Settlement requests can only be emitted for the current canonical outcome version.");
        }

        SettlementInputEvidence? settlementInput = null;
        if (version.VersionKind == CanonicalOutcomeVersionKind.Cancelled)
        {
            if (command.SettlementInputId is not null)
            {
                throw new InvalidOperationException("Cancellation settlement requests cannot carry a SettlementInput.");
            }
        }
        else
        {
            if (command.SettlementInputId is null)
            {
                throw new InvalidOperationException("Published and corrected outcomes require a certificate-backed SettlementInput.");
            }

            settlementInput = await LoadSettlementInputAsync(
                connection,
                transaction,
                command.SettlementInputId.Value,
                cancellationToken)
                ?? throw new InvalidOperationException("SettlementInput was not found.");
            if (settlementInput.OutcomeCertificateId != version.OutcomeCertificateId ||
                !string.Equals(settlementInput.OutcomeCertificateHash, version.OutcomeCertificateHash, StringComparison.Ordinal) ||
                !string.Equals(settlementInput.EvaluatorVersion, version.EvaluatorVersion, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "SettlementInput does not reference the exact canonical Outcome Certificate and evaluator version.");
            }
        }

        var requestId = Guid.NewGuid();
        var outboxEventId = Guid.NewGuid();
        var emittedAt = DateTimeOffset.UtcNow;
        var outboxPayload = JsonSerializer.Serialize(new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["auditReference"] = command.AuditReference,
            ["causationId"] = command.CausationId,
            ["correlationId"] = command.CorrelationId,
            ["drawId"] = version.DrawId,
            ["mathEvaluationCertificateHash"] = settlementInput?.MathEvaluationCertificateHash,
            ["mathEvaluationCertificateId"] = settlementInput?.MathEvaluationCertificateId,
            ["outcomeCertificateHash"] = version.OutcomeCertificateHash,
            ["outcomeCertificateId"] = version.OutcomeCertificateId,
            ["canonicalOutcomeHash"] = version.CanonicalOutcomeHash,
            ["certificateSignatureId"] = version.CertificateSignatureId,
            ["executionManifestHash"] = version.ExecutionManifestHash,
            ["executionManifestId"] = version.ExecutionManifestId,
            ["gameDefinitionHash"] = version.GameDefinitionHash,
            ["gameDefinitionVersionId"] = version.GameDefinitionVersionId,
            ["outcomeProviderCategory"] = version.ProviderCategory.ToString(),
            ["outcomeProviderId"] = version.OutcomeProviderId,
            ["outcomeProviderVersion"] = version.OutcomeProviderVersion,
            ["providerConfigurationVersion"] = version.ProviderConfigurationVersion,
            ["providerEvidenceHash"] = version.ProviderEvidenceHash,
            ["providerEvidenceId"] = version.ProviderEvidenceId,
            ["outcomeVersionId"] = version.OutcomeVersionId,
            ["requestKind"] = version.VersionKind.ToString(),
            ["settlementInputHash"] = settlementInput?.CanonicalPayloadHash,
            ["settlementInputId"] = command.SettlementInputId,
            ["settlementRequestId"] = requestId
        });

        await InsertOutboxAsync(
            connection,
            transaction,
            outboxEventId,
            "settlement.requested",
            "canonical_outcome",
            version.OutcomeVersionId.ToString("N"),
            outboxPayload,
            command.CorrelationId,
            cancellationToken);

        await using (var insert = connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
insert into game_engine.outcome_settlement_requests (
  settlement_request_id,
  outcome_version_id,
  draw_id,
  request_kind,
  settlement_input_id,
  canonical_request_hash,
  idempotency_key,
  correlation_id,
  causation_id,
  audit_reference,
  outbox_event_id,
  emitted_at)
values (
  @settlement_request_id,
  @outcome_version_id,
  @draw_id,
  @request_kind,
  @settlement_input_id,
  @canonical_request_hash,
  @idempotency_key,
  @correlation_id,
  @causation_id,
  @audit_reference,
  @outbox_event_id,
  @emitted_at);
""";
            insert.Parameters.AddWithValue("settlement_request_id", requestId);
            insert.Parameters.AddWithValue("outcome_version_id", version.OutcomeVersionId);
            insert.Parameters.AddWithValue("draw_id", version.DrawId);
            insert.Parameters.AddWithValue("request_kind", version.VersionKind.ToString());
            insert.Parameters.AddWithValue(
                "settlement_input_id",
                command.SettlementInputId is null ? DBNull.Value : command.SettlementInputId.Value);
            insert.Parameters.AddWithValue("canonical_request_hash", canonicalRequestHash);
            insert.Parameters.AddWithValue("idempotency_key", command.IdempotencyKey);
            insert.Parameters.AddWithValue("correlation_id", command.CorrelationId);
            insert.Parameters.AddWithValue("causation_id", command.CausationId);
            insert.Parameters.AddWithValue("audit_reference", command.AuditReference);
            insert.Parameters.AddWithValue("outbox_event_id", outboxEventId);
            insert.Parameters.AddWithValue("emitted_at", emittedAt);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }

        var result = await FindSettlementRequestByIdempotencyAsync(
            connection,
            transaction,
            command.IdempotencyKey,
            cancellationToken)
            ?? throw new InvalidOperationException("Outcome settlement request was not persisted.");
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

    public async Task<CanonicalOutcomeVersion?> FindCurrentAsync(Guid drawId, CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        return await FindCurrentAsync(connection, null, drawId, cancellationToken);
    }

    public async Task<CanonicalOutcomeReplayEvidence?> LoadReplayEvidenceAsync(
        Guid outcomeVersionId,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(
            IsolationLevel.RepeatableRead,
            cancellationToken);
        var outcome = await FindByIdAsync(connection, transaction, outcomeVersionId, cancellationToken);
        if (outcome is null)
        {
            return null;
        }

        var manifest = await FindExecutionManifestAsync(connection, transaction, outcome.DrawId, cancellationToken)
            ?? throw new InvalidOperationException("Replay could not load the exact Execution Manifest.");
        var certificate = await FindCertificateEvidenceAsync(
            outcome.OutcomeCertificateId,
            outcome.OutcomeCertificateHash,
            cancellationToken)
            ?? throw new InvalidOperationException("Replay could not load verified certificate evidence.");

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select
  evidence.canonical_result_payload::text,
  evidence.canonical_result_hash,
  evidence.result_hash,
  evidence.evidence_hash,
  request.settlement_request_id,
  request.settlement_input_id,
  input.canonical_payload_hash,
  case
    when request.settlement_request_id is null then true
    when version.version_kind = 'Cancelled' then request.settlement_input_id is null
    else input.settlement_input_id is not null
      and input.outcome_certificate_id = version.outcome_certificate_id
      and input.outcome_certificate_hash = version.outcome_certificate_hash
      and input.evaluator_version = version.evaluator_version
  end as settlement_references_valid
from game_engine.canonical_outcome_versions version
join game_engine.outcome_provider_execution_evidence evidence
  on evidence.evidence_id = version.provider_evidence_id
left join game_engine.outcome_settlement_requests request
  on request.outcome_version_id = version.outcome_version_id
left join game_engine.settlement_input_records input
  on input.settlement_input_id = request.settlement_input_id
where version.outcome_version_id = @outcome_version_id;
""";
        command.Parameters.AddWithValue("outcome_version_id", outcomeVersionId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException("Replay could not load exact provider evidence.");
        }

        var result = new CanonicalOutcomeReplayEvidence(
            outcome,
            manifest,
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            certificate,
            reader.IsDBNull(4) ? null : reader.GetGuid(4),
            reader.IsDBNull(5) ? null : reader.GetGuid(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.GetBoolean(7));
        await reader.DisposeAsync();
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

    public async Task<CanonicalOutcomeLifecycleEvent> AppendLifecycleEventAsync(
        CanonicalOutcomeLifecycleEvent lifecycleEvent,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await AcquireLockAsync(
            connection,
            transaction,
            $"canonical-lifecycle:{lifecycleEvent.IdempotencyKey}",
            cancellationToken);
        var existing = await FindLifecycleEventByIdempotencyAsync(
            connection,
            transaction,
            lifecycleEvent.IdempotencyKey,
            cancellationToken);
        if (existing is not null)
        {
            EnsureSameHash(existing.CanonicalRequestHash, lifecycleEvent.CanonicalRequestHash, "lifecycle event");
            await transaction.CommitAsync(cancellationToken);
            return existing;
        }

        await InsertLifecycleEventAsync(connection, transaction, lifecycleEvent, cancellationToken);
        var persisted = await FindLifecycleEventByIdempotencyAsync(
            connection,
            transaction,
            lifecycleEvent.IdempotencyKey,
            cancellationToken)
            ?? throw new InvalidOperationException("Canonical lifecycle evidence was not persisted.");
        await transaction.CommitAsync(cancellationToken);
        return persisted;
    }

    public async Task<DrawExecutionManifest?> FindExecutionManifestAsync(
        Guid drawId,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        return await FindExecutionManifestAsync(connection, null, drawId, cancellationToken);
    }

    public async Task<CanonicalOutcomeCertificateVerificationEvidence?> FindCertificateEvidenceAsync(
        Guid certificateId,
        string certificateHash,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  event.outcome_id,
  event.draw_id,
  event.outcome_payload::text,
  event.canonical_outcome_hash,
  event.generated_at,
  signature.signature_id,
  signature.certificate_reference_type,
  signature.provider_id,
  signature.provider_version,
  signature.algorithm,
  signature.algorithm_version,
  signature.canonical_payload_hash,
  signature.signature_value,
  signature.verification_status,
  signature.issued_at,
  provider.provider_type,
  provider.production_eligible,
  provider.key_identifier,
  provider.verification_support,
  provider.key_rotation_support,
  provider.failure_mode,
  provider.content_hash,
  provider.lifecycle_state,
  certificate.previous_certificates::text
from game_engine.outcome_certificates certificate
join game_engine.outcome_events event on event.outcome_id = certificate.outcome_id
join game_engine.certificate_signatures signature
  on signature.certificate_reference_type = 'OutcomeCertificate'
 and signature.certificate_id = certificate.certificate_id
 and signature.canonical_payload_hash = certificate.canonical_outcome_hash
 and signature.verification_status = 'Verified'
join game_engine.signing_providers provider
  on provider.provider_id = signature.provider_id
 and provider.provider_version = signature.provider_version
where certificate.certificate_id = @certificate_id
  and certificate.canonical_outcome_hash = @certificate_hash
  and certificate.custody_state = 'Certified';
""";
        command.Parameters.AddWithValue("certificate_id", certificateId);
        command.Parameters.AddWithValue("certificate_hash", certificateHash);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        var evidence = new CanonicalOutcomeCertificateVerificationEvidence(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetFieldValue<DateTimeOffset>(4),
            reader.GetGuid(5),
            string.Empty,
            new SigningProviderDefinition(
                reader.GetString(7),
                reader.GetString(8),
                ParseSigningProviderType(reader.GetString(15)),
                reader.GetBoolean(16),
                reader.GetString(9),
                reader.GetString(17),
                reader.GetString(10),
                reader.GetBoolean(18),
                reader.GetBoolean(19),
                ParseSigningFailureMode(reader.GetString(20)),
                reader.GetString(21),
                ParseSigningLifecycle(reader.GetString(22))),
            new CertificateSignature(
                reader.GetGuid(5),
                reader.GetString(6),
                certificateId,
                reader.GetString(7),
                reader.GetString(8),
                reader.GetString(9),
                reader.GetString(10),
                reader.GetString(11),
                reader.GetString(12),
                ParseSignatureStatus(reader.GetString(13)),
                reader.GetFieldValue<DateTimeOffset>(14)),
            JsonSerializer.Deserialize<CertificateReference[]>(
                reader.GetString(23),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? []);
        if (await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException(
                "Outcome Certificate has multiple verified signatures; exact verification evidence is ambiguous.");
        }

        return evidence with
        {
            VerificationEvidenceHash = HashCanonical(string.Join(
                "|",
                evidence.SignatureId.ToString("N"),
                evidence.Signature.ProviderId,
                evidence.Signature.ProviderVersion,
                evidence.Signature.Algorithm,
                evidence.Signature.AlgorithmVersion,
                evidence.Signature.CanonicalPayloadHash,
                evidence.Signature.SignatureValue,
                evidence.Signature.VerificationStatus))
        };
    }

    public async Task<CanonicalOutcomePipelineReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        var schemaReady = false;
        var outboxDispatcherReady = false;
        var settlementWorkerReady = false;
        try
        {
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('game_engine.canonical_outcome_versions') is not null,
  to_regclass('game_engine.outcome_settlement_requests') is not null,
  to_regclass('public.outbox_events') is not null,
  to_regclass('game_engine.outcome_settlement_consumptions') is not null,
  to_regclass('game_engine.canonical_draw_completion_evidence') is not null,
  to_regclass('game_engine.canonical_outcome_recovery_events') is not null,
  to_regclass('game_engine.canonical_runtime_components') is not null,
  to_regclass('game_engine.canonical_draw_execution_leases') is not null,
  to_regclass('game_engine.canonical_draw_orchestration_events') is not null,
  to_regclass('game_engine.outcome_settlement_acknowledgements') is not null,
  to_regclass('game_engine.published_draw_schedule_versions') is not null,
  to_regclass('game_engine.draw_execution_manifests') is not null,
  to_regclass('game_engine.canonical_outcome_lifecycle_events') is not null,
  exists (
    select 1
    from platform_migrations.migration_history
    where migration_id = '099_add_outcome_lifecycle_authority'
      and status = 'APPLIED'
  ),
  exists (
    select 1
    from game_engine.canonical_runtime_components
    where component_name = 'outbox-dispatcher'
      and runtime_kind = 'COMPILED_JAVASCRIPT'
      and status = 'READY'
      and last_seen_at >= now() - interval '2 minutes'
  ),
  exists (
    select 1
    from game_engine.canonical_runtime_components
    where component_name = 'settlement-worker'
      and runtime_kind = 'COMPILED_JAVASCRIPT'
      and status = 'READY'
      and last_seen_at >= now() - interval '2 minutes'
  );
""";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (await reader.ReadAsync(cancellationToken))
            {
                schemaReady = Enumerable.Range(0, 14).All(reader.GetBoolean);
                outboxDispatcherReady = reader.GetBoolean(14);
                settlementWorkerReady = reader.GetBoolean(15);
            }

            if (!schemaReady)
                blockers.Add("Canonical draw orchestration schema, shared outbox, or migration evidence is missing.");
            if (!outboxDispatcherReady)
                blockers.Add("Compiled outbox dispatcher runtime is not reporting ready.");
            if (!settlementWorkerReady)
                blockers.Add("Compiled Settlement worker or RabbitMQ consumption is not reporting ready.");
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or InvalidOperationException)
        {
            blockers.Add(error.Message);
        }

        if (legacyPublicationEnabled)
        {
            blockers.Add("Legacy outcome publication is enabled; canonical production promotion fails closed.");
        }

        var dependencyReady = schemaReady && outboxDispatcherReady && settlementWorkerReady;
        var legacyPublicationDisabled = !legacyPublicationEnabled;
        return new CanonicalOutcomePipelineReadiness(
            true,
            schemaReady,
            schemaReady,
            schemaReady,
            schemaReady,
            schemaReady,
            schemaReady,
            dependencyReady,
            outboxDispatcherReady,
            outboxDispatcherReady && settlementWorkerReady,
            settlementWorkerReady,
            settlementWorkerReady,
            schemaReady,
            schemaReady,
            legacyPublicationDisabled,
            true,
            legacyPublicationDisabled,
            blockers);
    }

    public async Task<CanonicalOutcomeRecoveryResult> RecoverAsync(
        CanonicalOutcomeRecoveryCommand command,
        CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        var requestsCreated = 0;
        var eventsRequeued = 0;
        var blockedCount = 0;
        await using var lockConnection = new NpgsqlConnection(connectionString);
        await lockConnection.OpenAsync(cancellationToken);
        var lockAcquired = await TryAcquireRecoveryLockAsync(lockConnection, cancellationToken);
        if (!lockAcquired)
        {
            return new CanonicalOutcomeRecoveryResult(
                0, 0, 0, 0, false, [], DateTimeOffset.UtcNow);
        }

        try
        {
            var missing = await FindMissingRequestsAsync(lockConnection, command.Limit, cancellationToken);
            foreach (var candidate in missing)
            {
                Guid? settlementInputId = null;
                if (candidate.VersionKind != CanonicalOutcomeVersionKind.Cancelled)
                {
                    var inputs = await FindSettlementInputsAsync(
                        lockConnection,
                        candidate.OutcomeCertificateId,
                        candidate.OutcomeCertificateHash,
                        cancellationToken);
                    if (inputs.Count != 1)
                    {
                        blockedCount += 1;
                        var reason = inputs.Count == 0
                            ? "No certificate-backed SettlementInput is available."
                            : "Multiple SettlementInputs exist for one draw-level canonical request.";
                        blockers.Add($"{candidate.OutcomeVersionId}: {reason}");
                        await RecordBlockedRecoveryOnceAsync(
                            lockConnection,
                            candidate.OutcomeVersionId,
                            reason,
                            cancellationToken);
                        await AppendRecoveryLifecycleEventAsync(
                            lockConnection,
                        command,
                        candidate,
                        null,
                        null,
                        reason,
                            "blocked",
                            cancellationToken);
                        continue;
                    }
                    settlementInputId = inputs[0];
                }

                var recoveryCommand = new OutcomeSettlementRequestCommand(
                    $"canonical-recovery:{candidate.OutcomeVersionId:N}",
                    candidate.OutcomeVersionId,
                    settlementInputId,
                    candidate.CorrelationId,
                    $"canonical-recovery:{candidate.OutcomeVersionId:N}",
                    $"canonical-recovery:{candidate.AuditReference}");
                var request = await EmitSettlementRequestAsync(
                    recoveryCommand,
                    HashSettlementRequest(recoveryCommand),
                    cancellationToken);
                await RecordRecoveryEventAsync(
                    lockConnection,
                    candidate.OutcomeVersionId,
                    request.SettlementRequestId,
                    "REQUEST_CREATED",
                    "Missing canonical Settlement request created.",
                    cancellationToken);
                await AppendRecoveryLifecycleEventAsync(
                    lockConnection,
                    command,
                    candidate,
                    request.SettlementRequestId,
                    request.SettlementInputId,
                    "Missing canonical Settlement request created from immutable evidence.",
                    "request-created",
                    cancellationToken);
                requestsCreated += 1;
            }

            var replayCandidates = await FindUnconfirmedPublishedRequestsAsync(
                lockConnection,
                command.Limit,
                cancellationToken);
            foreach (var candidate in replayCandidates)
            {
                await using var transaction = await lockConnection.BeginTransactionAsync(cancellationToken);
                await using var update = lockConnection.CreateCommand();
                update.Transaction = transaction;
                update.CommandText = """
update public.outbox_events
set
  status = 'PENDING',
  next_attempt_at = now(),
  published_at = null,
  last_error = 'Canonical missing-consumption recovery replay.'
where id = @outbox_event_id
  and status = 'PUBLISHED';
""";
                update.Parameters.AddWithValue("outbox_event_id", candidate.OutboxEventId);
                var updated = await update.ExecuteNonQueryAsync(cancellationToken);
                if (updated == 1)
                {
                    await RecordRecoveryEventAsync(
                        lockConnection,
                        candidate.OutcomeVersionId,
                        candidate.SettlementRequestId,
                        "EVENT_REQUEUED",
                        "Unconfirmed canonical Settlement request requeued with the same event id.",
                        cancellationToken,
                        transaction);
                    var outcome = await FindByIdAsync(
                        lockConnection,
                        transaction,
                        candidate.OutcomeVersionId,
                        cancellationToken)
                        ?? throw new InvalidOperationException("Recovery outcome disappeared during replay.");
                    await InsertLifecycleEventAsync(
                        lockConnection,
                        transaction,
                        CreateRecoveryLifecycleEvent(
                            command,
                            outcome,
                            candidate.SettlementRequestId,
                            candidate.SettlementInputId,
                            "Unconfirmed Settlement request requeued with its original outbox event.",
                            $"event-requeued:{candidate.OutboxEventId:N}"),
                        cancellationToken,
                        ignoreDuplicate: true);
                    eventsRequeued += 1;
                }
                await transaction.CommitAsync(cancellationToken);
            }

            return new CanonicalOutcomeRecoveryResult(
                missing.Count,
                requestsCreated,
                eventsRequeued,
                blockedCount,
                true,
                blockers,
                DateTimeOffset.UtcNow);
        }
        finally
        {
            await ReleaseRecoveryLockAsync(lockConnection, cancellationToken);
        }
    }

    private static async Task<bool> TryAcquireRecoveryLockAsync(
        NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "select pg_try_advisory_lock(hashtextextended('canonical-outcome-recovery', 0));";
        return (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);
    }

    private static async Task ReleaseRecoveryLockAsync(
        NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "select pg_advisory_unlock(hashtextextended('canonical-outcome-recovery', 0));";
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<IReadOnlyList<RecoveryCandidate>> FindMissingRequestsAsync(
        NpgsqlConnection connection,
        int limit,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  version.outcome_version_id,
  version.version_kind,
  version.outcome_certificate_id,
  version.outcome_certificate_hash,
  version.correlation_id,
  version.audit_reference
from game_engine.canonical_outcome_versions version
where not exists (
    select 1
    from game_engine.canonical_outcome_versions newer
    where newer.draw_id = version.draw_id
      and newer.version_number > version.version_number
  )
  and not exists (
    select 1
    from game_engine.outcome_settlement_requests request
    where request.outcome_version_id = version.outcome_version_id
  )
order by
  case
    when version.version_kind = 'Cancelled' or exists (
      select 1
      from game_engine.settlement_input_records input
      where input.outcome_certificate_id = version.outcome_certificate_id
        and input.outcome_certificate_hash = version.outcome_certificate_hash
    ) then 0
    else 1
  end,
  version.published_at,
  version.outcome_version_id
limit @limit;
""";
        command.Parameters.AddWithValue("limit", limit);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var candidates = new List<RecoveryCandidate>();
        while (await reader.ReadAsync(cancellationToken))
        {
            candidates.Add(new RecoveryCandidate(
                reader.GetGuid(0),
                Enum.Parse<CanonicalOutcomeVersionKind>(reader.GetString(1)),
                reader.GetGuid(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetString(5)));
        }
        return candidates;
    }

    private static async Task<IReadOnlyList<Guid>> FindSettlementInputsAsync(
        NpgsqlConnection connection,
        Guid outcomeCertificateId,
        string outcomeCertificateHash,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select settlement_input_id
from game_engine.settlement_input_records
where outcome_certificate_id = @certificate_id
  and outcome_certificate_hash = @certificate_hash
order by issued_at, settlement_input_id
limit 2;
""";
        command.Parameters.AddWithValue("certificate_id", outcomeCertificateId);
        command.Parameters.AddWithValue("certificate_hash", outcomeCertificateHash);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var ids = new List<Guid>();
        while (await reader.ReadAsync(cancellationToken))
        {
            ids.Add(reader.GetGuid(0));
        }
        return ids;
    }

    private static async Task<IReadOnlyList<UnconfirmedRequest>> FindUnconfirmedPublishedRequestsAsync(
        NpgsqlConnection connection,
        int limit,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  request.settlement_request_id,
  request.outcome_version_id,
  request.outbox_event_id,
  request.settlement_input_id
from game_engine.outcome_settlement_requests request
join game_engine.canonical_outcome_versions version
  on version.outcome_version_id = request.outcome_version_id
join public.outbox_events event on event.id = request.outbox_event_id
where event.status = 'PUBLISHED'
  and event.published_at < now() - interval '10 seconds'
  and not exists (
    select 1
    from game_engine.outcome_settlement_consumptions consumption
    where consumption.settlement_request_id = request.settlement_request_id
  )
  and not exists (
    select 1
    from game_engine.canonical_outcome_versions newer
    where newer.draw_id = version.draw_id
      and newer.version_number > version.version_number
  )
  and (
    select count(*)
    from game_engine.canonical_outcome_recovery_events recovery
    where recovery.outcome_version_id = request.outcome_version_id
      and recovery.recovery_action = 'EVENT_REQUEUED'
  ) < 5
order by event.published_at, request.settlement_request_id
limit @limit;
""";
        command.Parameters.AddWithValue("limit", limit);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var candidates = new List<UnconfirmedRequest>();
        while (await reader.ReadAsync(cancellationToken))
        {
            candidates.Add(new UnconfirmedRequest(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetGuid(2),
                reader.IsDBNull(3) ? null : reader.GetGuid(3)));
        }
        return candidates;
    }

    private static async Task RecordBlockedRecoveryOnceAsync(
        NpgsqlConnection connection,
        Guid outcomeVersionId,
        string reason,
        CancellationToken cancellationToken)
    {
        await using var check = connection.CreateCommand();
        check.CommandText = """
select exists (
  select 1
  from game_engine.canonical_outcome_recovery_events
  where outcome_version_id = @outcome_version_id
    and recovery_action = 'BLOCKED'
    and reason = @reason
);
""";
        check.Parameters.AddWithValue("outcome_version_id", outcomeVersionId);
        check.Parameters.AddWithValue("reason", reason);
        if ((bool)(await check.ExecuteScalarAsync(cancellationToken) ?? false))
        {
            return;
        }
        await RecordRecoveryEventAsync(
            connection,
            outcomeVersionId,
            null,
            "BLOCKED",
            reason,
            cancellationToken);
    }

    private static async Task RecordRecoveryEventAsync(
        NpgsqlConnection connection,
        Guid outcomeVersionId,
        Guid? settlementRequestId,
        string action,
        string reason,
        CancellationToken cancellationToken,
        NpgsqlTransaction? transaction = null)
    {
        var evidenceHash = HashCanonical(
            $"{outcomeVersionId:N}|{settlementRequestId?.ToString("N") ?? "none"}|{action}|{reason}");
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.canonical_outcome_recovery_events (
  recovery_event_id,
  outcome_version_id,
  settlement_request_id,
  recovery_action,
  attempt_number,
  reason,
  canonical_evidence_hash
)
select
  @recovery_event_id,
  @outcome_version_id,
  @settlement_request_id,
  @recovery_action,
  coalesce(max(attempt_number), 0) + 1,
  @reason,
  @canonical_evidence_hash
from game_engine.canonical_outcome_recovery_events
where outcome_version_id = @outcome_version_id
  and recovery_action = @recovery_action;
""";
        command.Parameters.AddWithValue("recovery_event_id", Guid.NewGuid());
        command.Parameters.AddWithValue("outcome_version_id", outcomeVersionId);
        command.Parameters.AddWithValue(
            "settlement_request_id",
            settlementRequestId is null ? DBNull.Value : settlementRequestId.Value);
        command.Parameters.AddWithValue("recovery_action", action);
        command.Parameters.AddWithValue("reason", reason);
        command.Parameters.AddWithValue("canonical_evidence_hash", evidenceHash);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task AppendRecoveryLifecycleEventAsync(
        NpgsqlConnection connection,
        CanonicalOutcomeRecoveryCommand command,
        RecoveryCandidate candidate,
        Guid? settlementRequestId,
        Guid? settlementInputId,
        string reason,
        string action,
        CancellationToken cancellationToken)
    {
        var outcome = await FindByIdAsync(
            connection,
            null,
            candidate.OutcomeVersionId,
            cancellationToken)
            ?? throw new InvalidOperationException("Recovery outcome evidence was not found.");
        await InsertLifecycleEventAsync(
            connection,
            null,
            CreateRecoveryLifecycleEvent(
                command,
                outcome,
                settlementRequestId,
                settlementInputId,
                reason,
                action),
            cancellationToken,
            ignoreDuplicate: true);
    }

    private static CanonicalOutcomeLifecycleEvent CreateRecoveryLifecycleEvent(
        CanonicalOutcomeRecoveryCommand command,
        CanonicalOutcomeVersion outcome,
        Guid? settlementRequestId,
        Guid? settlementInputId,
        string reason,
        string action)
    {
        var idempotencyKey = $"recovery:{outcome.OutcomeVersionId:N}:{action}";
        var requestHash = HashCanonical(string.Join("|",
            outcome.OutcomeVersionId.ToString("N"),
            action,
            settlementRequestId?.ToString("N") ?? "none",
            command.ActorReference,
            command.ReasonCode,
            command.CorrelationId,
            command.CausationId));
        return new CanonicalOutcomeLifecycleEvent(
            Guid.NewGuid(),
            CanonicalOutcomeLifecycleOperation.Recovery,
            outcome.OutcomeVersionId,
            outcome.DrawId,
            outcome.OutcomeCertificateId,
            outcome.ProviderEvidenceId,
            outcome.PreviousOutcomeVersionId,
            settlementRequestId,
            settlementInputId,
            command.ActorReference,
            $"{command.ReasonCode}:{reason}",
            command.CorrelationId,
            command.CausationId,
            requestHash,
            HashCanonical($"{idempotencyKey}|{requestHash}"),
            idempotencyKey,
            DateTimeOffset.UtcNow);
    }

    private static async Task InsertLifecycleEventAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        CanonicalOutcomeLifecycleEvent lifecycleEvent,
        CancellationToken cancellationToken,
        bool ignoreDuplicate = false)
    {
        await using var insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = $"""
insert into game_engine.canonical_outcome_lifecycle_events (
  lifecycle_event_id, operation, outcome_version_id, draw_id,
  outcome_certificate_id, provider_evidence_id, previous_outcome_version_id,
  settlement_request_id, settlement_input_id, actor_reference, reason_code,
  correlation_id, causation_id, canonical_request_hash, evidence_hash,
  idempotency_key, created_at)
values (
  @lifecycle_event_id, @operation, @outcome_version_id, @draw_id,
  @outcome_certificate_id, @provider_evidence_id, @previous_outcome_version_id,
  @settlement_request_id, @settlement_input_id, @actor_reference, @reason_code,
  @correlation_id, @causation_id, @canonical_request_hash, @evidence_hash,
  @idempotency_key, @created_at)
{(ignoreDuplicate ? "on conflict (idempotency_key) do nothing" : string.Empty)};
""";
        insert.Parameters.AddWithValue("lifecycle_event_id", lifecycleEvent.LifecycleEventId);
        insert.Parameters.AddWithValue("operation", ToDatabaseOperation(lifecycleEvent.Operation));
        insert.Parameters.AddWithValue("outcome_version_id", lifecycleEvent.OutcomeVersionId);
        insert.Parameters.AddWithValue("draw_id", lifecycleEvent.DrawId);
        insert.Parameters.AddWithValue("outcome_certificate_id", lifecycleEvent.OutcomeCertificateId);
        insert.Parameters.AddWithValue("provider_evidence_id", lifecycleEvent.ProviderEvidenceId);
        insert.Parameters.AddWithValue("previous_outcome_version_id", lifecycleEvent.PreviousOutcomeVersionId is null ? DBNull.Value : lifecycleEvent.PreviousOutcomeVersionId.Value);
        insert.Parameters.AddWithValue("settlement_request_id", lifecycleEvent.SettlementRequestId is null ? DBNull.Value : lifecycleEvent.SettlementRequestId.Value);
        insert.Parameters.AddWithValue("settlement_input_id", lifecycleEvent.SettlementInputId is null ? DBNull.Value : lifecycleEvent.SettlementInputId.Value);
        insert.Parameters.AddWithValue("actor_reference", lifecycleEvent.ActorReference);
        insert.Parameters.AddWithValue("reason_code", lifecycleEvent.ReasonCode);
        insert.Parameters.AddWithValue("correlation_id", lifecycleEvent.CorrelationId);
        insert.Parameters.AddWithValue("causation_id", lifecycleEvent.CausationId);
        insert.Parameters.AddWithValue("canonical_request_hash", lifecycleEvent.CanonicalRequestHash);
        insert.Parameters.AddWithValue("evidence_hash", lifecycleEvent.EvidenceHash);
        insert.Parameters.AddWithValue("idempotency_key", lifecycleEvent.IdempotencyKey);
        insert.Parameters.AddWithValue("created_at", lifecycleEvent.CreatedAt);
        await insert.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<CanonicalOutcomeLifecycleEvent?> FindLifecycleEventByIdempotencyAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var query = connection.CreateCommand();
        query.Transaction = transaction;
        query.CommandText = """
select lifecycle_event_id, operation, outcome_version_id, draw_id,
  outcome_certificate_id, provider_evidence_id, previous_outcome_version_id,
  settlement_request_id, settlement_input_id, actor_reference, reason_code,
  correlation_id, causation_id, canonical_request_hash, evidence_hash,
  idempotency_key, created_at
from game_engine.canonical_outcome_lifecycle_events
where idempotency_key = @idempotency_key;
""";
        query.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await query.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new CanonicalOutcomeLifecycleEvent(
                reader.GetGuid(0),
                ParseLifecycleOperation(reader.GetString(1)),
                reader.GetGuid(2),
                reader.GetGuid(3),
                reader.GetGuid(4),
                reader.GetGuid(5),
                reader.IsDBNull(6) ? null : reader.GetGuid(6),
                reader.IsDBNull(7) ? null : reader.GetGuid(7),
                reader.IsDBNull(8) ? null : reader.GetGuid(8),
                reader.GetString(9),
                reader.GetString(10),
                reader.GetString(11),
                reader.GetString(12),
                reader.GetString(13),
                reader.GetString(14),
                reader.GetString(15),
                reader.GetFieldValue<DateTimeOffset>(16))
            : null;
    }

    private static string HashSettlementRequest(OutcomeSettlementRequestCommand command)
    {
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["auditReference"] = command.AuditReference,
            ["causationId"] = command.CausationId,
            ["correlationId"] = command.CorrelationId,
            ["outcomeVersionId"] = command.OutcomeVersionId,
            ["settlementInputId"] = command.SettlementInputId
        };
        return HashCanonical(JsonSerializer.Serialize(payload));
    }

    private static string HashCanonical(string value) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";

    private static async Task AcquireLockAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string scope,
        CancellationToken cancellationToken)
    {
        await using var timeout = connection.CreateCommand();
        timeout.Transaction = transaction;
        timeout.CommandText = "set local lock_timeout = '5s';";
        await timeout.ExecuteNonQueryAsync(cancellationToken);

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "select pg_advisory_xact_lock(hashtextextended(@scope, 0));";
        command.Parameters.AddWithValue("scope", scope);
        try
        {
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.LockNotAvailable)
        {
            throw new InvalidOperationException($"Timed out acquiring canonical outcome lock for {scope}.", error);
        }
    }

    private async Task ClaimExecutionLeaseAsync(
        Guid drawId,
        Guid leaseToken,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select game_engine.claim_canonical_draw_execution_lease(
  @draw_id,
  @lease_token,
  @owner_reference,
  interval '30 seconds');
""";
        command.Parameters.AddWithValue("draw_id", drawId);
        command.Parameters.AddWithValue("lease_token", leaseToken);
        command.Parameters.AddWithValue("owner_reference", $"game-engine:{Environment.MachineName}");
        var acquired = (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);
        if (!acquired)
        {
            throw new InvalidOperationException($"Draw {drawId} already has an active canonical execution lease.");
        }
    }

    private async Task ReleaseExecutionLeaseAsync(
        Guid drawId,
        Guid leaseToken,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "select game_engine.release_canonical_draw_execution_lease(@draw_id, @lease_token);";
        command.Parameters.AddWithValue("draw_id", drawId);
        command.Parameters.AddWithValue("lease_token", leaseToken);
        await command.ExecuteScalarAsync(cancellationToken);
    }

    private static async Task<SourceOutcome> LoadSourceOutcomeAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        CanonicalOutcomePublicationCommand command,
        CancellationToken cancellationToken)
    {
        await using var query = connection.CreateCommand();
        query.Transaction = transaction;
        query.CommandText = """
select
  oe.outcome_id,
  oe.outcome_payload::text,
  oe.canonical_outcome_hash,
  oe.generated_at
from game_engine.outcome_certificates oc
join game_engine.outcome_events oe on oe.outcome_id = oc.outcome_id
where oc.certificate_id = @certificate_id
  and oc.draw_id = @draw_id
  and oc.canonical_outcome_hash = @certificate_hash
limit 1;
""";
        query.Parameters.AddWithValue("certificate_id", command.OutcomeCertificateId);
        query.Parameters.AddWithValue("draw_id", command.DrawId);
        query.Parameters.AddWithValue("certificate_hash", command.OutcomeCertificateHash);
        await using var reader = await query.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new InvalidOperationException("Verified Outcome Certificate evidence was not found for the draw.");
        }

        return new SourceOutcome(
            reader.GetGuid(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetFieldValue<DateTimeOffset>(3));
    }

    private static void ValidateVersionTransition(
        CanonicalOutcomePublicationCommand command,
        CanonicalOutcomeVersion? current,
        SourceOutcome source,
        CanonicalOutcomeAuthorityContext context)
    {
        if (command.VersionKind == CanonicalOutcomeVersionKind.Published)
        {
            if (current is not null)
            {
                throw new InvalidOperationException("The draw already has a canonical outcome publication.");
            }
            return;
        }

        if (current is null || command.PreviousOutcomeVersionId != current.OutcomeVersionId)
        {
            throw new InvalidOperationException("Correction or cancellation must supersede the exact current outcome version.");
        }

        if (current.VersionKind == CanonicalOutcomeVersionKind.Cancelled)
        {
            throw new InvalidOperationException("A cancelled outcome is terminal.");
        }

        if (command.VersionKind == CanonicalOutcomeVersionKind.Corrected &&
            string.Equals(source.CanonicalOutcomeHash, current.CanonicalOutcomeHash, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("A corrected outcome must contain different certified outcome evidence.");
        }

        if (command.VersionKind == CanonicalOutcomeVersionKind.Corrected &&
            current.ProviderEvidenceId != Guid.Empty &&
            (current.ProviderEvidenceId == context.Provider.Evidence.EvidenceId ||
             current.ProviderExecutionId == context.Provider.Evidence.ExecutionId))
        {
            throw new InvalidOperationException(
                "A corrected outcome requires different superseding provider evidence.");
        }
    }

    private static void ValidateAuthorityContext(
        CanonicalOutcomePublicationCommand command,
        CanonicalOutcomeAuthorityContext context,
        DrawExecutionManifest storedManifest,
        SourceOutcome source)
    {
        var manifest = context.Manifest;
        var provider = context.Provider;
        if (manifest != storedManifest ||
            manifest.DrawId != command.DrawId ||
            provider.Evidence.ExecutionManifestId != manifest.ExecutionManifestId ||
            provider.Evidence.DrawId != manifest.DrawId ||
            provider.Evidence.Stage != OutcomeProviderEvidenceStage.Authoritative ||
            provider.Evidence.OutcomeCertificateId != command.OutcomeCertificateId ||
            provider.Evidence.OutcomeCertificateHash != command.OutcomeCertificateHash ||
            provider.Registration.ProviderId != manifest.OutcomeProviderId ||
            provider.Registration.ProviderVersion != manifest.OutcomeProviderVersion ||
            provider.Registration.ConfigurationVersion != manifest.ProviderConfigurationVersion)
        {
            throw new InvalidOperationException(
                "Canonical Outcome authority context does not match the persisted manifest and provider evidence.");
        }

        if (context.GameDefinitionVersion.Id != manifest.GameDefinitionVersionId ||
            context.GameDefinitionVersion.DefinitionHash != context.ValidatedResult.GameDefinitionHash ||
            context.ValidatedResult.EvaluatorVersion != manifest.EvaluatorVersion ||
            context.ValidatedResultHash != provider.Evidence.CanonicalResultHash ||
            context.ValidatedResultJson != provider.Evidence.CanonicalResultJson ||
            source.OutcomeId != context.CertificateEvidence.OutcomeId ||
            source.CanonicalOutcomeHash != context.CertificateEvidence.OutcomeHash ||
            context.CertificateEvidence.Signature.CertificateId != command.OutcomeCertificateId ||
            context.CertificateEvidence.Signature.CanonicalPayloadHash != command.OutcomeCertificateHash)
        {
            throw new InvalidOperationException(
                "Canonical Outcome authority context contains mismatched game, evaluator, result, or certificate evidence.");
        }
    }

    private static async Task InsertOutboxAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid id,
        string eventType,
        string aggregateType,
        string aggregateId,
        string payload,
        string correlationId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into public.outbox_events (
  id,
  event_type,
  aggregate_type,
  aggregate_id,
  payload,
  status,
  correlation_id)
values (
  @id,
  @event_type,
  @aggregate_type,
  @aggregate_id,
  @payload,
  'PENDING',
  @correlation_id);
""";
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("event_type", eventType);
        command.Parameters.AddWithValue("aggregate_type", aggregateType);
        command.Parameters.AddWithValue("aggregate_id", aggregateId);
        command.Parameters.AddWithValue("payload", NpgsqlDbType.Jsonb, payload);
        command.Parameters.AddWithValue("correlation_id", correlationId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<CanonicalOutcomeVersion?> FindByIdempotencyAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{OutcomeSelectSql} where idempotency_key = @idempotency_key limit 1;";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapOutcome(reader) : null;
    }

    private static async Task<CanonicalOutcomeVersion?> FindByIdAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        Guid id,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{OutcomeSelectSql} where outcome_version_id = @id limit 1;";
        command.Parameters.AddWithValue("id", id);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapOutcome(reader) : null;
    }

    private static async Task<CanonicalOutcomeVersion?> FindCurrentAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        Guid drawId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{OutcomeSelectSql} where draw_id = @draw_id order by version_number desc limit 1;";
        command.Parameters.AddWithValue("draw_id", drawId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapOutcome(reader) : null;
    }

    private static async Task<DrawExecutionManifest?> FindExecutionManifestAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        Guid drawId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select
  execution_manifest_id,
  draw_id,
  schedule_version_id,
  game_definition_version_id,
  draw_authority_version_id,
  engine_name,
  engine_version,
  outcome_provider_id,
  outcome_provider_version,
  provider_configuration_version,
  evaluator_version,
  paytable_version,
  scheduled_execution_at,
  schedule_hash,
  draw_identity_hash,
  canonical_manifest_hash,
  created_at
from game_engine.draw_execution_manifests
where draw_id = @draw_id
limit 1;
""";
        command.Parameters.AddWithValue("draw_id", drawId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new DrawExecutionManifest(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetGuid(2),
                reader.GetGuid(3),
                reader.GetGuid(4),
                reader.GetString(5),
                reader.GetString(6),
                reader.GetString(7),
                reader.GetString(8),
                reader.GetString(9),
                reader.GetString(10),
                reader.GetString(11),
                reader.GetFieldValue<DateTimeOffset>(12),
                reader.GetString(13),
                reader.GetString(14),
                reader.GetString(15),
                reader.GetFieldValue<DateTimeOffset>(16))
            : null;
    }

    private static async Task<OutcomeSettlementRequest?> FindSettlementRequestByIdempotencyAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"{SettlementRequestSelectSql} where idempotency_key = @idempotency_key limit 1;";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapSettlementRequest(reader) : null;
    }

    private static async Task<SettlementInputEvidence?> LoadSettlementInputAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid id,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select
  outcome_certificate_id,
  outcome_certificate_hash,
  math_evaluation_certificate_id,
  math_evaluation_certificate_hash,
  evaluator_version,
  canonical_payload_hash
from game_engine.settlement_input_records
where settlement_input_id = @id
limit 1;
""";
        command.Parameters.AddWithValue("id", id);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new SettlementInputEvidence(
                reader.GetGuid(0),
                reader.GetString(1),
                reader.GetGuid(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetString(5))
            : null;
    }

    private static void EnsureSameHash(string existing, string requested, string scope)
    {
        if (!string.Equals(existing, requested, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Conflicting idempotency payload for canonical {scope}.");
        }
    }

    private static CanonicalOutcomeProviderCategory ParseCategory(string value) => value switch
    {
        "INTERNAL_CSPRNG" => CanonicalOutcomeProviderCategory.InternalCsprng,
        "OFFICIAL_RESULTS" => CanonicalOutcomeProviderCategory.OfficialResults,
        "MANUAL_CERTIFIED" => CanonicalOutcomeProviderCategory.ManualCertified,
        _ => throw new InvalidOperationException($"Unsupported canonical provider category {value}.")
    };

    private static string ToDatabaseCategory(CanonicalOutcomeProviderCategory value) => value switch
    {
        CanonicalOutcomeProviderCategory.InternalCsprng => "INTERNAL_CSPRNG",
        CanonicalOutcomeProviderCategory.OfficialResults => "OFFICIAL_RESULTS",
        CanonicalOutcomeProviderCategory.ManualCertified => "MANUAL_CERTIFIED",
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null)
    };

    private static string ToDatabaseOperation(CanonicalOutcomeLifecycleOperation value) => value switch
    {
        CanonicalOutcomeLifecycleOperation.Recovery => "RECOVERY",
        CanonicalOutcomeLifecycleOperation.Correction => "CORRECTION",
        CanonicalOutcomeLifecycleOperation.Cancellation => "CANCELLATION",
        CanonicalOutcomeLifecycleOperation.ReplayVerified => "REPLAY_VERIFIED",
        CanonicalOutcomeLifecycleOperation.ReplayRejected => "REPLAY_REJECTED",
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null)
    };

    private static CanonicalOutcomeLifecycleOperation ParseLifecycleOperation(string value) => value switch
    {
        "RECOVERY" => CanonicalOutcomeLifecycleOperation.Recovery,
        "CORRECTION" => CanonicalOutcomeLifecycleOperation.Correction,
        "CANCELLATION" => CanonicalOutcomeLifecycleOperation.Cancellation,
        "REPLAY_VERIFIED" => CanonicalOutcomeLifecycleOperation.ReplayVerified,
        "REPLAY_REJECTED" => CanonicalOutcomeLifecycleOperation.ReplayRejected,
        _ => throw new InvalidOperationException($"Unsupported canonical lifecycle operation {value}.")
    };

    private static SigningProviderType ParseSigningProviderType(string value) => value switch
    {
        "LOCAL_TEST" => SigningProviderType.LocalTest,
        "SOFTWARE_KEY" => SigningProviderType.SoftwareKey,
        "KMS" => SigningProviderType.Kms,
        "HSM" => SigningProviderType.Hsm,
        "SIMULATION" => SigningProviderType.Simulation,
        _ => throw new InvalidOperationException($"Unsupported signing provider type {value}.")
    };

    private static SigningFailureMode ParseSigningFailureMode(string value) => value switch
    {
        "FailClosed" => SigningFailureMode.FailClosed,
        "FailOpen" => SigningFailureMode.FailOpen,
        _ => throw new InvalidOperationException($"Unsupported signing failure mode {value}.")
    };

    private static SigningProviderLifecycleState ParseSigningLifecycle(string value) => value switch
    {
        "Draft" => SigningProviderLifecycleState.Draft,
        "Active" => SigningProviderLifecycleState.Active,
        "Disabled" => SigningProviderLifecycleState.Disabled,
        "Retired" => SigningProviderLifecycleState.Retired,
        "Revoked" => SigningProviderLifecycleState.Revoked,
        _ => throw new InvalidOperationException($"Unsupported signing provider lifecycle {value}.")
    };

    private static SignatureVerificationStatus ParseSignatureStatus(string value) => value switch
    {
        "Pending" => SignatureVerificationStatus.Pending,
        "Verified" => SignatureVerificationStatus.Verified,
        "Failed" => SignatureVerificationStatus.Failed,
        "Revoked" => SignatureVerificationStatus.Revoked,
        _ => throw new InvalidOperationException($"Unsupported signature verification status {value}.")
    };

    private static CanonicalOutcomeVersion MapOutcome(NpgsqlDataReader reader)
    {
        return new CanonicalOutcomeVersion(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetGuid(2),
            reader.GetString(3),
            reader.IsDBNull(4) ? Guid.Empty : reader.GetGuid(4),
            reader.IsDBNull(5) ? Guid.Empty : reader.GetGuid(5),
            reader.IsDBNull(6) ? CanonicalOutcomeProviderCategory.InternalCsprng : ParseCategory(reader.GetString(6)),
            reader.IsDBNull(7) ? string.Empty : reader.GetString(7),
            reader.IsDBNull(8) ? string.Empty : reader.GetString(8),
            reader.IsDBNull(9) ? string.Empty : reader.GetString(9),
            reader.IsDBNull(10) ? string.Empty : reader.GetString(10),
            reader.IsDBNull(11) ? Guid.Empty : reader.GetGuid(11),
            reader.IsDBNull(12) ? string.Empty : reader.GetString(12),
            reader.IsDBNull(13) ? string.Empty : reader.GetString(13),
            reader.IsDBNull(14) ? Guid.Empty : reader.GetGuid(14),
            reader.IsDBNull(15) ? string.Empty : reader.GetString(15),
            reader.GetString(16),
            reader.GetString(17),
            reader.GetString(18),
            reader.GetInt32(19),
            Enum.Parse<CanonicalOutcomeVersionKind>(reader.GetString(20)),
            reader.GetGuid(21),
            reader.GetGuid(22),
            reader.GetString(23),
            reader.IsDBNull(24) ? null : reader.GetGuid(24),
            reader.GetString(25),
            reader.GetString(26),
            reader.IsDBNull(27) ? reader.GetString(25) : reader.GetString(27),
            reader.IsDBNull(28) ? reader.GetString(26) : reader.GetString(28),
            reader.IsDBNull(29) ? [] : JsonSerializer.Deserialize<int[]>(reader.GetString(29)) ?? [],
            reader.IsDBNull(30) ? [] : JsonSerializer.Deserialize<int[]>(reader.GetString(30)) ?? [],
            reader.IsDBNull(31) ? new Dictionary<string, object?>() : JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(31)) ?? new Dictionary<string, object?>(),
            reader.IsDBNull(32) ? "legacy.v0" : reader.GetString(32),
            reader.GetFieldValue<DateTimeOffset>(33),
            reader.GetString(34),
            reader.GetString(35),
            reader.GetString(36),
            reader.GetString(37),
            reader.IsDBNull(38) ? "legacy" : reader.GetString(38),
            reader.IsDBNull(39) ? "LEGACY_IMPORT" : reader.GetString(39),
            reader.IsDBNull(40) ? "sha256:legacy" : reader.GetString(40),
            reader.GetString(41),
            reader.GetString(42),
            reader.GetGuid(43),
            reader.GetFieldValue<DateTimeOffset>(44));
    }

    private static OutcomeSettlementRequest MapSettlementRequest(NpgsqlDataReader reader)
    {
        return new OutcomeSettlementRequest(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetGuid(2),
            Enum.Parse<CanonicalOutcomeVersionKind>(reader.GetString(3)),
            reader.IsDBNull(4) ? null : reader.GetGuid(4),
            reader.GetString(5),
            reader.GetString(6),
            reader.GetString(7),
            reader.GetString(8),
            reader.GetString(9),
            reader.GetGuid(10),
            reader.GetFieldValue<DateTimeOffset>(11));
    }

    private const string OutcomeSelectSql = """
select
  outcome_version_id,
  draw_id,
  execution_manifest_id,
  execution_manifest_hash,
  provider_evidence_id,
  provider_execution_id,
  outcome_provider_category,
  outcome_provider_id,
  outcome_provider_version,
  provider_configuration_version,
  provider_evidence_hash,
  game_definition_version_id,
  game_definition_hash,
  evaluator_version,
  certificate_signature_id,
  certificate_verification_hash,
  product_reference,
  engine_name,
  engine_version,
  version_number,
  version_kind,
  outcome_id,
  outcome_certificate_id,
  outcome_certificate_hash,
  previous_outcome_version_id,
  outcome_payload::text,
  canonical_outcome_hash,
  validated_outcome_payload::text,
  validated_outcome_hash,
  validated_primary_result::text,
  validated_bonus_result::text,
  derived_outcome_data::text,
  outcome_schema_version,
  generated_at,
  authoritative_source,
  correlation_id,
  causation_id,
  audit_reference,
  actor_reference,
  reason_code,
  lifecycle_evidence_hash,
  canonical_request_hash,
  idempotency_key,
  outbox_event_id,
  published_at
from game_engine.canonical_outcome_versions
""";

    private const string SettlementRequestSelectSql = """
select
  settlement_request_id,
  outcome_version_id,
  draw_id,
  request_kind,
  settlement_input_id,
  canonical_request_hash,
  idempotency_key,
  correlation_id,
  causation_id,
  audit_reference,
  outbox_event_id,
  emitted_at
from game_engine.outcome_settlement_requests
""";

    private sealed record SourceOutcome(
        Guid OutcomeId,
        string OutcomePayloadJson,
        string CanonicalOutcomeHash,
        DateTimeOffset GeneratedAt);

    private sealed record SettlementInputEvidence(
        Guid OutcomeCertificateId,
        string OutcomeCertificateHash,
        Guid MathEvaluationCertificateId,
        string MathEvaluationCertificateHash,
        string EvaluatorVersion,
        string CanonicalPayloadHash);

    private sealed record RecoveryCandidate(
        Guid OutcomeVersionId,
        CanonicalOutcomeVersionKind VersionKind,
        Guid OutcomeCertificateId,
        string OutcomeCertificateHash,
        string CorrelationId,
        string AuditReference);

    private sealed record UnconfirmedRequest(
        Guid SettlementRequestId,
        Guid OutcomeVersionId,
        Guid OutboxEventId,
        Guid? SettlementInputId);
}
