using System.Text.Json;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;
using NpgsqlTypes;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresPhysicalDrawAuthorityRepository(string connectionString) : IPhysicalDrawAuthorityRepository
{
    public async Task<PhysicalDrawAuthorityDefinition?> FindAuthorityAsync(
        string authorityId,
        string authorityVersion,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  id,
  authority_id,
  authority_version,
  authority_name,
  authority_type,
  country,
  jurisdiction,
  operator,
  facility,
  draw_machine_identifier,
  ball_set_identifier,
  approved_procedures_version,
  supported_game_identifiers,
  supported_result_schemas,
  witness_policy,
  timestamp_policy,
  production_eligible,
  lifecycle_state,
  failure_mode,
  content_hash,
  certification_binding
from game_engine.physical_draw_authorities
where authority_id = @authority_id
  and authority_version = @authority_version
order by created_at desc
limit 1;
""";
        command.Parameters.AddWithValue("authority_id", authorityId);
        command.Parameters.AddWithValue("authority_version", authorityVersion);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadAuthority(reader) : null;
    }

    public async Task<PhysicalDrawRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "select to_regclass('game_engine.physical_draw_authorities') is not null;";
            var exists = (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);
            if (!exists)
            {
                blockers.Add("game_engine.physical_draw_authorities is missing.");
            }
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            blockers.Add(error.Message);
        }

        return new PhysicalDrawRuntimeReadiness(
            AuthorityRepositoryReady: blockers.Count == 0,
            WitnessValidationReady: true,
            EquipmentValidationReady: true,
            SchemaNormalizationReady: true,
            EvidenceRepositoryReady: true,
            DurableIdempotencyReady: blockers.Count == 0,
            AdvisoryLockingReady: true,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: ["postgres-physical-draw-authorities"],
            Blockers: blockers);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static PhysicalDrawAuthorityDefinition ReadAuthority(NpgsqlDataReader reader)
    {
        var witness = JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(14)) ?? [];
        var timestamp = JsonSerializer.Deserialize<Dictionary<string, object?>>(reader.GetString(15)) ?? [];
        var maxDrawAgeSeconds = timestamp.TryGetValue("maxDrawAgeSeconds", out _) ? ReadNumber(timestamp, "maxDrawAgeSeconds", 0) : (long?)null;
        return new PhysicalDrawAuthorityDefinition(
            reader.GetGuid(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            FromAuthorityType(reader.GetString(4)),
            reader.GetString(5),
            reader.IsDBNull(6) ? null : reader.GetString(6),
            reader.GetString(7),
            reader.GetString(8),
            reader.GetString(9),
            reader.GetString(10),
            reader.GetString(11),
            DeserializeStringArray(reader.GetString(12)),
            DeserializeSchemaArray(reader.GetString(13)),
            new PhysicalDrawWitnessPolicy(
                ReadBool(witness, "operatorRequired", true),
                ReadBool(witness, "primaryWitnessRequired", true),
                ReadBool(witness, "secondaryWitnessRequired", false),
                ReadBool(witness, "regulatorWitnessRequired", false),
                (int)ReadNumber(witness, "minimumWitnessCount", 2)),
            new PhysicalDrawTimestampPolicy(
                TimeSpan.FromSeconds(ReadNumber(timestamp, "maxClockSkewSeconds", 300)),
                maxDrawAgeSeconds is null ? null : TimeSpan.FromSeconds(maxDrawAgeSeconds.Value),
                ReadBool(timestamp, "futureTimestampsRejected", true)),
            reader.GetBoolean(16),
            FromLifecycle(reader.GetString(17)),
            FromFailureMode(reader.GetString(18)),
            reader.GetString(19),
            reader.IsDBNull(20) ? null : reader.GetString(20));
    }

    private static string[] DeserializeStringArray(string json)
    {
        return JsonSerializer.Deserialize<string[]>(json) ?? [];
    }

    private static PhysicalDrawResultSchemaType[] DeserializeSchemaArray(string json)
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

    private static PhysicalDrawAuthorityType FromAuthorityType(string value) => value switch
    {
        "GOVERNMENT_LOTTERY" => PhysicalDrawAuthorityType.GovernmentLottery,
        "REGULATOR" => PhysicalDrawAuthorityType.Regulator,
        "LICENSED_OPERATOR" => PhysicalDrawAuthorityType.LicensedOperator,
        "INDEPENDENT_SUPERVISOR" => PhysicalDrawAuthorityType.IndependentSupervisor,
        _ => Enum.Parse<PhysicalDrawAuthorityType>(value, ignoreCase: true)
    };

    private static PhysicalDrawAuthorityLifecycleState FromLifecycle(string value) => value switch
    {
        "Draft" => PhysicalDrawAuthorityLifecycleState.Draft,
        "Active" => PhysicalDrawAuthorityLifecycleState.Active,
        "Suspended" => PhysicalDrawAuthorityLifecycleState.Suspended,
        "Retired" => PhysicalDrawAuthorityLifecycleState.Retired,
        "Superseded" => PhysicalDrawAuthorityLifecycleState.Superseded,
        "Revoked" => PhysicalDrawAuthorityLifecycleState.Revoked,
        _ => Enum.Parse<PhysicalDrawAuthorityLifecycleState>(value, ignoreCase: true)
    };

    private static PhysicalDrawFailureMode FromFailureMode(string value) => value switch
    {
        "FailClosed" => PhysicalDrawFailureMode.FailClosed,
        "Disabled" => PhysicalDrawFailureMode.Disabled,
        _ => Enum.Parse<PhysicalDrawFailureMode>(value, ignoreCase: true)
    };

    private static PhysicalDrawResultSchemaType FromSchemaType(string value) => value switch
    {
        "UNIQUE_NUMBER_SET" => PhysicalDrawResultSchemaType.UniqueNumberSet,
        "ORDERED_NUMBER_SEQUENCE" => PhysicalDrawResultSchemaType.OrderedNumberSequence,
        "BONUS_NUMBER_SET" => PhysicalDrawResultSchemaType.BonusNumberSet,
        "SUPPLEMENTARY_NUMBER_SET" => PhysicalDrawResultSchemaType.SupplementaryNumberSet,
        "COMPOSITE" => PhysicalDrawResultSchemaType.Composite,
        _ => Enum.Parse<PhysicalDrawResultSchemaType>(value, ignoreCase: true)
    };
}

public sealed class PostgresPhysicalDrawEvidenceRepository(string connectionString) : IPhysicalDrawEvidenceRepository
{
    public async Task<PhysicalDrawVerificationEvidence?> FindByAuthorityDrawAsync(
        string authorityId,
        string authorityVersion,
        string providerId,
        string providerVersion,
        string drawIdentifier,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  evidence_id,
  draw_event_id,
  authority_id,
  authority_version,
  provider_id,
  provider_version,
  draw_identifier,
  verification_status,
  custody_state,
  canonical_result_hash,
  event_content_hash,
  failure_code,
  failure_reason,
  evidence_hash,
  verified_at
from game_engine.physical_draw_evidence
where authority_id = @authority_id
  and authority_version = @authority_version
  and provider_id = @provider_id
  and provider_version = @provider_version
  and draw_identifier = @draw_identifier
  and verification_status = 'Verified'
order by verified_at desc
limit 1;
""";
        command.Parameters.AddWithValue("authority_id", authorityId);
        command.Parameters.AddWithValue("authority_version", authorityVersion);
        command.Parameters.AddWithValue("provider_id", providerId);
        command.Parameters.AddWithValue("provider_version", providerVersion);
        command.Parameters.AddWithValue("draw_identifier", drawIdentifier);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadEvidence(reader) : null;
    }

    public async Task AppendDrawEventAsync(
        PhysicalDrawResultEnvelope envelope,
        PhysicalDrawNormalizedPayload normalizedPayload,
        PhysicalDrawVerificationEvidence evidence,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
insert into game_engine.physical_draw_events (
  draw_event_id, idempotency_key, draw_identifier, provider_id, provider_version,
  authority_id, authority_version, manifest_id, manifest_version, game_identifier,
  draw_timestamp, scheduled_timestamp, received_timestamp, schema_type,
  normalized_payload, canonical_result_hash, winning_numbers, bonus_numbers,
  alternate_balls, equipment_references, machine_id, ball_set_id, draw_operator,
  witness_references, media_references, video_hash, image_hash,
  official_report_reference, procedural_evidence_hash, custody_state, content_hash
) values (
  @draw_event_id, @idempotency_key, @draw_identifier, @provider_id, @provider_version,
  @authority_id, @authority_version, @manifest_id, @manifest_version, @game_identifier,
  @draw_timestamp, @scheduled_timestamp, @received_timestamp, @schema_type,
  @normalized_payload, @canonical_result_hash, @winning_numbers, @bonus_numbers,
  @alternate_balls, @equipment_references, @machine_id, @ball_set_id, @draw_operator,
  @witness_references, @media_references, @video_hash, @image_hash,
  @official_report_reference, @procedural_evidence_hash, 'Certified', @content_hash
);
""";
            AddEventParameters(command, envelope, normalizedPayload);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = InsertEvidenceSql;
            AddEvidenceParameters(command, evidence);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
    }

    public async Task AppendVerificationEvidenceAsync(
        PhysicalDrawVerificationEvidence evidence,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = InsertEvidenceSql;
        AddEvidenceParameters(command, evidence);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<PhysicalDrawRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            foreach (var table in new[]
            {
                "game_engine.physical_draw_events",
                "game_engine.physical_draw_witnesses",
                "game_engine.physical_draw_equipment",
                "game_engine.physical_draw_evidence"
            })
            {
                await using var command = connection.CreateCommand();
                command.CommandText = "select to_regclass(@table_name) is not null;";
                command.Parameters.AddWithValue("table_name", table);
                var exists = (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);
                if (!exists)
                {
                    blockers.Add($"{table} is missing.");
                }
            }
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            blockers.Add(error.Message);
        }

        return new PhysicalDrawRuntimeReadiness(
            AuthorityRepositoryReady: true,
            WitnessValidationReady: true,
            EquipmentValidationReady: true,
            SchemaNormalizationReady: true,
            EvidenceRepositoryReady: blockers.Count == 0,
            DurableIdempotencyReady: blockers.Count == 0,
            AdvisoryLockingReady: true,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: ["postgres-physical-draw-evidence"],
            Blockers: blockers);
    }

    private const string InsertEvidenceSql = """
insert into game_engine.physical_draw_evidence (
  evidence_id, draw_event_id, authority_id, authority_version, provider_id, provider_version,
  draw_identifier, verification_status, custody_state, canonical_result_hash,
  event_content_hash, failure_code, failure_reason, evidence_hash, verified_at
) values (
  @evidence_id, @draw_event_id, @authority_id, @authority_version, @provider_id, @provider_version,
  @draw_identifier, @verification_status, @custody_state, @canonical_result_hash,
  @event_content_hash, @failure_code, @failure_reason, @evidence_hash, @verified_at
);
""";

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static void AddEventParameters(
        NpgsqlCommand command,
        PhysicalDrawResultEnvelope envelope,
        PhysicalDrawNormalizedPayload normalizedPayload)
    {
        command.Parameters.AddWithValue("draw_event_id", envelope.DrawEventId);
        command.Parameters.AddWithValue("idempotency_key", envelope.IdempotencyKey);
        command.Parameters.AddWithValue("draw_identifier", envelope.DrawIdentifier);
        command.Parameters.AddWithValue("provider_id", envelope.ProviderId);
        command.Parameters.AddWithValue("provider_version", envelope.ProviderVersion);
        command.Parameters.AddWithValue("authority_id", envelope.AuthorityId);
        command.Parameters.AddWithValue("authority_version", envelope.AuthorityVersion);
        command.Parameters.AddWithValue("manifest_id", envelope.ManifestId);
        command.Parameters.AddWithValue("manifest_version", envelope.ManifestVersion);
        command.Parameters.AddWithValue("game_identifier", envelope.GameIdentifier);
        command.Parameters.AddWithValue("draw_timestamp", envelope.DrawTimestamp);
        command.Parameters.AddWithValue("scheduled_timestamp", envelope.ScheduledTimestamp);
        command.Parameters.AddWithValue("received_timestamp", envelope.ReceivedTimestamp);
        command.Parameters.AddWithValue("schema_type", ToSchemaType(envelope.SchemaType));
        command.Parameters.AddWithValue("normalized_payload", NpgsqlDbType.Jsonb, normalizedPayload.CanonicalPayload);
        command.Parameters.AddWithValue("canonical_result_hash", normalizedPayload.CanonicalPayloadHash);
        command.Parameters.AddWithValue("winning_numbers", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(ReadPayloadValue(normalizedPayload.Payload, "numbers")));
        command.Parameters.AddWithValue("bonus_numbers", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(ReadPayloadValue(normalizedPayload.Payload, "bonusNumbers")));
        command.Parameters.AddWithValue("alternate_balls", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(ReadPayloadValue(normalizedPayload.Payload, "supplementaryNumbers")));
        command.Parameters.AddWithValue("equipment_references", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(envelope.EquipmentReferences));
        command.Parameters.AddWithValue("machine_id", envelope.MachineId);
        command.Parameters.AddWithValue("ball_set_id", envelope.BallSetId);
        command.Parameters.AddWithValue("draw_operator", envelope.DrawOperator);
        command.Parameters.AddWithValue("witness_references", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(envelope.WitnessEvidence));
        command.Parameters.AddWithValue("media_references", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(envelope.MediaReferences));
        command.Parameters.AddWithValue("video_hash", (object?)envelope.VideoHash ?? DBNull.Value);
        command.Parameters.AddWithValue("image_hash", (object?)envelope.ImageHash ?? DBNull.Value);
        command.Parameters.AddWithValue("official_report_reference", envelope.OfficialReportReference);
        command.Parameters.AddWithValue("procedural_evidence_hash", envelope.ProceduralEvidenceHash);
        command.Parameters.AddWithValue("content_hash", envelope.ContentHash);
    }

    private static object? ReadPayloadValue(IReadOnlyDictionary<string, object?> payload, string key)
    {
        return payload.TryGetValue(key, out var value) ? value : Array.Empty<int>();
    }

    private static void AddEvidenceParameters(NpgsqlCommand command, PhysicalDrawVerificationEvidence evidence)
    {
        command.Parameters.AddWithValue("evidence_id", evidence.EvidenceId);
        command.Parameters.AddWithValue("draw_event_id", evidence.DrawEventId);
        command.Parameters.AddWithValue("authority_id", evidence.AuthorityId);
        command.Parameters.AddWithValue("authority_version", evidence.AuthorityVersion);
        command.Parameters.AddWithValue("provider_id", evidence.ProviderId);
        command.Parameters.AddWithValue("provider_version", evidence.ProviderVersion);
        command.Parameters.AddWithValue("draw_identifier", evidence.DrawIdentifier);
        command.Parameters.AddWithValue("verification_status", ToStatus(evidence.Status));
        command.Parameters.AddWithValue("custody_state", evidence.CustodyState.ToString());
        command.Parameters.AddWithValue("canonical_result_hash", evidence.CanonicalResultHash);
        command.Parameters.AddWithValue("event_content_hash", evidence.EventContentHash);
        command.Parameters.AddWithValue("failure_code", (object?)evidence.FailureCode ?? DBNull.Value);
        command.Parameters.AddWithValue("failure_reason", (object?)evidence.FailureReason ?? DBNull.Value);
        command.Parameters.AddWithValue("evidence_hash", evidence.EvidenceHash);
        command.Parameters.AddWithValue("verified_at", evidence.VerifiedAt);
    }

    private static PhysicalDrawVerificationEvidence ReadEvidence(NpgsqlDataReader reader)
    {
        return new PhysicalDrawVerificationEvidence(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetString(2),
            reader.GetString(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetString(6),
            FromStatus(reader.GetString(7)),
            FromCustody(reader.GetString(8)),
            reader.GetString(9),
            reader.GetString(10),
            reader.IsDBNull(11) ? null : reader.GetString(11),
            reader.IsDBNull(12) ? null : reader.GetString(12),
            reader.GetString(13),
            reader.GetFieldValue<DateTimeOffset>(14));
    }

    private static string ToSchemaType(PhysicalDrawResultSchemaType value) => value switch
    {
        PhysicalDrawResultSchemaType.UniqueNumberSet => "UNIQUE_NUMBER_SET",
        PhysicalDrawResultSchemaType.OrderedNumberSequence => "ORDERED_NUMBER_SEQUENCE",
        PhysicalDrawResultSchemaType.BonusNumberSet => "BONUS_NUMBER_SET",
        PhysicalDrawResultSchemaType.SupplementaryNumberSet => "SUPPLEMENTARY_NUMBER_SET",
        PhysicalDrawResultSchemaType.Composite => "COMPOSITE",
        _ => value.ToString()
    };

    private static string ToStatus(PhysicalDrawVerificationStatus value) => value switch
    {
        PhysicalDrawVerificationStatus.SupersessionRequired => "SupersessionRequired",
        _ => value.ToString()
    };

    private static PhysicalDrawVerificationStatus FromStatus(string value) => value switch
    {
        "Pending" => PhysicalDrawVerificationStatus.Pending,
        "Verified" => PhysicalDrawVerificationStatus.Verified,
        "Rejected" => PhysicalDrawVerificationStatus.Rejected,
        "Conflict" => PhysicalDrawVerificationStatus.Conflict,
        "SupersessionRequired" => PhysicalDrawVerificationStatus.SupersessionRequired,
        _ => Enum.Parse<PhysicalDrawVerificationStatus>(value, ignoreCase: true)
    };

    private static PhysicalDrawCustodyState FromCustody(string value) => value switch
    {
        "Received" => PhysicalDrawCustodyState.Received,
        "WitnessVerified" => PhysicalDrawCustodyState.WitnessVerified,
        "EquipmentVerified" => PhysicalDrawCustodyState.EquipmentVerified,
        "AuthorityVerified" => PhysicalDrawCustodyState.AuthorityVerified,
        "Normalized" => PhysicalDrawCustodyState.Normalized,
        "Certified" => PhysicalDrawCustodyState.Certified,
        "Disputed" => PhysicalDrawCustodyState.Disputed,
        "Superseded" => PhysicalDrawCustodyState.Superseded,
        "Rejected" => PhysicalDrawCustodyState.Rejected,
        _ => Enum.Parse<PhysicalDrawCustodyState>(value, ignoreCase: true)
    };
}
