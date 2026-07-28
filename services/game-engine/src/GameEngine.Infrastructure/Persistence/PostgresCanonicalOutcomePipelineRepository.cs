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
        string canonicalRequestHash,
        CancellationToken cancellationToken)
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
        var current = await FindCurrentAsync(connection, transaction, command.DrawId, cancellationToken);
        ValidateVersionTransition(command, current, source);

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
            ["outcomeCertificateHash"] = command.OutcomeCertificateHash,
            ["outcomeCertificateId"] = command.OutcomeCertificateId,
            ["outcomeHash"] = source.CanonicalOutcomeHash,
            ["outcomeVersionId"] = outcomeVersionId,
            ["previousOutcomeVersionId"] = command.PreviousOutcomeVersionId,
            ["productReference"] = command.ProductReference,
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
  outcome_version_id,
  draw_id,
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
  generated_at,
  authoritative_source,
  correlation_id,
  causation_id,
  audit_reference,
  canonical_request_hash,
  idempotency_key,
  outbox_event_id,
  published_at)
values (
  @outcome_version_id,
  @draw_id,
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
  @generated_at,
  @authoritative_source,
  @correlation_id,
  @causation_id,
  @audit_reference,
  @canonical_request_hash,
  @idempotency_key,
  @outbox_event_id,
  @published_at);
""";
            insert.Parameters.AddWithValue("outcome_version_id", outcomeVersionId);
            insert.Parameters.AddWithValue("draw_id", command.DrawId);
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
            insert.Parameters.AddWithValue("generated_at", source.GeneratedAt);
            insert.Parameters.AddWithValue("authoritative_source", command.AuthoritativeSource);
            insert.Parameters.AddWithValue("correlation_id", command.CorrelationId);
            insert.Parameters.AddWithValue("causation_id", command.CausationId);
            insert.Parameters.AddWithValue("audit_reference", command.AuditReference);
            insert.Parameters.AddWithValue("canonical_request_hash", canonicalRequestHash);
            insert.Parameters.AddWithValue("idempotency_key", command.IdempotencyKey);
            insert.Parameters.AddWithValue("outbox_event_id", outboxEventId);
            insert.Parameters.AddWithValue("published_at", publishedAt);
            await insert.ExecuteNonQueryAsync(cancellationToken);
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
                !string.Equals(settlementInput.OutcomeCertificateHash, version.OutcomeCertificateHash, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("SettlementInput does not reference the canonical published Outcome Certificate.");
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
  exists (
    select 1
    from platform_migrations.migration_history
    where migration_id = '080_add_canonical_draw_orchestration'
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
                schemaReady = Enumerable.Range(0, 8).All(reader.GetBoolean);
                outboxDispatcherReady = reader.GetBoolean(8);
                settlementWorkerReady = reader.GetBoolean(9);
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
        int limit,
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
            var missing = await FindMissingRequestsAsync(lockConnection, limit, cancellationToken);
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
                requestsCreated += 1;
            }

            var replayCandidates = await FindUnconfirmedPublishedRequestsAsync(
                lockConnection,
                limit,
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
order by version.published_at, version.outcome_version_id
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
  request.outbox_event_id
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
                reader.GetGuid(2)));
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
        SourceOutcome source)
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
        NpgsqlTransaction transaction,
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
                reader.GetString(4))
            : null;
    }

    private static void EnsureSameHash(string existing, string requested, string scope)
    {
        if (!string.Equals(existing, requested, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Conflicting idempotency payload for canonical {scope}.");
        }
    }

    private static CanonicalOutcomeVersion MapOutcome(NpgsqlDataReader reader)
    {
        return new CanonicalOutcomeVersion(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetInt32(5),
            Enum.Parse<CanonicalOutcomeVersionKind>(reader.GetString(6)),
            reader.GetGuid(7),
            reader.GetGuid(8),
            reader.GetString(9),
            reader.IsDBNull(10) ? null : reader.GetGuid(10),
            reader.GetString(11),
            reader.GetString(12),
            reader.GetFieldValue<DateTimeOffset>(13),
            reader.GetString(14),
            reader.GetString(15),
            reader.GetString(16),
            reader.GetString(17),
            reader.GetString(18),
            reader.GetString(19),
            reader.GetGuid(20),
            reader.GetFieldValue<DateTimeOffset>(21));
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
  generated_at,
  authoritative_source,
  correlation_id,
  causation_id,
  audit_reference,
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
        Guid OutboxEventId);
}
