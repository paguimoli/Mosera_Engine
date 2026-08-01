using System.Text.Json;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresCanonicalOutcomeProviderRepository(string connectionString)
    : ICanonicalOutcomeProviderRepository
{
    public async Task<CanonicalOutcomeProviderRegistration?> ResolveRegistrationAsync(
        DrawExecutionManifest manifest,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  provider.provider_id,
  provider.provider_version,
  configuration.configuration_version,
  configuration.canonical_provider_category,
  configuration.configuration_hash,
  configuration.supported_capabilities,
  configuration.evidence_requirements,
  configuration.readiness_capabilities,
  case when activation.stage = 'PRODUCTION_ACTIVE' then 'ENABLED' else 'DISABLED' end,
  provider.production_eligible,
  configuration.production_ready,
  configuration.failure_mode = 'FAIL_CLOSED',
  coalesce(activation.effective_at, configuration.created_at)
from game_engine.outcome_provider_definitions provider
join game_engine.outcome_provider_configuration_versions configuration
  on configuration.provider_id = provider.provider_id
 and configuration.provider_version = provider.provider_version
left join lateral (
  select event.stage, event.created_at as effective_at
  from game_engine.game_engine_production_activation_events event
  where event.provider_id = configuration.provider_id
    and event.provider_version = configuration.provider_version
    and event.configuration_version = configuration.configuration_version
  order by event.created_at desc, event.activation_event_id desc
  limit 1
) activation on true
where provider.provider_id = @provider_id
  and provider.provider_version = @provider_version
  and configuration.configuration_version = @configuration_version
  and provider.canonical_provider_category = configuration.canonical_provider_category
limit 1;
""";
        command.Parameters.AddWithValue("provider_id", manifest.OutcomeProviderId);
        command.Parameters.AddWithValue("provider_version", manifest.OutcomeProviderVersion);
        command.Parameters.AddWithValue(
            "configuration_version",
            manifest.ProviderConfigurationVersion);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new CanonicalOutcomeProviderRegistration(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            ParseCategory(reader.GetString(3)),
            reader.GetString(4),
            ParseStringArray(reader.GetString(5)),
            ParseObject(reader.GetString(6)),
            ParseStringArray(reader.GetString(7)),
            ParseActivationState(reader.GetString(8)),
            reader.GetBoolean(9),
            reader.GetBoolean(10),
            reader.GetBoolean(11),
            reader.GetFieldValue<DateTimeOffset>(12));
    }

    public async Task<OutcomeProviderClaimResult> ClaimExecutionAsync(
        OutcomeProviderExecutionClaim claim,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var insert = connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
insert into game_engine.outcome_provider_executions (
  execution_id,
  execution_manifest_id,
  execution_version,
  supersedes_execution_id,
  provider_id,
  provider_version,
  configuration_version,
  idempotency_key,
  canonical_request_hash,
  claimed_at)
values (
  @execution_id,
  @execution_manifest_id,
  @execution_version,
  @supersedes_execution_id,
  @provider_id,
  @provider_version,
  @configuration_version,
  @idempotency_key,
  @canonical_request_hash,
  @claimed_at)
on conflict do nothing;
""";
            AddClaimParameters(insert, claim);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }

        var stored = await FindClaimAsync(
            connection,
            transaction,
            claim.ExecutionManifestId,
            claim.IdempotencyKey,
            cancellationToken)
            ?? throw new InvalidOperationException(
                "Outcome Provider execution claim could not be read back.");

        if (stored.ExecutionManifestId != claim.ExecutionManifestId ||
            !string.Equals(stored.ProviderId, claim.ProviderId, StringComparison.Ordinal) ||
            !string.Equals(stored.ProviderVersion, claim.ProviderVersion, StringComparison.Ordinal) ||
            !string.Equals(
                stored.ConfigurationVersion,
                claim.ConfigurationVersion,
                StringComparison.Ordinal) ||
            !string.Equals(stored.IdempotencyKey, claim.IdempotencyKey, StringComparison.Ordinal) ||
            !string.Equals(
                stored.CanonicalRequestHash,
                claim.CanonicalRequestHash,
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Conflicting payload for the same Outcome Provider execution manifest or idempotency key.");
        }

        await transaction.CommitAsync(cancellationToken);
        return new OutcomeProviderClaimResult(
            stored,
            Created: stored.ExecutionId == claim.ExecutionId,
            Duplicate: stored.ExecutionId != claim.ExecutionId);
    }

    public async Task<OutcomeProviderClaimResult> ClaimSupersedingExecutionAsync(
        OutcomeProviderExecutionClaim claim,
        Guid supersedesExecutionId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var lockCommand = connection.CreateCommand())
        {
            lockCommand.Transaction = transaction;
            lockCommand.CommandText =
                "select pg_advisory_xact_lock(hashtextextended(@scope, 0));";
            lockCommand.Parameters.AddWithValue(
                "scope",
                $"outcome-provider-supersession:{claim.ExecutionManifestId:N}");
            await lockCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        var previous = await FindClaimByExecutionIdAsync(
            connection,
            transaction,
            supersedesExecutionId,
            cancellationToken)
            ?? throw new InvalidOperationException(
                "Official result supersession references an unknown provider execution.");
        if (previous.ExecutionManifestId != claim.ExecutionManifestId ||
            previous.ProviderId != claim.ProviderId ||
            previous.ProviderVersion != claim.ProviderVersion ||
            previous.ConfigurationVersion != claim.ConfigurationVersion)
        {
            throw new InvalidOperationException(
                "Official result supersession must remain within the exact provider and Execution Manifest.");
        }

        var version = checked(previous.ExecutionVersion + 1);
        var versionedClaim = claim with
        {
            ExecutionVersion = version,
            SupersedesExecutionId = supersedesExecutionId
        };
        await using (var insert = connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
insert into game_engine.outcome_provider_executions (
  execution_id,
  execution_manifest_id,
  execution_version,
  supersedes_execution_id,
  provider_id,
  provider_version,
  configuration_version,
  idempotency_key,
  canonical_request_hash,
  claimed_at)
values (
  @execution_id,
  @execution_manifest_id,
  @execution_version,
  @supersedes_execution_id,
  @provider_id,
  @provider_version,
  @configuration_version,
  @idempotency_key,
  @canonical_request_hash,
  @claimed_at)
on conflict do nothing;
""";
            AddClaimParameters(insert, versionedClaim);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }

        var stored = await FindClaimByIdempotencyAsync(
            connection,
            transaction,
            claim.IdempotencyKey,
            cancellationToken)
            ?? throw new InvalidOperationException(
                "Superseding Outcome Provider execution claim could not be read back.");
        if (stored.ExecutionManifestId != claim.ExecutionManifestId ||
            stored.SupersedesExecutionId != supersedesExecutionId ||
            stored.CanonicalRequestHash != claim.CanonicalRequestHash)
        {
            throw new InvalidOperationException(
                "Conflicting payload for the same superseding Outcome Provider idempotency key.");
        }

        await transaction.CommitAsync(cancellationToken);
        return new OutcomeProviderClaimResult(
            stored,
            Created: stored.ExecutionId == claim.ExecutionId,
            Duplicate: stored.ExecutionId != claim.ExecutionId);
    }

    public async Task<int> GetNextAttemptNumberAsync(
        Guid executionId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select coalesce(max(attempt_number), 0) + 1
from game_engine.outcome_provider_execution_attempts
where execution_id = @execution_id;
""";
        command.Parameters.AddWithValue("execution_id", executionId);
        return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken));
    }

    public async Task AppendAttemptAsync(
        OutcomeProviderExecutionAttempt attempt,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await InsertAttemptAsync(
            connection,
            transaction: null,
            attempt,
            cancellationToken);
    }

    public async Task AppendEvidenceAsync(
        OutcomeProviderExecutionEvidence evidence,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await InsertEvidenceAsync(
            connection,
            transaction: null,
            evidence,
            cancellationToken);
    }

    public async Task CompleteExecutionAsync(
        OutcomeProviderExecutionAttempt attempt,
        OutcomeProviderExecutionEvidence evidence,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await InsertAttemptAsync(connection, transaction, attempt, cancellationToken);
        await InsertEvidenceAsync(connection, transaction, evidence, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<OutcomeProviderExecutionEvidence?> FindAuthoritativeEvidenceAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
{EvidenceSelect}
where evidence.execution_manifest_id = @execution_manifest_id
  and evidence.status = 'AUTHORITATIVE'
order by execution.execution_version desc
limit 1;
""";
        command.Parameters.AddWithValue("execution_manifest_id", executionManifestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapEvidence(reader) : null;
    }

    public async Task<OutcomeProviderExecutionEvidence?> FindGeneratedEvidenceAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
{EvidenceSelect}
where evidence.execution_manifest_id = @execution_manifest_id
  and evidence.status = 'GENERATED'
order by execution.execution_version desc
limit 1;
""";
        command.Parameters.AddWithValue("execution_manifest_id", executionManifestId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapEvidence(reader) : null;
    }

    public async Task<IReadOnlyCollection<OutcomeProviderExecutionClaim>> FindIncompleteExecutionsAsync(
        int limit,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  execution.execution_id,
  execution.execution_manifest_id,
  execution.execution_version,
  execution.supersedes_execution_id,
  execution.provider_id,
  execution.provider_version,
  execution.configuration_version,
  execution.idempotency_key,
  execution.canonical_request_hash,
  execution.claimed_at
from game_engine.outcome_provider_executions execution
left join game_engine.outcome_provider_execution_evidence evidence
  on evidence.execution_id = execution.execution_id
 and evidence.status = 'GENERATED'
where evidence.execution_id is null
order by execution.claimed_at, execution.execution_id
limit @limit;
""";
        command.Parameters.AddWithValue("limit", limit);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var claims = new List<OutcomeProviderExecutionClaim>();
        while (await reader.ReadAsync(cancellationToken))
        {
            claims.Add(MapClaim(reader));
        }

        return claims;
    }

    public async Task<CanonicalOutcomeProviderReadiness> CheckReadinessAsync(
        CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        var providerRegistered = false;
        var providerVersionResolved = false;
        var configurationVersionResolved = false;
        var providerEnabled = false;
        var providerProductionReady = false;
        var evidencePersistenceReady = false;
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('game_engine.outcome_provider_definitions') is not null,
  to_regclass('game_engine.outcome_provider_configuration_versions') is not null,
  to_regclass('game_engine.outcome_provider_activation_events') is not null,
  to_regclass('game_engine.outcome_provider_executions') is not null,
  to_regclass('game_engine.outcome_provider_execution_attempts') is not null,
  to_regclass('game_engine.outcome_provider_execution_evidence') is not null,
  to_regclass('game_engine.game_engine_production_activation_events') is not null,
  (
    select count(distinct canonical_provider_category) = 3
    from game_engine.outcome_provider_definitions
    where canonical_provider_category is not null
  ),
  exists (
    select 1
    from game_engine.outcome_provider_configuration_versions
  ),
  exists (
    select 1
    from platform_migrations.migration_history
    where migration_id = '100_add_game_engine_production_activation'
      and status = 'APPLIED'
  ),
  exists (
    select 1
    from game_engine.game_engine_production_activation_events
    where provider_id in (
        'mosera-internal-csprng',
        'mosera-official-results',
        'mosera-manual-certified'
      )
      and stage = 'PRODUCTION_ACTIVE'
  ),
  exists (
    select 1
    from game_engine.outcome_provider_configuration_versions configuration
    join game_engine.outcome_provider_definitions provider
     on provider.provider_id = configuration.provider_id
     and provider.provider_version = configuration.provider_version
    where provider.provider_id in (
        'mosera-internal-csprng',
        'mosera-official-results',
        'mosera-manual-certified'
      )
      and configuration.production_ready
      and provider.production_eligible
  );
""";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (await reader.ReadAsync(cancellationToken))
            {
                var tablesReady = Enumerable.Range(0, 7).All(reader.GetBoolean);
                providerRegistered = reader.GetBoolean(7);
                providerVersionResolved = providerRegistered;
                configurationVersionResolved = reader.GetBoolean(8);
                evidencePersistenceReady = tablesReady && reader.GetBoolean(9);
                providerEnabled = reader.GetBoolean(10);
                providerProductionReady = reader.GetBoolean(11);
                if (!tablesReady)
                {
                    blockers.Add("Canonical Outcome Provider persistence tables are incomplete.");
                }
                if (!providerRegistered)
                {
                    blockers.Add("All canonical Outcome Provider categories are not registered.");
                }
                if (!configurationVersionResolved)
                {
                    blockers.Add("Outcome Provider configuration versions are unavailable.");
                }
                if (!evidencePersistenceReady)
                {
                    blockers.Add("Outcome Provider evidence persistence is unavailable.");
                }
            }
            else
            {
                blockers.Add("Canonical Outcome Provider readiness query returned no result.");
            }
        }
        catch (Exception error) when (
            error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            blockers.Add(error.Message);
        }

        return new CanonicalOutcomeProviderReadiness(
            ProviderRegistryReady: blockers.Count == 0,
            ProviderRegistered: providerRegistered,
            ProviderVersionResolved: providerVersionResolved,
            ConfigurationVersionResolved: configurationVersionResolved,
            ProviderEnabled: providerEnabled,
            ProviderProductionReady: providerProductionReady,
            ProviderEvidencePersistenceReady: evidencePersistenceReady,
            ProductionActivationDisabled: !providerEnabled,
            Blockers: blockers);
    }

    public async Task<bool> IsProviderCategoryProductionReadyAsync(
        CanonicalOutcomeProviderCategory category,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select exists (
  select 1
  from game_engine.outcome_provider_configuration_versions configuration
  join game_engine.outcome_provider_definitions provider
    on provider.provider_id = configuration.provider_id
   and provider.provider_version = configuration.provider_version
  where configuration.canonical_provider_category = @category
    and configuration.production_ready
    and provider.production_eligible
    and provider.lifecycle_state = 'Active'
    and configuration.failure_mode = 'FAIL_CLOSED'
);
""";
        command.Parameters.AddWithValue("category", ToDatabaseCategory(category));
        return (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);
    }

    private static async Task InsertAttemptAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        OutcomeProviderExecutionAttempt attempt,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.outcome_provider_execution_attempts (
  attempt_id,
  execution_id,
  attempt_number,
  status,
  failure_classification,
  failure_code,
  failure_reason,
  request_hash,
  attempt_hash,
  started_at,
  completed_at)
values (
  @attempt_id,
  @execution_id,
  @attempt_number,
  @status,
  @failure_classification,
  @failure_code,
  @failure_reason,
  @request_hash,
  @attempt_hash,
  @started_at,
  @completed_at);
""";
        command.Parameters.AddWithValue("attempt_id", attempt.AttemptId);
        command.Parameters.AddWithValue("execution_id", attempt.ExecutionId);
        command.Parameters.AddWithValue("attempt_number", attempt.AttemptNumber);
        command.Parameters.AddWithValue("status", ToDatabaseStatus(attempt.Status));
        command.Parameters.AddWithValue(
            "failure_classification",
            ToDatabaseFailureClassification(attempt.FailureClassification));
        command.Parameters.AddWithValue(
            "failure_code",
            attempt.FailureCode is null ? DBNull.Value : attempt.FailureCode);
        command.Parameters.AddWithValue(
            "failure_reason",
            attempt.FailureReason is null ? DBNull.Value : attempt.FailureReason);
        command.Parameters.AddWithValue("request_hash", attempt.RequestHash);
        command.Parameters.AddWithValue("attempt_hash", attempt.AttemptHash);
        command.Parameters.AddWithValue("started_at", attempt.StartedAt);
        command.Parameters.AddWithValue(
            "completed_at",
            attempt.CompletedAt is null ? DBNull.Value : attempt.CompletedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task InsertEvidenceAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        OutcomeProviderExecutionEvidence evidence,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.outcome_provider_execution_evidence (
  evidence_id,
  execution_id,
  execution_manifest_id,
  draw_id,
  provider_id,
  provider_version,
  configuration_version,
  request_hash,
  result_hash,
  evidence_hash,
  outcome_certificate_id,
  outcome_certificate_hash,
  execution_attempt,
  idempotency_key,
  status,
  provider_evidence_payload,
  canonical_result_payload,
  canonical_result_hash,
  started_at,
  completed_at)
values (
  @evidence_id,
  @execution_id,
  @execution_manifest_id,
  @draw_id,
  @provider_id,
  @provider_version,
  @configuration_version,
  @request_hash,
  @result_hash,
  @evidence_hash,
  @outcome_certificate_id,
  @outcome_certificate_hash,
  @execution_attempt,
  @idempotency_key,
  @status,
  @provider_evidence_payload::jsonb,
  @canonical_result_payload::jsonb,
  @canonical_result_hash,
  @started_at,
  @completed_at);
""";
        command.Parameters.AddWithValue("evidence_id", evidence.EvidenceId);
        command.Parameters.AddWithValue("execution_id", evidence.ExecutionId);
        command.Parameters.AddWithValue(
            "execution_manifest_id",
            evidence.ExecutionManifestId);
        command.Parameters.AddWithValue("draw_id", evidence.DrawId);
        command.Parameters.AddWithValue("provider_id", evidence.ProviderId);
        command.Parameters.AddWithValue("provider_version", evidence.ProviderVersion);
        command.Parameters.AddWithValue(
            "configuration_version",
            evidence.ConfigurationVersion);
        command.Parameters.AddWithValue("request_hash", evidence.RequestHash);
        command.Parameters.AddWithValue("result_hash", evidence.ResultHash);
        command.Parameters.AddWithValue("evidence_hash", evidence.EvidenceHash);
        command.Parameters.AddWithValue(
            "outcome_certificate_id",
            evidence.OutcomeCertificateId is null
                ? DBNull.Value
                : evidence.OutcomeCertificateId.Value);
        command.Parameters.AddWithValue(
            "outcome_certificate_hash",
            evidence.OutcomeCertificateHash is null
                ? DBNull.Value
                : evidence.OutcomeCertificateHash);
        command.Parameters.AddWithValue("execution_attempt", evidence.ExecutionAttempt);
        command.Parameters.AddWithValue("idempotency_key", evidence.IdempotencyKey);
        command.Parameters.AddWithValue("status", ToDatabaseEvidenceStage(evidence.Stage));
        command.Parameters.AddWithValue(
            "provider_evidence_payload",
            evidence.ProviderEvidenceJson);
        command.Parameters.AddWithValue(
            "canonical_result_payload",
            evidence.CanonicalResultJson is null ? DBNull.Value : evidence.CanonicalResultJson);
        command.Parameters.AddWithValue(
            "canonical_result_hash",
            evidence.CanonicalResultHash is null ? DBNull.Value : evidence.CanonicalResultHash);
        command.Parameters.AddWithValue("started_at", evidence.StartedAt);
        command.Parameters.AddWithValue("completed_at", evidence.CompletedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static async Task<OutcomeProviderExecutionClaim?> FindClaimAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid executionManifestId,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select
  execution_id,
  execution_manifest_id,
  execution_version,
  supersedes_execution_id,
  provider_id,
  provider_version,
  configuration_version,
  idempotency_key,
  canonical_request_hash,
  claimed_at
from game_engine.outcome_provider_executions
where execution_manifest_id = @execution_manifest_id
   or idempotency_key = @idempotency_key
order by idempotency_key = @idempotency_key desc, execution_version desc
limit 1;
""";
        command.Parameters.AddWithValue("execution_manifest_id", executionManifestId);
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapClaim(reader) : null;
    }

    private static async Task<OutcomeProviderExecutionClaim?> FindClaimByExecutionIdAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        Guid executionId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
{ClaimSelect}
where execution_id = @execution_id;
""";
        command.Parameters.AddWithValue("execution_id", executionId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapClaim(reader) : null;
    }

    private static async Task<OutcomeProviderExecutionClaim?> FindClaimByIdempotencyAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
{ClaimSelect}
where idempotency_key = @idempotency_key;
""";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapClaim(reader) : null;
    }

    private static void AddClaimParameters(
        NpgsqlCommand command,
        OutcomeProviderExecutionClaim claim)
    {
        command.Parameters.AddWithValue("execution_id", claim.ExecutionId);
        command.Parameters.AddWithValue(
            "execution_manifest_id",
            claim.ExecutionManifestId);
        command.Parameters.AddWithValue("execution_version", claim.ExecutionVersion);
        command.Parameters.AddWithValue(
            "supersedes_execution_id",
            claim.SupersedesExecutionId is null
                ? DBNull.Value
                : claim.SupersedesExecutionId.Value);
        command.Parameters.AddWithValue("provider_id", claim.ProviderId);
        command.Parameters.AddWithValue("provider_version", claim.ProviderVersion);
        command.Parameters.AddWithValue(
            "configuration_version",
            claim.ConfigurationVersion);
        command.Parameters.AddWithValue("idempotency_key", claim.IdempotencyKey);
        command.Parameters.AddWithValue(
            "canonical_request_hash",
            claim.CanonicalRequestHash);
        command.Parameters.AddWithValue("claimed_at", claim.ClaimedAt);
    }

    private static OutcomeProviderExecutionClaim MapClaim(NpgsqlDataReader reader) =>
        new(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetInt32(2),
            reader.IsDBNull(3) ? null : reader.GetGuid(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetString(6),
            reader.GetString(7),
            reader.GetString(8),
            reader.GetFieldValue<DateTimeOffset>(9));

    private static OutcomeProviderExecutionEvidence MapEvidence(NpgsqlDataReader reader) =>
        new(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetGuid(2),
            reader.GetGuid(3),
            reader.GetString(4),
            reader.GetString(5),
            reader.GetString(6),
            reader.GetString(7),
            reader.GetString(8),
            reader.GetString(9),
            reader.IsDBNull(10) ? null : reader.GetGuid(10),
            reader.IsDBNull(11) ? null : reader.GetString(11),
            reader.GetInt32(12),
            reader.GetString(13),
            ParseEvidenceStage(reader.GetString(14)),
            reader.GetString(15),
            reader.GetFieldValue<DateTimeOffset>(18),
            reader.GetFieldValue<DateTimeOffset>(19),
            reader.IsDBNull(16) ? null : reader.GetString(16),
            reader.IsDBNull(17) ? null : reader.GetString(17));

    private static CanonicalOutcomeProviderCategory ParseCategory(string value) =>
        value switch
        {
            "INTERNAL_CSPRNG" => CanonicalOutcomeProviderCategory.InternalCsprng,
            "OFFICIAL_RESULTS" => CanonicalOutcomeProviderCategory.OfficialResults,
            "MANUAL_CERTIFIED" => CanonicalOutcomeProviderCategory.ManualCertified,
            _ => throw new InvalidOperationException(
                $"Unsupported canonical Outcome Provider category {value}.")
        };

    private static string ToDatabaseCategory(CanonicalOutcomeProviderCategory category) =>
        category switch
        {
            CanonicalOutcomeProviderCategory.InternalCsprng => "INTERNAL_CSPRNG",
            CanonicalOutcomeProviderCategory.OfficialResults => "OFFICIAL_RESULTS",
            CanonicalOutcomeProviderCategory.ManualCertified => "MANUAL_CERTIFIED",
            _ => throw new ArgumentOutOfRangeException(nameof(category), category, null)
        };

    private static OutcomeProviderActivationState ParseActivationState(string value) =>
        value switch
        {
            "DISABLED" => OutcomeProviderActivationState.Disabled,
            "ENABLED" => OutcomeProviderActivationState.Enabled,
            "SUSPENDED" => OutcomeProviderActivationState.Suspended,
            _ => throw new InvalidOperationException(
                $"Unsupported Outcome Provider activation state {value}.")
        };

    private static IReadOnlyCollection<string> ParseStringArray(string json) =>
        JsonSerializer.Deserialize<string[]>(json) ?? [];

    private static IReadOnlyDictionary<string, object?> ParseObject(string json) =>
        JsonSerializer.Deserialize<Dictionary<string, object?>>(json) ??
        new Dictionary<string, object?>();

    private static string ToDatabaseStatus(OutcomeProviderExecutionStatus status) =>
        status switch
        {
            OutcomeProviderExecutionStatus.Claimed => "CLAIMED",
            OutcomeProviderExecutionStatus.RetryableFailure => "RETRYABLE_FAILURE",
            OutcomeProviderExecutionStatus.NonRetryableFailure => "NON_RETRYABLE_FAILURE",
            OutcomeProviderExecutionStatus.Completed => "COMPLETED",
            _ => throw new ArgumentOutOfRangeException(nameof(status), status, null)
        };

    private static string ToDatabaseFailureClassification(
        OutcomeProviderFailureClassification classification) =>
        classification switch
        {
            OutcomeProviderFailureClassification.None => "NONE",
            OutcomeProviderFailureClassification.Retryable => "RETRYABLE",
            OutcomeProviderFailureClassification.NonRetryable => "NON_RETRYABLE",
            _ => throw new ArgumentOutOfRangeException(
                nameof(classification),
                classification,
                null)
        };

    private static string ToDatabaseEvidenceStage(OutcomeProviderEvidenceStage stage) =>
        stage switch
        {
            OutcomeProviderEvidenceStage.Generated => "GENERATED",
            OutcomeProviderEvidenceStage.Authoritative => "AUTHORITATIVE",
            _ => throw new ArgumentOutOfRangeException(nameof(stage), stage, null)
        };

    private static OutcomeProviderEvidenceStage ParseEvidenceStage(string value) =>
        value switch
        {
            "GENERATED" => OutcomeProviderEvidenceStage.Generated,
            "AUTHORITATIVE" => OutcomeProviderEvidenceStage.Authoritative,
            _ => throw new InvalidOperationException(
                $"Unsupported Outcome Provider evidence stage {value}.")
        };

    private const string EvidenceSelect = """
select
  evidence.evidence_id,
  evidence.execution_id,
  evidence.execution_manifest_id,
  evidence.draw_id,
  evidence.provider_id,
  evidence.provider_version,
  evidence.configuration_version,
  evidence.request_hash,
  evidence.result_hash,
  evidence.evidence_hash,
  evidence.outcome_certificate_id,
  evidence.outcome_certificate_hash,
  evidence.execution_attempt,
  evidence.idempotency_key,
  evidence.status,
  evidence.provider_evidence_payload::text,
  evidence.canonical_result_payload::text,
  evidence.canonical_result_hash,
  evidence.started_at,
  evidence.completed_at
from game_engine.outcome_provider_execution_evidence evidence
join game_engine.outcome_provider_executions execution
  on execution.execution_id = evidence.execution_id
""";

    private const string ClaimSelect = """
select
  execution_id,
  execution_manifest_id,
  execution_version,
  supersedes_execution_id,
  provider_id,
  provider_version,
  configuration_version,
  idempotency_key,
  canonical_request_hash,
  claimed_at
from game_engine.outcome_provider_executions
""";
}
