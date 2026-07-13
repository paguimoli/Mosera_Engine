using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;
using NpgsqlTypes;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresProvablyFairNonceAllocator(string connectionString) : IProvablyFairNonceAllocator
{
    public async Task<ProvablyFairNonceAllocation> AllocateAsync(
        string providerId,
        string providerVersion,
        string providerScope,
        ProvablyFairNonceScopeType scopeType,
        string uniquenessScope,
        CancellationToken cancellationToken)
    {
        await using var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await using (var lockCommand = connection.CreateCommand())
        {
            lockCommand.Transaction = transaction;
            lockCommand.CommandText = "select pg_advisory_xact_lock(hashtextextended(@lock_scope, 0));";
            lockCommand.Parameters.AddWithValue("lock_scope", $"{providerId}|{providerVersion}|{providerScope}|{scopeType}|{uniquenessScope}");
            await lockCommand.ExecuteScalarAsync(cancellationToken);
        }

        long next;
        await using (var maxCommand = connection.CreateCommand())
        {
            maxCommand.Transaction = transaction;
            maxCommand.CommandText = """
select coalesce(max(nonce), 0) + 1
from game_engine.provably_fair_nonce_sequences
where provider_id = @provider_id
  and provider_version = @provider_version
  and provider_scope = @provider_scope
  and scope_type = @scope_type
  and uniqueness_scope = @uniqueness_scope;
""";
            maxCommand.Parameters.AddWithValue("provider_id", providerId);
            maxCommand.Parameters.AddWithValue("provider_version", providerVersion);
            maxCommand.Parameters.AddWithValue("provider_scope", providerScope);
            maxCommand.Parameters.AddWithValue("scope_type", ToScopeType(scopeType));
            maxCommand.Parameters.AddWithValue("uniqueness_scope", uniquenessScope);
            next = (long)(await maxCommand.ExecuteScalarAsync(cancellationToken) ?? 1L);
        }

        var allocation = new ProvablyFairNonceAllocation(
            Guid.NewGuid(),
            providerId,
            providerVersion,
            providerScope,
            scopeType,
            next,
            uniquenessScope,
            OutcomeProviderOrchestrationService.HashCanonical($"{providerId}|{providerVersion}|{providerScope}|{scopeType}|{uniquenessScope}|{next}"),
            DateTimeOffset.UtcNow);

        await using (var insertCommand = connection.CreateCommand())
        {
            insertCommand.Transaction = transaction;
            insertCommand.CommandText = """
insert into game_engine.provably_fair_nonce_sequences (
  id,
  provider_id,
  provider_version,
  provider_scope,
  scope_type,
  nonce,
  nonce_policy,
  monotonic_required,
  uniqueness_scope,
  content_hash
) values (
  @id,
  @provider_id,
  @provider_version,
  @provider_scope,
  @scope_type,
  @nonce,
  @nonce_policy,
  true,
  @uniqueness_scope,
  @content_hash
);
""";
            insertCommand.Parameters.AddWithValue("id", allocation.Id);
            insertCommand.Parameters.AddWithValue("provider_id", providerId);
            insertCommand.Parameters.AddWithValue("provider_version", providerVersion);
            insertCommand.Parameters.AddWithValue("provider_scope", providerScope);
            insertCommand.Parameters.AddWithValue("scope_type", ToScopeType(scopeType));
            insertCommand.Parameters.AddWithValue("nonce", next);
            insertCommand.Parameters.Add("nonce_policy", NpgsqlDbType.Jsonb).Value =
                """{"scopeType":"Wager","monotonicRequired":true,"uniquenessScope":"provider-wager","runtime":"provably-fair"}""";
            insertCommand.Parameters.AddWithValue("uniqueness_scope", uniquenessScope);
            insertCommand.Parameters.AddWithValue("content_hash", allocation.ContentHash);
            await insertCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
        return allocation;
    }

    public async Task<bool> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "select to_regclass('game_engine.provably_fair_nonce_sequences') is not null;";
            return (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            return false;
        }
    }

    private static string ToScopeType(ProvablyFairNonceScopeType scopeType)
    {
        return scopeType switch
        {
            ProvablyFairNonceScopeType.Wager => "Wager",
            ProvablyFairNonceScopeType.Draw => "Draw",
            _ => throw new ArgumentOutOfRangeException(nameof(scopeType), scopeType, "Unsupported nonce scope type.")
        };
    }
}

public sealed class PostgresProvablyFairRuntimeEvidenceRepository(string connectionString) : IProvablyFairRuntimeEvidenceRepository
{
    public async Task AppendCommitmentAsync(
        ProvablyFairProtectedServerSeed seed,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.provably_fair_seed_commitments (
  seed_id,
  provider_id,
  provider_version,
  seed_generation_timestamp,
  commitment_hash,
  seed_lifecycle,
  rotation_policy,
  activation_timestamp,
  retirement_timestamp,
  content_hash
) values (
  @seed_id,
  @provider_id,
  @provider_version,
  @seed_generation_timestamp,
  @commitment_hash,
  'Active',
  @rotation_policy,
  @activation_timestamp,
  null,
  @content_hash
)
on conflict (commitment_hash) do nothing;
""";
        command.Parameters.AddWithValue("seed_id", seed.SeedId);
        command.Parameters.AddWithValue("provider_id", seed.ProviderId);
        command.Parameters.AddWithValue("provider_version", seed.ProviderVersion);
        command.Parameters.AddWithValue("seed_generation_timestamp", seed.GeneratedAt);
        command.Parameters.AddWithValue("commitment_hash", seed.CommitmentHash);
        command.Parameters.Add("rotation_policy", NpgsqlDbType.Jsonb).Value =
            """{"runtime":"provably-fair","plaintextPersisted":false,"rotation":"manual-governed"}""";
        command.Parameters.AddWithValue("activation_timestamp", seed.ActivatedAt);
        command.Parameters.AddWithValue("content_hash", OutcomeProviderOrchestrationService.HashCanonical($"{seed.SeedId:N}|{seed.CommitmentHash}|{seed.Scope}"));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task AppendReceiptAsync(
        ProvablyFairRuntimeReceipt receipt,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.provably_fair_runtime_receipts (
  receipt_id,
  wager_reference,
  outcome_certificate_id,
  outcome_certificate_hash,
  provider_id,
  provider_version,
  server_commitment,
  client_seed,
  nonce,
  verification_algorithm,
  canonical_verification_payload,
  resulting_outcome_hash,
  verification_status,
  reveal_state,
  receipt_hash,
  issued_at
) values (
  @receipt_id,
  @wager_reference,
  @outcome_certificate_id,
  @outcome_certificate_hash,
  @provider_id,
  @provider_version,
  @server_commitment,
  @client_seed,
  @nonce,
  @verification_algorithm,
  @canonical_verification_payload,
  @resulting_outcome_hash,
  @verification_status,
  @reveal_state,
  @receipt_hash,
  @issued_at
)
on conflict (receipt_hash) do nothing;
""";
        command.Parameters.AddWithValue("receipt_id", receipt.ReceiptId);
        command.Parameters.AddWithValue("wager_reference", receipt.WagerReference);
        command.Parameters.AddWithValue("outcome_certificate_id", receipt.OutcomeCertificateId);
        command.Parameters.AddWithValue("outcome_certificate_hash", receipt.OutcomeCertificateHash);
        command.Parameters.AddWithValue("provider_id", receipt.ProviderId);
        command.Parameters.AddWithValue("provider_version", receipt.ProviderVersion);
        command.Parameters.AddWithValue("server_commitment", receipt.ServerCommitment);
        command.Parameters.AddWithValue("client_seed", receipt.CanonicalClientSeed);
        command.Parameters.AddWithValue("nonce", receipt.Nonce);
        command.Parameters.AddWithValue("verification_algorithm", ToVerificationAlgorithm(receipt.VerificationAlgorithm));
        command.Parameters.Add("canonical_verification_payload", NpgsqlDbType.Jsonb).Value = receipt.CanonicalVerificationPayload;
        command.Parameters.AddWithValue("resulting_outcome_hash", receipt.ResultingOutcomeHash);
        command.Parameters.AddWithValue("verification_status", receipt.VerificationStatus.ToString());
        command.Parameters.AddWithValue("reveal_state", receipt.RevealState.ToString());
        command.Parameters.AddWithValue("receipt_hash", receipt.ReceiptHash);
        command.Parameters.AddWithValue("issued_at", receipt.IssuedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task AppendRevealEvidenceAsync(
        ProvablyFairRevealEvidence evidence,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.provably_fair_seed_reveal_evidence (
  reveal_id,
  seed_id,
  provider_id,
  provider_version,
  scope,
  server_seed_hash,
  commitment_hash,
  reveal_status,
  canonical_evidence_hash,
  revealed_at
) values (
  @reveal_id,
  @seed_id,
  @provider_id,
  @provider_version,
  @scope,
  @server_seed_hash,
  @commitment_hash,
  @reveal_status,
  @canonical_evidence_hash,
  @revealed_at
)
on conflict (canonical_evidence_hash) do nothing;
""";
        command.Parameters.AddWithValue("reveal_id", evidence.RevealId);
        command.Parameters.AddWithValue("seed_id", evidence.SeedId);
        command.Parameters.AddWithValue("provider_id", evidence.ProviderId);
        command.Parameters.AddWithValue("provider_version", evidence.ProviderVersion);
        command.Parameters.AddWithValue("scope", evidence.Scope);
        command.Parameters.AddWithValue("server_seed_hash", evidence.ServerSeedHash);
        command.Parameters.AddWithValue("commitment_hash", evidence.CommitmentHash);
        command.Parameters.AddWithValue("reveal_status", evidence.RevealStatus.ToString());
        command.Parameters.AddWithValue("canonical_evidence_hash", evidence.CanonicalEvidenceHash);
        command.Parameters.AddWithValue("revealed_at", evidence.RevealedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task AppendVerificationResultAsync(
        ProvablyFairReceiptVerificationResult result,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.provably_fair_verification_results (
  verification_id,
  receipt_id,
  receipt_hash,
  recomputed_commitment_hash,
  recomputed_outcome_hash,
  verification_status,
  failure_reason,
  canonical_result_hash,
  verified_at
) values (
  @verification_id,
  @receipt_id,
  @receipt_hash,
  @recomputed_commitment_hash,
  @recomputed_outcome_hash,
  @verification_status,
  @failure_reason,
  @canonical_result_hash,
  @verified_at
)
on conflict (canonical_result_hash) do nothing;
""";
        command.Parameters.AddWithValue("verification_id", result.VerificationId);
        command.Parameters.AddWithValue("receipt_id", result.ReceiptId);
        command.Parameters.AddWithValue("receipt_hash", result.ReceiptHash);
        command.Parameters.AddWithValue("recomputed_commitment_hash", result.RecomputedCommitmentHash);
        command.Parameters.AddWithValue("recomputed_outcome_hash", result.RecomputedOutcomeHash);
        command.Parameters.AddWithValue("verification_status", result.Status.ToString());
        command.Parameters.AddWithValue("failure_reason", result.FailureReason is null ? DBNull.Value : result.FailureReason);
        command.Parameters.AddWithValue("canonical_result_hash", result.CanonicalResultHash);
        command.Parameters.AddWithValue("verified_at", result.VerifiedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<bool> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('game_engine.provably_fair_seed_commitments') is not null
  and to_regclass('game_engine.provably_fair_runtime_receipts') is not null
  and to_regclass('game_engine.provably_fair_seed_reveal_evidence') is not null
  and to_regclass('game_engine.provably_fair_verification_results') is not null;
""";
            return (bool)(await command.ExecuteScalarAsync(cancellationToken) ?? false);
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            return false;
        }
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static string ToVerificationAlgorithm(ProvablyFairVerificationAlgorithm algorithm)
    {
        return algorithm switch
        {
            ProvablyFairVerificationAlgorithm.HmacSha256 => "HMAC_SHA_256",
            ProvablyFairVerificationAlgorithm.HmacSha384 => "HMAC_SHA_384",
            ProvablyFairVerificationAlgorithm.HmacSha512 => "HMAC_SHA_512",
            _ => throw new ArgumentOutOfRangeException(nameof(algorithm), algorithm, "Unsupported verification algorithm.")
        };
    }
}
