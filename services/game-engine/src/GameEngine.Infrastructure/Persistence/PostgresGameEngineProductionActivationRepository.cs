using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresGameEngineProductionActivationRepository(string connectionString)
    : IGameEngineProductionActivationRepository
{
    public async Task<GameEngineProductionActivationTarget?> ResolveTargetAsync(
        string providerId,
        string providerVersion,
        string configurationVersion,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select provider.provider_id, provider.provider_version, configuration.configuration_version,
  configuration.canonical_provider_category, provider.content_hash, configuration.configuration_hash,
  provider.production_eligible, configuration.production_ready,
  configuration.failure_mode = 'FAIL_CLOSED'
from game_engine.outcome_provider_definitions provider
join game_engine.outcome_provider_configuration_versions configuration
  on configuration.provider_id = provider.provider_id
 and configuration.provider_version = provider.provider_version
where provider.provider_id = @provider_id
  and provider.provider_version = @provider_version
  and configuration.configuration_version = @configuration_version
  and provider.lifecycle_state = 'Active';
""";
        command.Parameters.AddWithValue("provider_id", providerId);
        command.Parameters.AddWithValue("provider_version", providerVersion);
        command.Parameters.AddWithValue("configuration_version", configurationVersion);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new GameEngineProductionActivationTarget(
                reader.GetString(0), reader.GetString(1), reader.GetString(2),
                ParseCategory(reader.GetString(3)), reader.GetString(4), reader.GetString(5),
                reader.GetBoolean(6), reader.GetBoolean(7), reader.GetBoolean(8))
            : null;
    }

    public async Task<GameEngineProductionActivationEvent?> FindCurrentAsync(
        string providerId,
        string providerVersion,
        string configurationVersion,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
{EventSelect}
where provider_id = @provider_id
  and provider_version = @provider_version
  and configuration_version = @configuration_version
order by created_at desc, activation_event_id desc
limit 1;
""";
        command.Parameters.AddWithValue("provider_id", providerId);
        command.Parameters.AddWithValue("provider_version", providerVersion);
        command.Parameters.AddWithValue("configuration_version", configurationVersion);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapEvent(reader) : null;
    }

    public async Task<GameEngineProductionActivationEvent?> FindByIdempotencyAsync(
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
{EventSelect}
where idempotency_key = @idempotency_key;
""";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapEvent(reader) : null;
    }

    public async Task<GameEngineProductionActivationEvent> AppendAsync(
        GameEngineProductionActivationEvent activationEvent,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var lockCommand = connection.CreateCommand())
        {
            lockCommand.Transaction = transaction;
            lockCommand.CommandText = "select pg_advisory_xact_lock(hashtextextended(@scope, 0));";
            lockCommand.Parameters.AddWithValue(
                "scope",
                $"game-engine-production-activation:{activationEvent.ProviderId}:{activationEvent.ProviderVersion}:{activationEvent.ConfigurationVersion}");
            await lockCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var insert = connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
insert into game_engine.game_engine_production_activation_events (
  activation_event_id, provider_id, provider_version, configuration_version,
  stage, actor_reference, reason_code, approval_reference,
  signing_provider_id, signing_provider_version, signing_key_version,
  canonical_request_hash, evidence_hash, idempotency_key, created_at)
values (
  @activation_event_id, @provider_id, @provider_version, @configuration_version,
  @stage, @actor_reference, @reason_code, @approval_reference,
  @signing_provider_id, @signing_provider_version, @signing_key_version,
  @canonical_request_hash, @evidence_hash, @idempotency_key, @created_at)
on conflict (idempotency_key) do nothing;
""";
            AddEventParameters(insert, activationEvent);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }

        var persisted = await FindByIdempotencyAsync(
            connection,
            transaction,
            activationEvent.IdempotencyKey,
            cancellationToken)
            ?? throw new InvalidOperationException("Production activation evidence was not persisted.");
        if (!string.Equals(persisted.CanonicalRequestHash, activationEvent.CanonicalRequestHash, StringComparison.Ordinal))
            throw new InvalidOperationException("Conflicting production activation idempotency payload.");
        await transaction.CommitAsync(cancellationToken);
        return persisted;
    }

    public async Task<SigningProviderDefinition?> FindSigningProviderAsync(
        string providerId,
        string providerVersion,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select provider_id, provider_version, provider_type, production_eligible,
  algorithm, key_identifier, algorithm_version, verification_support,
  key_rotation_support, failure_mode, content_hash, lifecycle_state
from game_engine.signing_providers
where provider_id = @provider_id and provider_version = @provider_version;
""";
        command.Parameters.AddWithValue("provider_id", providerId);
        command.Parameters.AddWithValue("provider_version", providerVersion);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new SigningProviderDefinition(
                reader.GetString(0), reader.GetString(1), ParseSigningProviderType(reader.GetString(2)),
                reader.GetBoolean(3), reader.GetString(4), reader.GetString(5), reader.GetString(6),
                reader.GetBoolean(7), reader.GetBoolean(8), ParseFailureMode(reader.GetString(9)),
                reader.GetString(10), ParseLifecycle(reader.GetString(11)))
            : null;
    }

    public async Task<bool> CheckPersistenceReadinessAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = await OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('game_engine.game_engine_production_activation_events') is not null
  and exists (
    select 1 from platform_migrations.migration_history
    where migration_id = '100_add_game_engine_production_activation' and status = 'APPLIED'
  );
""";
            return (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);
        }
        catch (Exception exception) when (exception is NpgsqlException or TimeoutException)
        {
            return false;
        }
    }

    private async Task<NpgsqlConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static async Task<GameEngineProductionActivationEvent?> FindByIdempotencyAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
{EventSelect}
where idempotency_key = @idempotency_key;
""";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapEvent(reader) : null;
    }

    private static void AddEventParameters(NpgsqlCommand command, GameEngineProductionActivationEvent value)
    {
        command.Parameters.AddWithValue("activation_event_id", value.ActivationEventId);
        command.Parameters.AddWithValue("provider_id", value.ProviderId);
        command.Parameters.AddWithValue("provider_version", value.ProviderVersion);
        command.Parameters.AddWithValue("configuration_version", value.ConfigurationVersion);
        command.Parameters.AddWithValue("stage", ToDatabaseStage(value.Stage));
        command.Parameters.AddWithValue("actor_reference", value.ActorReference);
        command.Parameters.AddWithValue("reason_code", value.ReasonCode);
        command.Parameters.AddWithValue("approval_reference", value.ApprovalReference);
        command.Parameters.AddWithValue("signing_provider_id", value.SigningProviderId);
        command.Parameters.AddWithValue("signing_provider_version", value.SigningProviderVersion);
        command.Parameters.AddWithValue("signing_key_version", value.SigningKeyVersion);
        command.Parameters.AddWithValue("canonical_request_hash", value.CanonicalRequestHash);
        command.Parameters.AddWithValue("evidence_hash", value.EvidenceHash);
        command.Parameters.AddWithValue("idempotency_key", value.IdempotencyKey);
        command.Parameters.AddWithValue("created_at", value.CreatedAt);
    }

    private static GameEngineProductionActivationEvent MapEvent(NpgsqlDataReader reader) => new(
        reader.GetGuid(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
        ParseStage(reader.GetString(4)), reader.GetString(5), reader.GetString(6), reader.GetString(7),
        reader.GetString(8), reader.GetString(9), reader.GetString(10), reader.GetString(11),
        reader.GetString(12), reader.GetString(13), reader.GetFieldValue<DateTimeOffset>(14));

    private static CanonicalOutcomeProviderCategory ParseCategory(string value) => value switch
    {
        "INTERNAL_CSPRNG" => CanonicalOutcomeProviderCategory.InternalCsprng,
        "OFFICIAL_RESULTS" => CanonicalOutcomeProviderCategory.OfficialResults,
        "MANUAL_CERTIFIED" => CanonicalOutcomeProviderCategory.ManualCertified,
        _ => throw new InvalidOperationException($"Unknown provider category {value}.")
    };

    private static string ToDatabaseStage(GameEngineProductionActivationStage value) => value switch
    {
        GameEngineProductionActivationStage.Registered => "REGISTERED",
        GameEngineProductionActivationStage.Ready => "READY",
        GameEngineProductionActivationStage.Approved => "APPROVED",
        GameEngineProductionActivationStage.ProductionActive => "PRODUCTION_ACTIVE",
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, null)
    };

    private static GameEngineProductionActivationStage ParseStage(string value) => value switch
    {
        "REGISTERED" => GameEngineProductionActivationStage.Registered,
        "READY" => GameEngineProductionActivationStage.Ready,
        "APPROVED" => GameEngineProductionActivationStage.Approved,
        "PRODUCTION_ACTIVE" => GameEngineProductionActivationStage.ProductionActive,
        _ => throw new InvalidOperationException($"Unknown production activation stage {value}.")
    };

    private static SigningProviderType ParseSigningProviderType(string value) => value switch
    {
        "LOCAL_TEST" => SigningProviderType.LocalTest,
        "SOFTWARE_KEY" => SigningProviderType.SoftwareKey,
        "KMS" => SigningProviderType.Kms,
        "HSM" => SigningProviderType.Hsm,
        "SIMULATION" => SigningProviderType.Simulation,
        _ => throw new InvalidOperationException($"Unknown signing provider type {value}.")
    };

    private static SigningFailureMode ParseFailureMode(string value) => value switch
    {
        "FailClosed" => SigningFailureMode.FailClosed,
        "FailOpen" => SigningFailureMode.FailOpen,
        _ => throw new InvalidOperationException($"Unknown signing failure mode {value}.")
    };

    private static SigningProviderLifecycleState ParseLifecycle(string value) => value switch
    {
        "Draft" => SigningProviderLifecycleState.Draft,
        "Active" => SigningProviderLifecycleState.Active,
        "Disabled" => SigningProviderLifecycleState.Disabled,
        "Retired" => SigningProviderLifecycleState.Retired,
        "Revoked" => SigningProviderLifecycleState.Revoked,
        _ => throw new InvalidOperationException($"Unknown signing lifecycle state {value}.")
    };

    private const string EventSelect = """
select activation_event_id, provider_id, provider_version, configuration_version,
  stage, actor_reference, reason_code, approval_reference,
  signing_provider_id, signing_provider_version, signing_key_version,
  canonical_request_hash, evidence_hash, idempotency_key, created_at
from game_engine.game_engine_production_activation_events
""";
}
