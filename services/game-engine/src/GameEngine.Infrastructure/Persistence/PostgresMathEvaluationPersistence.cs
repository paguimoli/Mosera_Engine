using System.Text.Json;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;
using NpgsqlTypes;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresMathEvaluationDurableRepository(string connectionString) : IMathEvaluationDurableRepository
{
    public async Task<DurableMathEvaluationClaim> ClaimRequestAsync(
        DurableMathEvaluationRequestRecord request,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var existing = await FindByIdempotencyKeyAsync(connection, request.IdempotencyKey, cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.CanonicalRequestHash, request.CanonicalRequestHash, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Conflicting payload for the same Math Evaluation idempotency key.");
            }

            await transaction.CommitAsync(cancellationToken);
            return new DurableMathEvaluationClaim(existing, Created: false, Duplicate: true);
        }

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.math_evaluation_requests (
  evaluation_request_id,
  idempotency_key,
  canonical_request_hash,
  outcome_certificate_id,
  outcome_certificate_hash,
  game_manifest_id,
  game_manifest_version,
  game_manifest_hash,
  math_model_id,
  math_model_version,
  math_model_hash,
  paytable_id,
  paytable_version,
  paytable_hash,
  ticket_reference,
  wager_schema,
  evaluator_type,
  evaluator_version,
  evaluation_mode,
  status,
  created_at
) values (
  @evaluation_request_id,
  @idempotency_key,
  @canonical_request_hash,
  @outcome_certificate_id,
  @outcome_certificate_hash,
  @game_manifest_id,
  @game_manifest_version,
  @game_manifest_hash,
  @math_model_id,
  @math_model_version,
  @math_model_hash,
  @paytable_id,
  @paytable_version,
  @paytable_hash,
  @ticket_reference,
  @wager_schema,
  @evaluator_type,
  @evaluator_version,
  @evaluation_mode,
  @status,
  @created_at
)
on conflict (idempotency_key) do nothing;
""";
        AddRequestParameters(command, request);
        var inserted = await command.ExecuteNonQueryAsync(cancellationToken);
        var claimed = inserted == 1
            ? request
            : await FindByIdempotencyKeyAsync(connection, request.IdempotencyKey, cancellationToken);

        if (claimed is null)
        {
            throw new InvalidOperationException("Math Evaluation request claim could not be read back deterministically.");
        }

        if (!string.Equals(claimed.CanonicalRequestHash, request.CanonicalRequestHash, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Conflicting payload for the same Math Evaluation idempotency key.");
        }

        await transaction.CommitAsync(cancellationToken);
        return new DurableMathEvaluationClaim(claimed, Created: inserted == 1, Duplicate: inserted != 1);
    }

    public async Task<MathEvaluationAttemptRecord> AppendAttemptAsync(
        Guid evaluationRequestId,
        MathEvaluationAttemptStatus status,
        string? failureCode,
        string? failureReason,
        string canonicalAttemptHash,
        DateTimeOffset startedAt,
        DateTimeOffset? completedAt,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var attemptNumber = await NextAttemptNumberAsync(connection, evaluationRequestId, cancellationToken);
        var attempt = new MathEvaluationAttemptRecord(
            Guid.NewGuid(),
            evaluationRequestId,
            attemptNumber,
            status,
            failureCode,
            failureReason,
            canonicalAttemptHash,
            startedAt,
            completedAt);

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.math_evaluation_attempts (
  attempt_id,
  evaluation_request_id,
  attempt_number,
  status,
  failure_code,
  failure_reason,
  canonical_attempt_hash,
  started_at,
  completed_at
) values (
  @attempt_id,
  @evaluation_request_id,
  @attempt_number,
  @status,
  @failure_code,
  @failure_reason,
  @canonical_attempt_hash,
  @started_at,
  @completed_at
);
""";
        command.Parameters.AddWithValue("attempt_id", attempt.AttemptId);
        command.Parameters.AddWithValue("evaluation_request_id", attempt.EvaluationRequestId);
        command.Parameters.AddWithValue("attempt_number", attempt.AttemptNumber);
        command.Parameters.AddWithValue("status", attempt.Status.ToString());
        command.Parameters.AddWithValue("failure_code", attempt.FailureCode is null ? DBNull.Value : attempt.FailureCode);
        command.Parameters.AddWithValue("failure_reason", attempt.FailureReason is null ? DBNull.Value : attempt.FailureReason);
        command.Parameters.AddWithValue("canonical_attempt_hash", attempt.CanonicalAttemptHash);
        command.Parameters.AddWithValue("started_at", attempt.StartedAt);
        command.Parameters.AddWithValue("completed_at", attempt.CompletedAt is null ? DBNull.Value : attempt.CompletedAt.Value);
        await command.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return attempt;
    }

    public async Task<MathEvaluationResult> CompleteEvaluationAsync(
        DurableMathEvaluationRequestRecord request,
        MathEvaluationResult result,
        IReadOnlyDictionary<string, object?> wagerPayload,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await InsertEvaluationEventAsync(connection, transaction, request, result, wagerPayload, cancellationToken);
        await InsertEvaluationCertificateAsync(connection, transaction, result.Certificate, cancellationToken);
        await CompleteRequestAsync(connection, transaction, request, result, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

    public async Task<DurableMathEvaluationRequestRecord> FailRequestAsync(
        DurableMathEvaluationRequestRecord request,
        string failureCode,
        string failureReason,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
update game_engine.math_evaluation_requests
set status = 'Failed',
    completed_at = @completed_at,
    failure_code = @failure_code,
    failure_reason = @failure_reason
where evaluation_request_id = @evaluation_request_id;
""";
        var completedAt = DateTimeOffset.UtcNow;
        command.Parameters.AddWithValue("completed_at", completedAt);
        command.Parameters.AddWithValue("failure_code", failureCode);
        command.Parameters.AddWithValue("failure_reason", failureReason);
        command.Parameters.AddWithValue("evaluation_request_id", request.EvaluationRequestId);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return request with
        {
            Status = DurableMathEvaluationStatus.Failed,
            CompletedAt = completedAt,
            FailureCode = failureCode,
            FailureReason = failureReason
        };
    }

    public async Task<MathEvaluationResult?> FindCompletedResultAsync(
        Guid evaluationRequestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await FindCompletedResultAsync(connection, evaluationRequestId, cancellationToken);
    }

    public async Task<DurableMathEvaluationRequestRecord?> FindByIdempotencyKeyAsync(
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        return await FindByIdempotencyKeyAsync(connection, idempotencyKey, cancellationToken);
    }

    public async Task<IReadOnlyCollection<DurableMathEvaluationRequestRecord>> FindIncompleteAsync(
        CancellationToken cancellationToken)
    {
        return await QueryRequestsAsync(
            "where status in ('Claimed', 'Failed')",
            [],
            cancellationToken);
    }

    public async Task<IReadOnlyCollection<DurableMathEvaluationRequestRecord>> FindByTicketReferenceAsync(
        string ticketReference,
        CancellationToken cancellationToken)
    {
        return await QueryRequestsAsync(
            "where ticket_reference = @ticket_reference order by created_at, evaluation_request_id",
            [new NpgsqlParameter("ticket_reference", ticketReference)],
            cancellationToken);
    }

    public async Task<IReadOnlyCollection<DurableMathEvaluationRequestRecord>> FindByOutcomeCertificateAsync(
        Guid outcomeCertificateId,
        string outcomeCertificateHash,
        CancellationToken cancellationToken)
    {
        return await QueryRequestsAsync(
            "where outcome_certificate_id = @outcome_certificate_id and outcome_certificate_hash = @outcome_certificate_hash order by created_at, evaluation_request_id",
            [
                new NpgsqlParameter("outcome_certificate_id", outcomeCertificateId),
                new NpgsqlParameter("outcome_certificate_hash", outcomeCertificateHash)
            ],
            cancellationToken);
    }

    public async Task<DurableMathEvaluationRequestRecord?> FindByCertificateHashAsync(
        string certificateHash,
        CancellationToken cancellationToken)
    {
        var matches = await QueryRequestsAsync(
            "where certificate_hash = @certificate_hash order by created_at desc limit 1",
            [new NpgsqlParameter("certificate_hash", certificateHash)],
            cancellationToken);
        return matches.FirstOrDefault();
    }

    public async Task<MathEvaluationPersistenceReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('game_engine.math_evaluation_requests') is not null,
  to_regclass('game_engine.math_evaluation_attempts') is not null,
  to_regclass('game_engine.math_evaluation_events') is not null,
  to_regclass('game_engine.math_evaluation_certificates') is not null;
""";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            await reader.ReadAsync(cancellationToken);
            if (!reader.GetBoolean(0)) blockers.Add("game_engine.math_evaluation_requests is missing.");
            if (!reader.GetBoolean(1)) blockers.Add("game_engine.math_evaluation_attempts is missing.");
            if (!reader.GetBoolean(2)) blockers.Add("game_engine.math_evaluation_events is missing.");
            if (!reader.GetBoolean(3)) blockers.Add("game_engine.math_evaluation_certificates is missing.");
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            blockers.Add(error.Message);
        }

        return new MathEvaluationPersistenceReadiness(
            TypedEvaluatorRegistryReady: true,
            DurableRepositoryConfigured: true,
            DurableRepositoryReachable: blockers.Count == 0,
            IdempotencyConfigured: blockers.Count == 0,
            ReplayVerificationReady: blockers.Count == 0,
            ProductionActivationDisabled: true,
            Blockers: blockers);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static async Task<DurableMathEvaluationRequestRecord?> FindByIdempotencyKeyAsync(
        NpgsqlConnection connection,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = RequestSelectSql + " where idempotency_key = @idempotency_key limit 1;";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapRequest(reader) : null;
    }

    private async Task<IReadOnlyCollection<DurableMathEvaluationRequestRecord>> QueryRequestsAsync(
        string whereClause,
        IReadOnlyCollection<NpgsqlParameter> parameters,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"{RequestSelectSql} {whereClause};";
        foreach (var parameter in parameters)
        {
            command.Parameters.Add(parameter);
        }

        var requests = new List<DurableMathEvaluationRequestRecord>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            requests.Add(MapRequest(reader));
        }

        return requests;
    }

    private static async Task<int> NextAttemptNumberAsync(
        NpgsqlConnection connection,
        Guid evaluationRequestId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select coalesce(max(attempt_number), 0) + 1
from game_engine.math_evaluation_attempts
where evaluation_request_id = @evaluation_request_id;
""";
        command.Parameters.AddWithValue("evaluation_request_id", evaluationRequestId);
        var value = await command.ExecuteScalarAsync(cancellationToken);
        return Convert.ToInt32(value);
    }

    private static async Task InsertEvaluationEventAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        DurableMathEvaluationRequestRecord request,
        MathEvaluationResult result,
        IReadOnlyDictionary<string, object?> wagerPayload,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.math_evaluation_events (
  math_evaluation_id,
  request_id,
  outcome_certificate_id,
  outcome_certificate_hash,
  game_manifest_reference,
  math_model_id,
  math_model_version,
  math_model_hash,
  paytable_id,
  paytable_version,
  paytable_hash,
  ticket_reference,
  wager_payload,
  prize_facts,
  canonical_prize_facts_hash,
  idempotency_key,
  evaluation_mode,
  evaluated_at
) values (
  @math_evaluation_id,
  @request_id,
  @outcome_certificate_id,
  @outcome_certificate_hash,
  @game_manifest_reference,
  @math_model_id,
  @math_model_version,
  @math_model_hash,
  @paytable_id,
  @paytable_version,
  @paytable_hash,
  @ticket_reference,
  @wager_payload,
  @prize_facts,
  @canonical_prize_facts_hash,
  @idempotency_key,
  @evaluation_mode,
  @evaluated_at
)
on conflict (idempotency_key) do nothing;
""";
        command.Parameters.AddWithValue("math_evaluation_id", result.MathEvaluationId);
        command.Parameters.AddWithValue("request_id", request.EvaluationRequestId);
        command.Parameters.AddWithValue("outcome_certificate_id", request.OutcomeCertificateId);
        command.Parameters.AddWithValue("outcome_certificate_hash", request.OutcomeCertificateHash);
        command.Parameters.AddWithValue("game_manifest_reference", GameManifestReference(request));
        command.Parameters.AddWithValue("math_model_id", request.MathModelId);
        command.Parameters.AddWithValue("math_model_version", request.MathModelVersion);
        command.Parameters.AddWithValue("math_model_hash", request.MathModelHash);
        command.Parameters.AddWithValue("paytable_id", request.PaytableId);
        command.Parameters.AddWithValue("paytable_version", request.PaytableVersion);
        command.Parameters.AddWithValue("paytable_hash", request.PaytableHash);
        command.Parameters.AddWithValue("ticket_reference", request.TicketReference);
        command.Parameters.AddWithValue("wager_payload", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(wagerPayload));
        command.Parameters.AddWithValue("prize_facts", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(result.PrizeFacts));
        command.Parameters.AddWithValue("canonical_prize_facts_hash", result.CanonicalPrizeFactsHash);
        command.Parameters.AddWithValue("idempotency_key", request.IdempotencyKey);
        command.Parameters.AddWithValue("evaluation_mode", request.Mode.ToString());
        command.Parameters.AddWithValue("evaluated_at", result.EvaluatedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task InsertEvaluationCertificateAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        MathEvaluationCertificate certificate,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.math_evaluation_certificates (
  certificate_id,
  math_evaluation_id,
  outcome_certificate_id,
  outcome_certificate_hash,
  math_model_id,
  math_model_version,
  math_model_hash,
  paytable_id,
  paytable_version,
  paytable_hash,
  ticket_reference,
  canonical_prize_facts_hash,
  rtp_math_metadata_reference,
  signing_metadata,
  issued_at
) values (
  @certificate_id,
  @math_evaluation_id,
  @outcome_certificate_id,
  @outcome_certificate_hash,
  @math_model_id,
  @math_model_version,
  @math_model_hash,
  @paytable_id,
  @paytable_version,
  @paytable_hash,
  @ticket_reference,
  @canonical_prize_facts_hash,
  @rtp_math_metadata_reference,
  @signing_metadata,
  @issued_at
)
on conflict (certificate_id) do nothing;
""";
        command.Parameters.AddWithValue("certificate_id", certificate.CertificateId);
        command.Parameters.AddWithValue("math_evaluation_id", certificate.MathEvaluationId);
        command.Parameters.AddWithValue("outcome_certificate_id", certificate.OutcomeCertificateId);
        command.Parameters.AddWithValue("outcome_certificate_hash", certificate.OutcomeCertificateHash);
        command.Parameters.AddWithValue("math_model_id", certificate.MathModelId);
        command.Parameters.AddWithValue("math_model_version", certificate.MathModelVersion);
        command.Parameters.AddWithValue("math_model_hash", certificate.MathModelHash);
        command.Parameters.AddWithValue("paytable_id", certificate.PaytableId);
        command.Parameters.AddWithValue("paytable_version", certificate.PaytableVersion);
        command.Parameters.AddWithValue("paytable_hash", certificate.PaytableHash);
        command.Parameters.AddWithValue("ticket_reference", certificate.TicketReference);
        command.Parameters.AddWithValue("canonical_prize_facts_hash", certificate.CanonicalPrizeFactsHash);
        command.Parameters.AddWithValue("rtp_math_metadata_reference", certificate.RtpMathMetadataReference);
        command.Parameters.Add("signing_metadata", NpgsqlDbType.Jsonb).Value =
            certificate.SigningMetadata is null ? DBNull.Value : JsonSerializer.Serialize(certificate.SigningMetadata);
        command.Parameters.AddWithValue("issued_at", certificate.IssuedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task CompleteRequestAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        DurableMathEvaluationRequestRecord request,
        MathEvaluationResult result,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
update game_engine.math_evaluation_requests
set status = 'Completed',
    completed_at = @completed_at,
    failure_code = null,
    failure_reason = null,
    math_evaluation_id = @math_evaluation_id,
    certificate_id = @certificate_id,
    certificate_hash = @certificate_hash
where evaluation_request_id = @evaluation_request_id
  and canonical_request_hash = @canonical_request_hash;
""";
        command.Parameters.AddWithValue("completed_at", result.EvaluatedAt);
        command.Parameters.AddWithValue("math_evaluation_id", result.MathEvaluationId);
        command.Parameters.AddWithValue("certificate_id", result.Certificate.CertificateId);
        command.Parameters.AddWithValue("certificate_hash", result.CanonicalPrizeFactsHash);
        command.Parameters.AddWithValue("evaluation_request_id", request.EvaluationRequestId);
        command.Parameters.AddWithValue("canonical_request_hash", request.CanonicalRequestHash);
        var updated = await command.ExecuteNonQueryAsync(cancellationToken);
        if (updated != 1)
        {
            throw new InvalidOperationException("Math Evaluation request completion could not be persisted deterministically.");
        }
    }

    private async Task<MathEvaluationResult?> FindCompletedResultAsync(
        NpgsqlConnection connection,
        Guid evaluationRequestId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  request.evaluation_request_id,
  request.idempotency_key,
  request.evaluation_mode,
  request.evaluator_version,
  request.game_manifest_id,
  request.game_manifest_version,
  request.game_manifest_hash,
  event.math_evaluation_id,
  event.prize_facts::text,
  event.canonical_prize_facts_hash,
  event.evaluated_at,
  certificate.certificate_id,
  certificate.outcome_certificate_id,
  certificate.outcome_certificate_hash,
  certificate.math_model_id,
  certificate.math_model_version,
  certificate.math_model_hash,
  certificate.paytable_id,
  certificate.paytable_version,
  certificate.paytable_hash,
  certificate.ticket_reference,
  certificate.rtp_math_metadata_reference,
  certificate.issued_at
from game_engine.math_evaluation_requests request
join game_engine.math_evaluation_events event
  on event.math_evaluation_id = request.math_evaluation_id
join game_engine.math_evaluation_certificates certificate
  on certificate.certificate_id = request.certificate_id
where request.evaluation_request_id = @evaluation_request_id
  and request.status = 'Completed';
""";
        command.Parameters.AddWithValue("evaluation_request_id", evaluationRequestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return MapResult(reader);
    }

    private static MathEvaluationResult MapResult(NpgsqlDataReader reader)
    {
        var requestId = reader.GetGuid(0);
        var idempotencyKey = reader.GetString(1);
        var mode = Enum.Parse<MathEvaluationMode>(reader.GetString(2));
        var evaluatorVersion = reader.GetString(3);
        var manifestId = reader.GetString(4);
        var manifestVersion = reader.GetString(5);
        var manifestHash = reader.GetString(6);
        var mathEvaluationId = reader.GetGuid(7);
        var prizeFactsJson = reader.GetString(8);
        var prizeFacts = JsonSerializer.Deserialize<PrizeFacts>(prizeFactsJson)
            ?? throw new InvalidOperationException("Stored PrizeFacts could not be deserialized.");
        var prizeFactsHash = reader.GetString(9);
        var evaluatedAt = reader.GetFieldValue<DateTimeOffset>(10);
        var certificate = new MathEvaluationCertificate(
            reader.GetGuid(11),
            mathEvaluationId,
            reader.GetGuid(12),
            reader.GetString(13),
            reader.GetString(14),
            reader.GetString(15),
            reader.GetString(16),
            reader.GetString(17),
            reader.GetString(18),
            reader.GetString(19),
            reader.GetString(20),
            prizeFactsHash,
            reader.GetString(21),
            SigningMetadata: null,
            reader.GetFieldValue<DateTimeOffset>(22),
            evaluatorVersion,
            manifestId,
            manifestVersion,
            manifestHash);
        return new MathEvaluationResult(
            mathEvaluationId,
            requestId,
            idempotencyKey,
            mode,
            prizeFacts,
            MathEvaluationCanonicalizer.CanonicalizePrizeFacts(prizeFacts),
            prizeFactsHash,
            certificate,
            evaluatedAt);
    }

    private static void AddRequestParameters(NpgsqlCommand command, DurableMathEvaluationRequestRecord request)
    {
        command.Parameters.AddWithValue("evaluation_request_id", request.EvaluationRequestId);
        command.Parameters.AddWithValue("idempotency_key", request.IdempotencyKey);
        command.Parameters.AddWithValue("canonical_request_hash", request.CanonicalRequestHash);
        command.Parameters.AddWithValue("outcome_certificate_id", request.OutcomeCertificateId);
        command.Parameters.AddWithValue("outcome_certificate_hash", request.OutcomeCertificateHash);
        command.Parameters.AddWithValue("game_manifest_id", request.GameManifestId);
        command.Parameters.AddWithValue("game_manifest_version", request.GameManifestVersion);
        command.Parameters.AddWithValue("game_manifest_hash", request.GameManifestHash);
        command.Parameters.AddWithValue("math_model_id", request.MathModelId);
        command.Parameters.AddWithValue("math_model_version", request.MathModelVersion);
        command.Parameters.AddWithValue("math_model_hash", request.MathModelHash);
        command.Parameters.AddWithValue("paytable_id", request.PaytableId);
        command.Parameters.AddWithValue("paytable_version", request.PaytableVersion);
        command.Parameters.AddWithValue("paytable_hash", request.PaytableHash);
        command.Parameters.AddWithValue("ticket_reference", request.TicketReference);
        command.Parameters.AddWithValue("wager_schema", request.WagerSchema);
        command.Parameters.AddWithValue("evaluator_type", request.EvaluatorType);
        command.Parameters.AddWithValue("evaluator_version", request.EvaluatorVersion);
        command.Parameters.AddWithValue("evaluation_mode", request.Mode.ToString());
        command.Parameters.AddWithValue("status", request.Status.ToString());
        command.Parameters.AddWithValue("created_at", request.CreatedAt);
    }

    private static DurableMathEvaluationRequestRecord MapRequest(NpgsqlDataReader reader)
    {
        return new DurableMathEvaluationRequestRecord(
            reader.GetGuid(0),
            reader.GetString(1),
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
            reader.GetString(16),
            reader.GetString(17),
            Enum.Parse<MathEvaluationMode>(reader.GetString(18)),
            Enum.Parse<DurableMathEvaluationStatus>(reader.GetString(19)),
            reader.GetFieldValue<DateTimeOffset>(20),
            reader.IsDBNull(21) ? null : reader.GetFieldValue<DateTimeOffset>(21),
            reader.IsDBNull(22) ? null : reader.GetString(22),
            reader.IsDBNull(23) ? null : reader.GetString(23),
            reader.IsDBNull(24) ? null : reader.GetGuid(24),
            reader.IsDBNull(25) ? null : reader.GetGuid(25),
            reader.IsDBNull(26) ? null : reader.GetString(26));
    }

    private static string GameManifestReference(DurableMathEvaluationRequestRecord request)
    {
        return $"{request.GameManifestId}:{request.GameManifestVersion}:{request.GameManifestHash}";
    }

    private const string RequestSelectSql = """
select
  evaluation_request_id,
  idempotency_key,
  canonical_request_hash,
  outcome_certificate_id,
  outcome_certificate_hash,
  game_manifest_id,
  game_manifest_version,
  game_manifest_hash,
  math_model_id,
  math_model_version,
  math_model_hash,
  paytable_id,
  paytable_version,
  paytable_hash,
  ticket_reference,
  wager_schema,
  evaluator_type,
  evaluator_version,
  evaluation_mode,
  status,
  created_at,
  completed_at,
  failure_code,
  failure_reason,
  math_evaluation_id,
  certificate_id,
  certificate_hash
from game_engine.math_evaluation_requests
""";
}
