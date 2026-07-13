using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;
using NpgsqlTypes;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresCertifiedCsprngEvidenceRepository(string connectionString) : ICertifiedCsprngEvidenceRepository
{
    public async Task AppendAsync(DrbgSessionEvidence evidence, CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.drbg_session_evidence (
  session_id,
  draw_request_scope,
  provider_id,
  provider_version,
  entropy_provider_id,
  entropy_provider_version,
  reseed_counter,
  personalization_string_hash,
  nonce_hash,
  seed_commitment_hash,
  startup_self_test_result,
  known_answer_test_result,
  continuous_test_result,
  generated_at,
  destroyed_zeroized_at,
  canonical_evidence_hash,
  signing_metadata
) values (
  @session_id,
  @draw_request_scope,
  @provider_id,
  @provider_version,
  @entropy_provider_id,
  @entropy_provider_version,
  @reseed_counter,
  @personalization_string_hash,
  @nonce_hash,
  @seed_commitment_hash,
  @startup_self_test_result,
  @known_answer_test_result,
  @continuous_test_result,
  @generated_at,
  @destroyed_zeroized_at,
  @canonical_evidence_hash,
  @signing_metadata
)
on conflict (canonical_evidence_hash) do nothing;
""";
        command.Parameters.AddWithValue("session_id", evidence.SessionId);
        command.Parameters.AddWithValue("draw_request_scope", evidence.DrawRequestScope);
        command.Parameters.AddWithValue("provider_id", evidence.ProviderId);
        command.Parameters.AddWithValue("provider_version", evidence.ProviderVersion);
        command.Parameters.AddWithValue("entropy_provider_id", evidence.EntropyProviderId);
        command.Parameters.AddWithValue("entropy_provider_version", evidence.EntropyProviderVersion);
        command.Parameters.AddWithValue("reseed_counter", evidence.ReseedCounter);
        command.Parameters.AddWithValue("personalization_string_hash", evidence.PersonalizationStringHash);
        command.Parameters.AddWithValue("nonce_hash", evidence.NonceHash);
        command.Parameters.AddWithValue("seed_commitment_hash", evidence.SeedCommitmentHash);
        command.Parameters.AddWithValue("startup_self_test_result", evidence.StartupSelfTestResult.ToString());
        command.Parameters.AddWithValue("known_answer_test_result", evidence.KnownAnswerTestResult.ToString());
        command.Parameters.AddWithValue("continuous_test_result", evidence.ContinuousTestResult.ToString());
        command.Parameters.AddWithValue("generated_at", evidence.GeneratedAt);
        command.Parameters.AddWithValue("destroyed_zeroized_at", evidence.DestroyedZeroizedAt);
        command.Parameters.AddWithValue("canonical_evidence_hash", evidence.CanonicalEvidenceHash);
        command.Parameters.Add("signing_metadata", NpgsqlDbType.Jsonb).Value = DBNull.Value;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<bool> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('game_engine.drbg_session_evidence') is not null
  and to_regclass('game_engine.csprng_provider_definitions') is not null
  and to_regclass('game_engine.entropy_provider_definitions') is not null;
""";
            return (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            return false;
        }
    }
}
