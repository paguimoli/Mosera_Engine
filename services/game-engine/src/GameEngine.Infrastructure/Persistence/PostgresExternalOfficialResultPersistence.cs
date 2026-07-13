using System.Text.Json;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;
using NpgsqlTypes;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresExternalResultSourceRepository(string connectionString) : IExternalResultSourceRepository
{
    public async Task<ExternalResultSourceDefinition?> FindSourceAsync(
        string sourceId,
        string sourceVersion,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  id,
  source_id,
  source_version,
  source_name,
  source_type,
  endpoint_reference_metadata,
  authentication_method,
  signature_requirement,
  transport_security_requirement,
  supported_game_identifiers,
  supported_result_schemas,
  source_timezone,
  publication_delay_policy,
  replay_retrieval_capability,
  production_eligible,
  lifecycle_state,
  failure_mode,
  content_hash,
  certification_binding,
  verification_key_id,
  verification_algorithm_version,
  verification_key_revoked_at,
  supersedes_source_version
from game_engine.external_result_source_definitions
where source_id = @source_id
  and source_version = @source_version
order by created_at desc
limit 1;
""";
        command.Parameters.AddWithValue("source_id", sourceId);
        command.Parameters.AddWithValue("source_version", sourceVersion);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadSource(reader) : null;
    }

    public async Task<ExternalResultRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "select to_regclass('game_engine.external_result_source_definitions') is not null;";
            var exists = (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);
            if (!exists)
            {
                blockers.Add("game_engine.external_result_source_definitions is missing.");
            }
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            blockers.Add(error.Message);
        }

        return new ExternalResultRuntimeReadiness(
            SourceRepositoryReady: blockers.Count == 0,
            SignatureVerificationReady: true,
            SchemaNormalizationReady: true,
            IngestionEvidenceRepositoryReady: true,
            DurableIdempotencyReady: blockers.Count == 0,
            AdvisoryLockingReady: true,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: ["postgres-external-source-definitions"],
            Blockers: blockers);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static ExternalResultSourceDefinition ReadSource(NpgsqlDataReader reader)
    {
        var policy = JsonSerializer.Deserialize<Dictionary<string, object?>>(
            reader.GetString(12)) ?? [];
        var maxClockSkewSeconds = ReadNumber(policy, "maxClockSkewSeconds", 300);
        var maxAgeSeconds = policy.TryGetValue("maxResultAgeSeconds", out var maxAge)
            ? ReadNumber(policy, "maxResultAgeSeconds", 0)
            : (long?)null;
        var futureRejected = ReadBool(policy, "futureTimestampsRejected", fallback: true);

        return new ExternalResultSourceDefinition(
            reader.GetGuid(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            FromSourceType(reader.GetString(4)),
            DeserializeObject(reader.GetString(5)),
            FromAuthenticationMethod(reader.GetString(6)),
            FromSignatureRequirement(reader.GetString(7)),
            FromTransportSecurity(reader.GetString(8)),
            DeserializeStringArray(reader.GetString(9)),
            DeserializeSchemaArray(reader.GetString(10)),
            reader.GetString(11),
            new ExternalResultPublicationDelayPolicy(
                TimeSpan.FromSeconds(maxClockSkewSeconds),
                maxAgeSeconds is null ? null : TimeSpan.FromSeconds(maxAgeSeconds.Value),
                futureRejected),
            reader.GetBoolean(13),
            reader.GetBoolean(14),
            FromLifecycle(reader.GetString(15)),
            FromFailureMode(reader.GetString(16)),
            reader.GetString(17),
            reader.IsDBNull(18) ? null : reader.GetString(18),
            reader.IsDBNull(19) ? null : reader.GetString(19),
            reader.IsDBNull(20) ? null : reader.GetString(20),
            reader.IsDBNull(21) ? null : reader.GetFieldValue<DateTimeOffset>(21),
            reader.IsDBNull(22) ? null : reader.GetString(22));
    }

    private static Dictionary<string, object?> DeserializeObject(string json)
    {
        return JsonSerializer.Deserialize<Dictionary<string, object?>>(json) ?? [];
    }

    private static string[] DeserializeStringArray(string json)
    {
        return JsonSerializer.Deserialize<string[]>(json) ?? [];
    }

    private static ExternalResultSchemaType[] DeserializeSchemaArray(string json)
    {
        var values = JsonSerializer.Deserialize<string[]>(json) ?? [];
        return values.Select(FromSchemaType).ToArray();
    }

    private static long ReadNumber(IReadOnlyDictionary<string, object?> payload, string key, long fallback)
    {
        if (!payload.TryGetValue(key, out var value) || value is null)
        {
            return fallback;
        }

        return value switch
        {
            JsonElement { ValueKind: JsonValueKind.Number } element => element.GetInt64(),
            long number => number,
            int number => number,
            _ => Convert.ToInt64(value)
        };
    }

    private static bool ReadBool(IReadOnlyDictionary<string, object?> payload, string key, bool fallback)
    {
        if (!payload.TryGetValue(key, out var value) || value is null)
        {
            return fallback;
        }

        return value switch
        {
            JsonElement { ValueKind: JsonValueKind.True } => true,
            JsonElement { ValueKind: JsonValueKind.False } => false,
            bool boolean => boolean,
            string text => bool.Parse(text),
            _ => Convert.ToBoolean(value)
        };
    }

    private static ExternalResultSourceType FromSourceType(string value) => value switch
    {
        "OFFICIAL_API" => ExternalResultSourceType.OfficialApi,
        "SIGNED_FILE_FEED" => ExternalResultSourceType.SignedFileFeed,
        "APPROVED_OPERATOR_FEED" => ExternalResultSourceType.ApprovedOperatorFeed,
        "MANUAL_REGULATOR_IMPORT" => ExternalResultSourceType.ManualRegulatorImport,
        _ => Enum.Parse<ExternalResultSourceType>(value, ignoreCase: true)
    };

    private static ExternalResultAuthenticationMethod FromAuthenticationMethod(string value) => value switch
    {
        "NONE" => ExternalResultAuthenticationMethod.None,
        "API_KEY_REFERENCE" => ExternalResultAuthenticationMethod.ApiKeyReference,
        "MUTUAL_TLS" => ExternalResultAuthenticationMethod.MutualTls,
        "SIGNED_PAYLOAD" => ExternalResultAuthenticationMethod.SignedPayload,
        "DETACHED_SIGNATURE" => ExternalResultAuthenticationMethod.DetachedSignature,
        "OPERATOR_ATTESTATION" => ExternalResultAuthenticationMethod.OperatorAttestation,
        _ => Enum.Parse<ExternalResultAuthenticationMethod>(value, ignoreCase: true)
    };

    private static ExternalResultSignatureRequirement FromSignatureRequirement(string value) => value switch
    {
        "NOT_REQUIRED" => ExternalResultSignatureRequirement.NotRequired,
        "DETACHED_REQUIRED" => ExternalResultSignatureRequirement.DetachedRequired,
        "SIGNED_ENVELOPE_REQUIRED" => ExternalResultSignatureRequirement.SignedEnvelopeRequired,
        _ => Enum.Parse<ExternalResultSignatureRequirement>(value, ignoreCase: true)
    };

    private static ExternalResultTransportSecurityRequirement FromTransportSecurity(string value) => value switch
    {
        "HTTPS_REQUIRED" => ExternalResultTransportSecurityRequirement.HttpsRequired,
        "MUTUAL_TLS_REQUIRED" => ExternalResultTransportSecurityRequirement.MutualTlsRequired,
        "OFFLINE_SIGNED_FILE" => ExternalResultTransportSecurityRequirement.OfflineSignedFile,
        _ => Enum.Parse<ExternalResultTransportSecurityRequirement>(value, ignoreCase: true)
    };

    private static ExternalResultSourceLifecycleState FromLifecycle(string value) => value switch
    {
        "Draft" => ExternalResultSourceLifecycleState.Draft,
        "Active" => ExternalResultSourceLifecycleState.Active,
        "Suspended" => ExternalResultSourceLifecycleState.Suspended,
        "Retired" => ExternalResultSourceLifecycleState.Retired,
        "Superseded" => ExternalResultSourceLifecycleState.Superseded,
        "Revoked" => ExternalResultSourceLifecycleState.Revoked,
        _ => Enum.Parse<ExternalResultSourceLifecycleState>(value, ignoreCase: true)
    };

    private static ExternalResultFailureMode FromFailureMode(string value) => value switch
    {
        "FailClosed" => ExternalResultFailureMode.FailClosed,
        "Disabled" => ExternalResultFailureMode.Disabled,
        _ => Enum.Parse<ExternalResultFailureMode>(value, ignoreCase: true)
    };

    private static ExternalResultSchemaType FromSchemaType(string value) => value switch
    {
        "UNIQUE_NUMBER_SET" => ExternalResultSchemaType.UniqueNumberSet,
        "ORDERED_NUMBER_SEQUENCE" => ExternalResultSchemaType.OrderedNumberSequence,
        "BONUS_NUMBER_SET" => ExternalResultSchemaType.BonusNumberSet,
        "SYMBOL_SEQUENCE" => ExternalResultSchemaType.SymbolSequence,
        "COMPOSITE" => ExternalResultSchemaType.Composite,
        _ => Enum.Parse<ExternalResultSchemaType>(value, ignoreCase: true)
    };
}

public sealed class PostgresExternalResultEvidenceRepository(string connectionString) : IExternalResultEvidenceRepository
{
    public async Task<ExternalResultVerificationEvidence?> FindBySourceDrawAsync(
        string sourceId,
        string sourceVersion,
        string providerId,
        string providerVersion,
        string externalDrawId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  evidence_id,
  ingestion_request_id,
  source_id,
  source_version,
  provider_id,
  provider_version,
  external_draw_id,
  verification_status,
  custody_state,
  canonical_result_hash,
  source_payload_hash,
  failure_code,
  failure_reason,
  evidence_hash,
  verified_at
from game_engine.external_result_verification_evidence
where source_id = @source_id
  and source_version = @source_version
  and provider_id = @provider_id
  and provider_version = @provider_version
  and external_draw_id = @external_draw_id
  and verification_status = 'Verified'
order by created_at desc
limit 1;
""";
        command.Parameters.AddWithValue("source_id", sourceId);
        command.Parameters.AddWithValue("source_version", sourceVersion);
        command.Parameters.AddWithValue("provider_id", providerId);
        command.Parameters.AddWithValue("provider_version", providerVersion);
        command.Parameters.AddWithValue("external_draw_id", externalDrawId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadEvidence(reader) : null;
    }

    public async Task AppendIngestionAsync(
        ExternalOfficialResultEnvelope envelope,
        ExternalResultNormalizedPayload normalizedPayload,
        ExternalResultVerificationEvidence evidence,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
insert into game_engine.external_result_ingestion_events (
  ingestion_request_id,
  idempotency_key,
  source_id,
  source_version,
  provider_id,
  provider_version,
  manifest_id,
  manifest_version,
  game_identifier,
  drawing_id,
  external_draw_id,
  publication_timestamp,
  source_timestamp,
  received_timestamp,
  source_payload_hash,
  source_signature_hash,
  signature_algorithm_version,
  schema_version,
  schema_type,
  normalized_payload,
  canonical_result_hash,
  transport_evidence_reference,
  source_metadata_reference,
  custody_state,
  content_hash
) values (
  @ingestion_request_id,
  @idempotency_key,
  @source_id,
  @source_version,
  @provider_id,
  @provider_version,
  @manifest_id,
  @manifest_version,
  @game_identifier,
  @drawing_id,
  @external_draw_id,
  @publication_timestamp,
  @source_timestamp,
  @received_timestamp,
  @source_payload_hash,
  @source_signature_hash,
  @signature_algorithm_version,
  @schema_version,
  @schema_type,
  @normalized_payload,
  @canonical_result_hash,
  @transport_evidence_reference,
  @source_metadata_reference,
  @custody_state,
  @content_hash
)
on conflict (source_id, source_version, provider_id, provider_version, external_draw_id, canonical_result_hash)
do nothing;
""";
            AddEnvelopeParameters(command, envelope, normalizedPayload, evidence);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await AppendVerificationEvidenceAsync(connection, transaction, evidence, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task AppendVerificationEvidenceAsync(
        ExternalResultVerificationEvidence evidence,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await AppendVerificationEvidenceAsync(connection, transaction, evidence, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<ExternalResultRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('game_engine.external_result_ingestion_events') is not null,
  to_regclass('game_engine.external_result_verification_evidence') is not null,
  to_regclass('game_engine.external_result_schema_mappings') is not null;
""";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            await reader.ReadAsync(cancellationToken);
            if (!reader.GetBoolean(0))
            {
                blockers.Add("game_engine.external_result_ingestion_events is missing.");
            }

            if (!reader.GetBoolean(1))
            {
                blockers.Add("game_engine.external_result_verification_evidence is missing.");
            }

            if (!reader.GetBoolean(2))
            {
                blockers.Add("game_engine.external_result_schema_mappings is missing.");
            }
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            blockers.Add(error.Message);
        }

        return new ExternalResultRuntimeReadiness(
            SourceRepositoryReady: true,
            SignatureVerificationReady: true,
            SchemaNormalizationReady: true,
            IngestionEvidenceRepositoryReady: blockers.Count == 0,
            DurableIdempotencyReady: blockers.Count == 0,
            AdvisoryLockingReady: true,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: ["postgres-external-result-evidence"],
            Blockers: blockers);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static async Task AppendVerificationEvidenceAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        ExternalResultVerificationEvidence evidence,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.external_result_verification_evidence (
  evidence_id,
  ingestion_request_id,
  source_id,
  source_version,
  provider_id,
  provider_version,
  external_draw_id,
  verification_status,
  custody_state,
  canonical_result_hash,
  source_payload_hash,
  failure_code,
  failure_reason,
  evidence_hash,
  verified_at
) values (
  @evidence_id,
  @ingestion_request_id,
  @source_id,
  @source_version,
  @provider_id,
  @provider_version,
  @external_draw_id,
  @verification_status,
  @custody_state,
  @canonical_result_hash,
  @source_payload_hash,
  @failure_code,
  @failure_reason,
  @evidence_hash,
  @verified_at
)
on conflict (evidence_hash) do nothing;
""";
        command.Parameters.AddWithValue("evidence_id", evidence.EvidenceId);
        command.Parameters.AddWithValue("ingestion_request_id", evidence.IngestionRequestId);
        command.Parameters.AddWithValue("source_id", evidence.SourceId);
        command.Parameters.AddWithValue("source_version", evidence.SourceVersion);
        command.Parameters.AddWithValue("provider_id", evidence.ProviderId);
        command.Parameters.AddWithValue("provider_version", evidence.ProviderVersion);
        command.Parameters.AddWithValue("external_draw_id", evidence.ExternalDrawId);
        command.Parameters.AddWithValue("verification_status", evidence.Status.ToString());
        command.Parameters.AddWithValue("custody_state", evidence.CustodyState.ToString());
        command.Parameters.AddWithValue("canonical_result_hash", evidence.CanonicalResultHash);
        command.Parameters.AddWithValue("source_payload_hash", evidence.SourcePayloadHash);
        command.Parameters.AddWithValue("failure_code", evidence.FailureCode is null ? DBNull.Value : evidence.FailureCode);
        command.Parameters.AddWithValue("failure_reason", evidence.FailureReason is null ? DBNull.Value : evidence.FailureReason);
        command.Parameters.AddWithValue("evidence_hash", evidence.EvidenceHash);
        command.Parameters.AddWithValue("verified_at", evidence.VerifiedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static void AddEnvelopeParameters(
        NpgsqlCommand command,
        ExternalOfficialResultEnvelope envelope,
        ExternalResultNormalizedPayload normalizedPayload,
        ExternalResultVerificationEvidence evidence)
    {
        command.Parameters.AddWithValue("ingestion_request_id", envelope.IngestionRequestId);
        command.Parameters.AddWithValue("idempotency_key", envelope.IdempotencyKey);
        command.Parameters.AddWithValue("source_id", envelope.SourceId);
        command.Parameters.AddWithValue("source_version", envelope.SourceVersion);
        command.Parameters.AddWithValue("provider_id", envelope.ProviderId);
        command.Parameters.AddWithValue("provider_version", envelope.ProviderVersion);
        command.Parameters.AddWithValue("manifest_id", envelope.ManifestId);
        command.Parameters.AddWithValue("manifest_version", envelope.ManifestVersion);
        command.Parameters.AddWithValue("game_identifier", envelope.GameIdentifier);
        command.Parameters.AddWithValue("drawing_id", envelope.DrawingId);
        command.Parameters.AddWithValue("external_draw_id", envelope.ExternalDrawId);
        command.Parameters.AddWithValue("publication_timestamp", envelope.PublicationTimestamp);
        command.Parameters.AddWithValue("source_timestamp", envelope.SourceTimestamp);
        command.Parameters.AddWithValue("received_timestamp", envelope.ReceivedTimestamp);
        command.Parameters.AddWithValue("source_payload_hash", envelope.SourcePayloadHash);
        command.Parameters.AddWithValue("source_signature_hash", envelope.SourceSignature is null ? DBNull.Value : ExternalOfficialResultRuntimeService.HashCanonical(envelope.SourceSignature));
        command.Parameters.AddWithValue("signature_algorithm_version", envelope.SignatureAlgorithmVersion);
        command.Parameters.AddWithValue("schema_version", envelope.SchemaVersion);
        command.Parameters.AddWithValue("schema_type", ToSchemaType(envelope.SchemaType));
        command.Parameters.Add("normalized_payload", NpgsqlDbType.Jsonb).Value = JsonSerializer.Serialize(normalizedPayload.Payload);
        command.Parameters.AddWithValue("canonical_result_hash", normalizedPayload.CanonicalPayloadHash);
        command.Parameters.AddWithValue("transport_evidence_reference", envelope.TransportEvidenceReference);
        command.Parameters.AddWithValue("source_metadata_reference", envelope.SourceMetadataReference);
        command.Parameters.AddWithValue("custody_state", evidence.CustodyState.ToString());
        command.Parameters.AddWithValue("content_hash", evidence.EvidenceHash);
    }

    private static ExternalResultVerificationEvidence ReadEvidence(NpgsqlDataReader reader)
    {
        return new ExternalResultVerificationEvidence(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetString(6),
            Enum.Parse<ExternalResultVerificationStatus>(reader.GetString(7), ignoreCase: true),
            Enum.Parse<ExternalResultCustodyState>(reader.GetString(8), ignoreCase: true),
            reader.GetString(9),
            reader.GetString(10),
            reader.IsDBNull(11) ? null : reader.GetString(11),
            reader.IsDBNull(12) ? null : reader.GetString(12),
            reader.GetString(13),
            reader.GetFieldValue<DateTimeOffset>(14));
    }

    private static string ToSchemaType(ExternalResultSchemaType schemaType)
    {
        return schemaType switch
        {
            ExternalResultSchemaType.UniqueNumberSet => "UNIQUE_NUMBER_SET",
            ExternalResultSchemaType.OrderedNumberSequence => "ORDERED_NUMBER_SEQUENCE",
            ExternalResultSchemaType.BonusNumberSet => "BONUS_NUMBER_SET",
            ExternalResultSchemaType.SymbolSequence => "SYMBOL_SEQUENCE",
            ExternalResultSchemaType.Composite => "COMPOSITE",
            _ => throw new ArgumentOutOfRangeException(nameof(schemaType), schemaType, "Unsupported external result schema type.")
        };
    }
}
