using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public interface IOutcomeRuntimeProvenanceRepository
{
    Task<OutcomeRuntimeBootIdentity> AppendBootIdentityAsync(
        OutcomeRuntimeBootIdentity bootIdentity,
        CancellationToken cancellationToken);

    Task AppendRequestProvenanceAsync(
        Guid runtimeRequestId,
        OutcomeRuntimeProvenanceSnapshot provenance,
        CancellationToken cancellationToken);

    Task AppendAttemptProvenanceAsync(
        Guid attemptId,
        Guid runtimeRequestId,
        OutcomeRuntimeProvenanceSnapshot provenance,
        CancellationToken cancellationToken);

    Task AppendRecoveryEvidenceAsync(
        OutcomeRuntimeRecoveryEvidence evidence,
        CancellationToken cancellationToken);

    Task<OutcomeRuntimeRecoveryReadiness> CheckReadinessAsync(CancellationToken cancellationToken);
}

public interface IOutcomeRuntimeCrashInjector
{
    void ThrowIfCrashPoint(OutcomeRuntimeCrashInjectionStage stage);

    bool IsConfigured { get; }
}

public sealed class EnvironmentOutcomeRuntimeCrashInjector : IOutcomeRuntimeCrashInjector
{
    private readonly string? configuredStage = Environment.GetEnvironmentVariable("OUTCOME_RUNTIME_CRASH_INJECTION_STAGE");

    public bool IsConfigured => !string.IsNullOrWhiteSpace(configuredStage);

    public void ThrowIfCrashPoint(OutcomeRuntimeCrashInjectionStage stage)
    {
        if (!string.Equals(configuredStage, stage.ToString(), StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        throw new InvalidOperationException($"Outcome runtime crash injection requested at {stage}.");
    }
}

public sealed class OutcomeRuntimeRecoveryService
{
    private readonly IOutcomeRuntimeProvenanceRepository repository;
    private readonly IOutcomeRuntimeCrashInjector crashInjector;
    private readonly Lazy<OutcomeRuntimeBootIdentity> bootIdentity;

    public OutcomeRuntimeRecoveryService(
        IOutcomeRuntimeProvenanceRepository repository,
        IOutcomeRuntimeCrashInjector crashInjector)
    {
        this.repository = repository;
        this.crashInjector = crashInjector;
        bootIdentity = new Lazy<OutcomeRuntimeBootIdentity>(CreateBootIdentity);
    }

    public OutcomeRuntimeBootIdentity CurrentBootIdentity => bootIdentity.Value;

    public OutcomeRuntimeProvenanceSnapshot CreateSnapshot(
        OutcomeProviderRuntimeRequest? request = null,
        OutcomeProviderDefinitionV1? provider = null,
        string? entropyProviderId = null,
        string? entropyProviderVersion = null)
    {
        var boot = CurrentBootIdentity;
        return new OutcomeRuntimeProvenanceSnapshot(
            boot.BootId,
            boot.RuntimeInstanceId,
            boot.ProcessId,
            boot.BuildHash,
            boot.GitCommitSha,
            boot.DockerImageDigest,
            provider?.ProviderId ?? request?.ManifestBinding?.ProviderId ?? boot.OutcomeProviderId,
            provider?.ProviderVersion ?? request?.ManifestBinding?.ProviderVersion ?? boot.OutcomeProviderVersion,
            entropyProviderId ?? boot.EntropyProviderId,
            entropyProviderVersion ?? boot.EntropyProviderVersion,
            request?.GameManifestId,
            request?.GameManifestVersion,
            boot.ProviderConfigurationVersion);
    }

    public async Task RecordBootAsync(CancellationToken cancellationToken)
    {
        crashInjector.ThrowIfCrashPoint(OutcomeRuntimeCrashInjectionStage.Startup);
        await repository.AppendBootIdentityAsync(CurrentBootIdentity, cancellationToken);
        await AppendRecoveryEvidenceAsync(
            OutcomeRuntimeRecoveryEventType.Boot,
            request: null,
            provider: null,
            reasonCode: "BOOT_STARTED",
            details: "Outcome runtime boot identity created.",
            cancellationToken);
        await AppendRecoveryEvidenceAsync(
            OutcomeRuntimeRecoveryEventType.StartupValidation,
            request: null,
            provider: null,
            reasonCode: "STARTUP_VALIDATION",
            details: "Production outcome generation remains disabled; runtime provenance is active.",
            cancellationToken);
    }

    public async Task RecordRequestProvenanceAsync(
        Guid runtimeRequestId,
        OutcomeProviderRuntimeRequest request,
        OutcomeProviderDefinitionV1 provider,
        CancellationToken cancellationToken)
    {
        await repository.AppendRequestProvenanceAsync(
            runtimeRequestId,
            CreateSnapshot(request, provider),
            cancellationToken);
    }

    public async Task RecordAttemptProvenanceAsync(
        OutcomeRuntimeAttemptEvidence attempt,
        OutcomeProviderRuntimeRequest request,
        OutcomeProviderDefinitionV1 provider,
        CancellationToken cancellationToken)
    {
        await repository.AppendAttemptProvenanceAsync(
            attempt.AttemptId,
            attempt.RuntimeRequestId,
            CreateSnapshot(request, provider),
            cancellationToken);
    }

    public Task AppendRecoveryEvidenceAsync(
        OutcomeRuntimeRecoveryEventType eventType,
        OutcomeProviderRuntimeRequest? request,
        OutcomeProviderDefinitionV1? provider,
        string? reasonCode,
        string? details,
        CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var snapshot = CreateSnapshot(request, provider);
        var recoveryHash = OutcomeProviderOrchestrationService.HashCanonical(
            $"{eventType}|{snapshot.BootId}|{request?.RuntimeRequestId}|{request?.DrawRequestScope}|{provider?.ProviderId}|{reasonCode}|{details}|{now:O}");
        var contentHash = OutcomeProviderOrchestrationService.HashCanonical(
            $"{recoveryHash}|{snapshot.BuildHash}|{snapshot.GitCommitSha}|{snapshot.ProviderConfigurationVersion}");

        return repository.AppendRecoveryEvidenceAsync(
            new OutcomeRuntimeRecoveryEvidence(
                Guid.NewGuid(),
                eventType,
                snapshot.BootId,
                snapshot.RuntimeInstanceId,
                request?.RuntimeRequestId,
                AttemptId: null,
                request?.DrawRequestScope,
                provider?.ProviderId,
                provider?.ProviderVersion,
                provider?.ProviderType,
                reasonCode,
                details,
                recoveryHash,
                contentHash,
                now),
            cancellationToken);
    }

    public Task<OutcomeRuntimeRecoveryReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        return repository.CheckReadinessAsync(cancellationToken);
    }

    public void ThrowIfCrashPoint(OutcomeRuntimeCrashInjectionStage stage)
    {
        crashInjector.ThrowIfCrashPoint(stage);
    }

    private static OutcomeRuntimeBootIdentity CreateBootIdentity()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var serviceVersion = assembly.GetName().Version?.ToString() ?? "0.0.0";
        var semanticVersion = Environment.GetEnvironmentVariable("RELEASE_VERSION") ??
            Environment.GetEnvironmentVariable("SERVICE_VERSION") ??
            serviceVersion;
        var buildNumber = Environment.GetEnvironmentVariable("BUILD_NUMBER") ??
            Environment.GetEnvironmentVariable("GITHUB_RUN_NUMBER") ??
            "local";
        var gitCommit = Environment.GetEnvironmentVariable("GIT_COMMIT_SHA") ??
            Environment.GetEnvironmentVariable("GITHUB_SHA") ??
            "local-unknown";
        var gitBranch = Environment.GetEnvironmentVariable("GIT_BRANCH") ??
            Environment.GetEnvironmentVariable("GITHUB_REF_NAME");
        var imageDigest = Environment.GetEnvironmentVariable("DOCKER_IMAGE_DIGEST") ??
            Environment.GetEnvironmentVariable("IMAGE_DIGEST");
        var buildTimestamp = TryParseTimestamp(Environment.GetEnvironmentVariable("BUILD_TIMESTAMP"));
        var hostname = Environment.MachineName;
        var runtimeInstanceId = Environment.GetEnvironmentVariable("RUNTIME_INSTANCE_ID") ??
            $"{hostname}:{Guid.NewGuid():N}";
        var providerConfigurationVersion = Environment.GetEnvironmentVariable("OUTCOME_PROVIDER_CONFIGURATION_VERSION") ??
            "local-development";

        var bootTimestamp = DateTimeOffset.UtcNow;
        var buildHash = OutcomeProviderOrchestrationService.HashCanonical(
            $"{serviceVersion}|{semanticVersion}|{buildNumber}|{gitCommit}|{imageDigest}|{buildTimestamp:O}|{RuntimeInformation.FrameworkDescription}");

        return new OutcomeRuntimeBootIdentity(
            Guid.NewGuid(),
            runtimeInstanceId,
            Environment.ProcessId,
            Environment.GetEnvironmentVariable("HOSTNAME"),
            Environment.GetEnvironmentVariable("HOST_ID") ?? hostname,
            hostname,
            serviceVersion,
            semanticVersion,
            buildNumber,
            gitCommit,
            gitBranch,
            imageDigest,
            buildTimestamp,
            bootTimestamp,
            Environment.GetEnvironmentVariable("DEPLOYMENT_ENVIRONMENT") ??
                Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ??
                "Development",
            providerConfigurationVersion,
            Environment.GetEnvironmentVariable("OUTCOME_PROVIDER_ID"),
            Environment.GetEnvironmentVariable("OUTCOME_PROVIDER_VERSION"),
            Environment.GetEnvironmentVariable("ENTROPY_PROVIDER_ID"),
            Environment.GetEnvironmentVariable("ENTROPY_PROVIDER_VERSION"),
            buildHash,
            RuntimeInformation.FrameworkDescription);
    }

    private static DateTimeOffset? TryParseTimestamp(string? value)
    {
        return DateTimeOffset.TryParse(value, out var parsed) ? parsed : null;
    }
}

public sealed class InMemoryOutcomeRuntimeProvenanceRepository : IOutcomeRuntimeProvenanceRepository
{
    private readonly List<OutcomeRuntimeBootIdentity> boots = [];
    private readonly List<OutcomeRuntimeRecoveryEvidence> evidence = [];

    public IReadOnlyCollection<OutcomeRuntimeBootIdentity> Boots => boots;

    public IReadOnlyCollection<OutcomeRuntimeRecoveryEvidence> Evidence => evidence;

    public Task<OutcomeRuntimeBootIdentity> AppendBootIdentityAsync(
        OutcomeRuntimeBootIdentity bootIdentity,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (boots.All(existing => existing.BootId != bootIdentity.BootId))
        {
            boots.Add(bootIdentity);
        }

        return Task.FromResult(bootIdentity);
    }

    public Task AppendRequestProvenanceAsync(
        Guid runtimeRequestId,
        OutcomeRuntimeProvenanceSnapshot provenance,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.CompletedTask;
    }

    public Task AppendAttemptProvenanceAsync(
        Guid attemptId,
        Guid runtimeRequestId,
        OutcomeRuntimeProvenanceSnapshot provenance,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.CompletedTask;
    }

    public Task AppendRecoveryEvidenceAsync(
        OutcomeRuntimeRecoveryEvidence recoveryEvidence,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        evidence.Add(recoveryEvidence);
        return Task.CompletedTask;
    }

    public Task<OutcomeRuntimeRecoveryReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new OutcomeRuntimeRecoveryReadiness(
            BootIdentityReady: true,
            ProvenanceRepositoryReady: true,
            RecoveryEvidenceRepositoryReady: true,
            RollbackDetectionReady: true,
            CrashInjectionConfigured: false,
            ProductionGenerationDisabled: true,
            Blockers: ["Outcome runtime provenance is using non-production in-memory evidence storage."]));
    }
}
