using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresOutcomeRuntimeProvenanceRepository(string connectionString) : IOutcomeRuntimeProvenanceRepository
{
    public async Task<OutcomeRuntimeBootIdentity> AppendBootIdentityAsync(
        OutcomeRuntimeBootIdentity bootIdentity,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.outcome_runtime_boot_identities (
  boot_id,
  runtime_instance_id,
  process_id,
  container_id,
  host_id,
  hostname,
  service_version,
  semantic_version,
  build_number,
  git_commit_sha,
  git_branch,
  docker_image_digest,
  build_timestamp,
  boot_timestamp,
  environment,
  provider_configuration_version,
  outcome_provider_id,
  outcome_provider_version,
  entropy_provider_id,
  entropy_provider_version,
  build_hash,
  runtime_framework
) values (
  @boot_id,
  @runtime_instance_id,
  @process_id,
  @container_id,
  @host_id,
  @hostname,
  @service_version,
  @semantic_version,
  @build_number,
  @git_commit_sha,
  @git_branch,
  @docker_image_digest,
  @build_timestamp,
  @boot_timestamp,
  @environment,
  @provider_configuration_version,
  @outcome_provider_id,
  @outcome_provider_version,
  @entropy_provider_id,
  @entropy_provider_version,
  @build_hash,
  @runtime_framework
)
on conflict (boot_id) do nothing;
""";
        command.Parameters.AddWithValue("boot_id", bootIdentity.BootId);
        command.Parameters.AddWithValue("runtime_instance_id", bootIdentity.RuntimeInstanceId);
        command.Parameters.AddWithValue("process_id", bootIdentity.ProcessId);
        command.Parameters.AddWithValue("container_id", bootIdentity.ContainerId is null ? DBNull.Value : bootIdentity.ContainerId);
        command.Parameters.AddWithValue("host_id", bootIdentity.HostId);
        command.Parameters.AddWithValue("hostname", bootIdentity.Hostname);
        command.Parameters.AddWithValue("service_version", bootIdentity.ServiceVersion);
        command.Parameters.AddWithValue("semantic_version", bootIdentity.SemanticVersion);
        command.Parameters.AddWithValue("build_number", bootIdentity.BuildNumber);
        command.Parameters.AddWithValue("git_commit_sha", bootIdentity.GitCommitSha);
        command.Parameters.AddWithValue("git_branch", bootIdentity.GitBranch is null ? DBNull.Value : bootIdentity.GitBranch);
        command.Parameters.AddWithValue("docker_image_digest", bootIdentity.DockerImageDigest is null ? DBNull.Value : bootIdentity.DockerImageDigest);
        command.Parameters.AddWithValue("build_timestamp", bootIdentity.BuildTimestamp is null ? DBNull.Value : bootIdentity.BuildTimestamp.Value);
        command.Parameters.AddWithValue("boot_timestamp", bootIdentity.BootTimestamp);
        command.Parameters.AddWithValue("environment", bootIdentity.Environment);
        command.Parameters.AddWithValue("provider_configuration_version", bootIdentity.ProviderConfigurationVersion);
        command.Parameters.AddWithValue("outcome_provider_id", bootIdentity.OutcomeProviderId is null ? DBNull.Value : bootIdentity.OutcomeProviderId);
        command.Parameters.AddWithValue("outcome_provider_version", bootIdentity.OutcomeProviderVersion is null ? DBNull.Value : bootIdentity.OutcomeProviderVersion);
        command.Parameters.AddWithValue("entropy_provider_id", bootIdentity.EntropyProviderId is null ? DBNull.Value : bootIdentity.EntropyProviderId);
        command.Parameters.AddWithValue("entropy_provider_version", bootIdentity.EntropyProviderVersion is null ? DBNull.Value : bootIdentity.EntropyProviderVersion);
        command.Parameters.AddWithValue("build_hash", bootIdentity.BuildHash);
        command.Parameters.AddWithValue("runtime_framework", bootIdentity.RuntimeFramework);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return bootIdentity;
    }

    public async Task AppendRequestProvenanceAsync(
        Guid runtimeRequestId,
        OutcomeRuntimeProvenanceSnapshot provenance,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.outcome_runtime_request_provenance (
  provenance_id,
  runtime_request_id,
  boot_id,
  runtime_instance_id,
  process_id,
  build_hash,
  git_commit_sha,
  docker_image_digest,
  outcome_provider_id,
  outcome_provider_version,
  entropy_provider_id,
  entropy_provider_version,
  manifest_id,
  manifest_version,
  provider_configuration_version,
  content_hash
) values (
  @provenance_id,
  @runtime_request_id,
  @boot_id,
  @runtime_instance_id,
  @process_id,
  @build_hash,
  @git_commit_sha,
  @docker_image_digest,
  @outcome_provider_id,
  @outcome_provider_version,
  @entropy_provider_id,
  @entropy_provider_version,
  @manifest_id,
  @manifest_version,
  @provider_configuration_version,
  @content_hash
)
on conflict (runtime_request_id, boot_id) do nothing;
""";
        AddProvenanceParameters(command, provenance);
        command.Parameters.AddWithValue("provenance_id", Guid.NewGuid());
        command.Parameters.AddWithValue("runtime_request_id", runtimeRequestId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task AppendAttemptProvenanceAsync(
        Guid attemptId,
        Guid runtimeRequestId,
        OutcomeRuntimeProvenanceSnapshot provenance,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.outcome_runtime_attempt_provenance (
  provenance_id,
  attempt_id,
  runtime_request_id,
  boot_id,
  runtime_instance_id,
  process_id,
  build_hash,
  git_commit_sha,
  docker_image_digest,
  outcome_provider_id,
  outcome_provider_version,
  entropy_provider_id,
  entropy_provider_version,
  manifest_id,
  manifest_version,
  provider_configuration_version,
  content_hash
) values (
  @provenance_id,
  @attempt_id,
  @runtime_request_id,
  @boot_id,
  @runtime_instance_id,
  @process_id,
  @build_hash,
  @git_commit_sha,
  @docker_image_digest,
  @outcome_provider_id,
  @outcome_provider_version,
  @entropy_provider_id,
  @entropy_provider_version,
  @manifest_id,
  @manifest_version,
  @provider_configuration_version,
  @content_hash
)
on conflict (attempt_id, boot_id) do nothing;
""";
        AddProvenanceParameters(command, provenance);
        command.Parameters.AddWithValue("provenance_id", Guid.NewGuid());
        command.Parameters.AddWithValue("attempt_id", attemptId);
        command.Parameters.AddWithValue("runtime_request_id", runtimeRequestId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task AppendRecoveryEvidenceAsync(
        OutcomeRuntimeRecoveryEvidence evidence,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.outcome_runtime_recovery_evidence (
  evidence_id,
  event_type,
  boot_id,
  runtime_instance_id,
  runtime_request_id,
  attempt_id,
  draw_request_scope,
  provider_id,
  provider_version,
  provider_type,
  reason_code,
  details,
  recovery_hash,
  content_hash,
  created_at
) values (
  @evidence_id,
  @event_type,
  @boot_id,
  @runtime_instance_id,
  @runtime_request_id,
  @attempt_id,
  @draw_request_scope,
  @provider_id,
  @provider_version,
  @provider_type,
  @reason_code,
  @details,
  @recovery_hash,
  @content_hash,
  @created_at
)
on conflict (content_hash) do nothing;
""";
        command.Parameters.AddWithValue("evidence_id", evidence.EvidenceId);
        command.Parameters.AddWithValue("event_type", evidence.EventType.ToString());
        command.Parameters.AddWithValue("boot_id", evidence.BootId);
        command.Parameters.AddWithValue("runtime_instance_id", evidence.RuntimeInstanceId);
        command.Parameters.AddWithValue("runtime_request_id", evidence.RuntimeRequestId is null ? DBNull.Value : evidence.RuntimeRequestId.Value);
        command.Parameters.AddWithValue("attempt_id", evidence.AttemptId is null ? DBNull.Value : evidence.AttemptId.Value);
        command.Parameters.AddWithValue("draw_request_scope", evidence.DrawRequestScope is null ? DBNull.Value : evidence.DrawRequestScope);
        command.Parameters.AddWithValue("provider_id", evidence.ProviderId is null ? DBNull.Value : evidence.ProviderId);
        command.Parameters.AddWithValue("provider_version", evidence.ProviderVersion is null ? DBNull.Value : evidence.ProviderVersion);
        command.Parameters.AddWithValue("provider_type", evidence.ProviderType is null ? DBNull.Value : ToDatabaseProviderType(evidence.ProviderType.Value));
        command.Parameters.AddWithValue("reason_code", evidence.ReasonCode is null ? DBNull.Value : evidence.ReasonCode);
        command.Parameters.AddWithValue("details", evidence.Details is null ? DBNull.Value : evidence.Details);
        command.Parameters.AddWithValue("recovery_hash", evidence.RecoveryHash);
        command.Parameters.AddWithValue("content_hash", evidence.ContentHash);
        command.Parameters.AddWithValue("created_at", evidence.CreatedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<OutcomeRuntimeRecoveryReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('game_engine.outcome_runtime_boot_identities') is not null,
  to_regclass('game_engine.outcome_runtime_request_provenance') is not null,
  to_regclass('game_engine.outcome_runtime_attempt_provenance') is not null,
  to_regclass('game_engine.outcome_runtime_recovery_evidence') is not null;
""";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            await reader.ReadAsync(cancellationToken);
            if (!reader.GetBoolean(0))
            {
                blockers.Add("game_engine.outcome_runtime_boot_identities is missing.");
            }

            if (!reader.GetBoolean(1) || !reader.GetBoolean(2))
            {
                blockers.Add("Outcome runtime provenance tables are missing.");
            }

            if (!reader.GetBoolean(3))
            {
                blockers.Add("game_engine.outcome_runtime_recovery_evidence is missing.");
            }
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException or OperationCanceledException)
        {
            blockers.Add(error.Message);
        }

        return new OutcomeRuntimeRecoveryReadiness(
            BootIdentityReady: blockers.Count == 0,
            ProvenanceRepositoryReady: blockers.Count == 0,
            RecoveryEvidenceRepositoryReady: blockers.Count == 0,
            RollbackDetectionReady: blockers.Count == 0,
            CrashInjectionConfigured: !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OUTCOME_RUNTIME_CRASH_INJECTION_STAGE")),
            ProductionGenerationDisabled: true,
            Blockers: blockers);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static void AddProvenanceParameters(NpgsqlCommand command, OutcomeRuntimeProvenanceSnapshot provenance)
    {
        command.Parameters.AddWithValue("boot_id", provenance.BootId);
        command.Parameters.AddWithValue("runtime_instance_id", provenance.RuntimeInstanceId);
        command.Parameters.AddWithValue("process_id", provenance.ProcessId);
        command.Parameters.AddWithValue("build_hash", provenance.BuildHash);
        command.Parameters.AddWithValue("git_commit_sha", provenance.GitCommitSha);
        command.Parameters.AddWithValue("docker_image_digest", provenance.DockerImageDigest is null ? DBNull.Value : provenance.DockerImageDigest);
        command.Parameters.AddWithValue("outcome_provider_id", provenance.OutcomeProviderId is null ? DBNull.Value : provenance.OutcomeProviderId);
        command.Parameters.AddWithValue("outcome_provider_version", provenance.OutcomeProviderVersion is null ? DBNull.Value : provenance.OutcomeProviderVersion);
        command.Parameters.AddWithValue("entropy_provider_id", provenance.EntropyProviderId is null ? DBNull.Value : provenance.EntropyProviderId);
        command.Parameters.AddWithValue("entropy_provider_version", provenance.EntropyProviderVersion is null ? DBNull.Value : provenance.EntropyProviderVersion);
        command.Parameters.AddWithValue("manifest_id", provenance.ManifestId is null ? DBNull.Value : provenance.ManifestId);
        command.Parameters.AddWithValue("manifest_version", provenance.ManifestVersion is null ? DBNull.Value : provenance.ManifestVersion);
        command.Parameters.AddWithValue("provider_configuration_version", provenance.ProviderConfigurationVersion);
        command.Parameters.AddWithValue("content_hash", OutcomeProviderOrchestrationService.HashCanonical(
            $"{provenance.BootId}|{provenance.RuntimeInstanceId}|{provenance.BuildHash}|{provenance.GitCommitSha}|{provenance.OutcomeProviderId}|{provenance.ManifestId}|{Guid.NewGuid():N}"));
    }

    private static string ToDatabaseProviderType(OutcomeProviderType providerType)
    {
        return providerType switch
        {
            OutcomeProviderType.CertifiedCsprng => "CERTIFIED_CSPRNG",
            OutcomeProviderType.ProvablyFair => "PROVABLY_FAIR",
            OutcomeProviderType.ExternalOfficialResult => "EXTERNAL_OFFICIAL_RESULT",
            OutcomeProviderType.PhysicalDrawResult => "PHYSICAL_DRAW_RESULT",
            OutcomeProviderType.SimulationTest => "SIMULATION_TEST",
            _ => throw new ArgumentOutOfRangeException(nameof(providerType), providerType, "Unsupported Outcome Provider type.")
        };
    }
}
