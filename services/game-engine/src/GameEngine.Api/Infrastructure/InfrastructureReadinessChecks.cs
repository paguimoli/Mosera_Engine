using System.Net.Sockets;
using System.Text;
using GameEngine.Api.Configuration;
using GameEngine.Application.Services;

namespace GameEngine.Api.Infrastructure;

public sealed class InfrastructureReadinessChecks
{
    private static readonly byte[] RedisPingCommand = Encoding.ASCII.GetBytes("*1\r\n$4\r\nPING\r\n");
    private readonly ServiceConfiguration configuration;
    private readonly IOutcomeRuntimeRequestRepository outcomeRuntimeRequests;
    private readonly IOutcomeRuntimeLockManager outcomeRuntimeLocks;
    private readonly OutcomeRuntimeRecoveryService outcomeRuntimeRecovery;
    private readonly DurableMathEvaluationService mathEvaluationService;
    private readonly MathEvaluationBatchService mathEvaluationBatchService;
    private readonly SettlementInputAdapter settlementInputAdapter;
    private readonly CanonicalOutcomeProviderAuthority canonicalOutcomeProviderAuthority;
    private readonly InternalCsprngOutcomeProvider internalCsprngProvider;
    private readonly CanonicalDrawOrchestrator canonicalDrawOrchestrator;
    private readonly ProvablyFairRuntimeService provablyFairRuntime;
    private readonly OfficialResultsProvider officialResultsProvider;
    private readonly ManualCertifiedProvider manualCertifiedProvider;
    private readonly PhysicalDrawResultRuntimeService physicalDrawRuntime;
    private readonly ILogger<InfrastructureReadinessChecks> logger;

    public InfrastructureReadinessChecks(
        ServiceConfiguration configuration,
        IOutcomeRuntimeRequestRepository outcomeRuntimeRequests,
        IOutcomeRuntimeLockManager outcomeRuntimeLocks,
        OutcomeRuntimeRecoveryService outcomeRuntimeRecovery,
        DurableMathEvaluationService mathEvaluationService,
        MathEvaluationBatchService mathEvaluationBatchService,
        SettlementInputAdapter settlementInputAdapter,
        CanonicalOutcomeProviderAuthority canonicalOutcomeProviderAuthority,
        InternalCsprngOutcomeProvider internalCsprngProvider,
        CanonicalDrawOrchestrator canonicalDrawOrchestrator,
        ProvablyFairRuntimeService provablyFairRuntime,
        OfficialResultsProvider officialResultsProvider,
        ManualCertifiedProvider manualCertifiedProvider,
        PhysicalDrawResultRuntimeService physicalDrawRuntime,
        ILogger<InfrastructureReadinessChecks> logger)
    {
        this.configuration = configuration;
        this.outcomeRuntimeRequests = outcomeRuntimeRequests;
        this.outcomeRuntimeLocks = outcomeRuntimeLocks;
        this.outcomeRuntimeRecovery = outcomeRuntimeRecovery;
        this.mathEvaluationService = mathEvaluationService;
        this.mathEvaluationBatchService = mathEvaluationBatchService;
        this.settlementInputAdapter = settlementInputAdapter;
        this.canonicalOutcomeProviderAuthority = canonicalOutcomeProviderAuthority;
        this.internalCsprngProvider = internalCsprngProvider;
        this.canonicalDrawOrchestrator = canonicalDrawOrchestrator;
        this.provablyFairRuntime = provablyFairRuntime;
        this.officialResultsProvider = officialResultsProvider;
        this.manualCertifiedProvider = manualCertifiedProvider;
        this.physicalDrawRuntime = physicalDrawRuntime;
        this.logger = logger;
    }

    public Task<DependencyHealthResult> CheckRabbitMqAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(configuration.RabbitMq.Url))
        {
            return Task.FromResult(new DependencyHealthResult("rabbitmq", false, "RABBITMQ_URL is not configured."));
        }

        return CheckTcpEndpointAsync("rabbitmq", configuration.RabbitMq.Url, 5672, cancellationToken);
    }

    public async Task<DependencyHealthResult> CheckRedisAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(configuration.Redis.Url))
        {
            return new DependencyHealthResult("redis", false, "REDIS_URL is not configured.");
        }

        try
        {
            var redisUri = new Uri(configuration.Redis.Url);
            using var client = new TcpClient();
            await client.ConnectAsync(redisUri.Host, GetPort(redisUri, 6379), cancellationToken);

            await using var stream = client.GetStream();
            await stream.WriteAsync(RedisPingCommand, cancellationToken);

            var buffer = new byte[16];
            var bytesRead = await stream.ReadAsync(buffer, cancellationToken);
            var response = Encoding.ASCII.GetString(buffer, 0, bytesRead);

            return response.StartsWith("+PONG", StringComparison.Ordinal)
                ? new DependencyHealthResult("redis", true)
                : new DependencyHealthResult("redis", false, "Unexpected Redis PING response.");
        }
        catch (Exception error) when (error is UriFormatException or SocketException or IOException or OperationCanceledException)
        {
            logger.LogWarning(error, "Redis readiness check failed.");
            return new DependencyHealthResult("redis", false, error.Message);
        }
    }

    public Task<DependencyHealthResult> CheckDatabaseAsync(CancellationToken cancellationToken)
    {
        var databaseUrl = Environment.GetEnvironmentVariable("DATABASE_URL");
        if (string.IsNullOrWhiteSpace(databaseUrl))
        {
            return Task.FromResult(new DependencyHealthResult("database", false, "DATABASE_URL is not configured."));
        }

        return CheckTcpEndpointAsync("database", databaseUrl, 5432, cancellationToken);
    }

    public async Task<DependencyHealthResult> CheckOutcomeRuntimePersistenceAsync(CancellationToken cancellationToken)
    {
        var readiness = await outcomeRuntimeRequests.CheckReadinessAsync(cancellationToken);
        var ready = readiness.DurablePersistenceConfigured &&
            readiness.DurablePersistenceReachable &&
            readiness.IdempotencyRepositoryReady &&
            readiness.RuntimeAttemptsRepositoryReady &&
            readiness.ProductionGenerationDisabled;

        return ready
            ? new DependencyHealthResult("outcome-runtime-persistence", true)
            : new DependencyHealthResult(
                "outcome-runtime-persistence",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckOutcomeRuntimeLockingAsync(CancellationToken cancellationToken)
    {
        var readiness = await outcomeRuntimeLocks.CheckReadinessAsync(cancellationToken);
        var ready = readiness.AdvisoryLockingConfigured &&
            readiness.AdvisoryLockingReachable &&
            readiness.RedisLockDependencyAbsent;

        return ready
            ? new DependencyHealthResult("outcome-runtime-locking", true)
            : new DependencyHealthResult(
                "outcome-runtime-locking",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckOutcomeRuntimeRecoveryAsync(CancellationToken cancellationToken)
    {
        var readiness = await outcomeRuntimeRecovery.CheckReadinessAsync(cancellationToken);
        var ready = readiness.BootIdentityReady &&
            readiness.ProvenanceRepositoryReady &&
            readiness.RecoveryEvidenceRepositoryReady &&
            readiness.RollbackDetectionReady &&
            readiness.ProductionGenerationDisabled;

        return ready
            ? new DependencyHealthResult("outcome-runtime-recovery", true)
            : new DependencyHealthResult(
                "outcome-runtime-recovery",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckMathEvaluationPersistenceAsync(CancellationToken cancellationToken)
    {
        var readiness = await mathEvaluationService.CheckReadinessAsync(cancellationToken);
        var ready = readiness.TypedEvaluatorRegistryReady &&
            readiness.DurableRepositoryConfigured &&
            readiness.DurableRepositoryReachable &&
            readiness.IdempotencyConfigured &&
            readiness.ReplayVerificationReady &&
            readiness.ProductionActivationDisabled;

        return ready
            ? new DependencyHealthResult("math-evaluation-persistence", true)
            : new DependencyHealthResult(
                "math-evaluation-persistence",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckMathEvaluationBatchPersistenceAsync(CancellationToken cancellationToken)
    {
        var readiness = await mathEvaluationBatchService.CheckReadinessAsync(cancellationToken);
        var ready = readiness.BatchRepositoryConfigured &&
            readiness.BatchPersistenceReachable &&
            readiness.BatchRecoveryReady &&
            readiness.ItemIdempotencyReady &&
            readiness.BoundedParallelExecutionReady &&
            readiness.ProductionActivationDisabled;

        return ready
            ? new DependencyHealthResult("math-evaluation-batch-persistence", true)
            : new DependencyHealthResult(
                "math-evaluation-batch-persistence",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckSettlementInputHandoffAsync(CancellationToken cancellationToken)
    {
        var readiness = await settlementInputAdapter.CheckReadinessAsync(cancellationToken);
        var ready = readiness.SettlementHandoffReady &&
            readiness.AdapterReady &&
            readiness.CertificateValidationReady &&
            readiness.CanonicalPayloadReady &&
            readiness.ReplayReady &&
            readiness.RepositoryConfigured &&
            readiness.RepositoryReachable &&
            readiness.ProductionActivationDisabled;

        return ready
            ? new DependencyHealthResult("settlement-input-handoff", true)
            : new DependencyHealthResult(
                "settlement-input-handoff",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckCanonicalOutcomePipelineAsync(CancellationToken cancellationToken)
    {
            var readiness = await canonicalDrawOrchestrator.CheckReadinessAsync(cancellationToken);
        var ready = readiness.DurablePersistenceConfigured &&
            readiness.DurablePersistenceReachable &&
            readiness.ImmutableVersioningReady &&
            readiness.IdempotencyReady &&
            readiness.AdvisoryLockingReady &&
            readiness.OutboxReady &&
            readiness.SettlementRequestEmissionReady &&
            readiness.CanonicalDrawOrchestrationReady &&
            readiness.OutboxDispatcherReady &&
            readiness.WorkerRuntimeReady &&
            readiness.RabbitMqConsumptionReady &&
            readiness.SettlementRequestConsumptionReady &&
            readiness.ReplayProtectionReady &&
            readiness.MissingRequestRecoveryReady &&
            readiness.LegacyPublicationDisabled &&
            readiness.ProductionAuthorityDisabled;

        return ready
            ? new DependencyHealthResult("canonical-outcome-pipeline", true)
            : new DependencyHealthResult(
                "canonical-outcome-pipeline",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckCanonicalOutcomeProviderAuthorityAsync(
        CancellationToken cancellationToken)
    {
        var readiness = await canonicalOutcomeProviderAuthority.CheckReadinessAsync(cancellationToken);
        var ready = readiness.ProviderRegistryReady &&
            readiness.ProviderRegistered &&
            readiness.ProviderVersionResolved &&
            readiness.ConfigurationVersionResolved &&
            readiness.ProviderEvidencePersistenceReady &&
            readiness.ProductionActivationDisabled;

        return ready
            ? new DependencyHealthResult("canonical-outcome-provider-authority", true)
            : new DependencyHealthResult(
                "canonical-outcome-provider-authority",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckInternalCsprngProviderAsync(
        CancellationToken cancellationToken)
    {
        var readiness = await internalCsprngProvider.CheckReadinessAsync(cancellationToken);
        var ready = readiness.ProviderImplementationReady &&
            readiness.OperatingSystemEntropyReady &&
            readiness.StartupSelfTestPassed &&
            readiness.KnownAnswerTestsPassed &&
            readiness.ContinuousTestReady &&
            readiness.GameDefinitionDrivenGenerationReady &&
            readiness.CanonicalEvidencePersistenceReady &&
            readiness.ProductionReady &&
            !readiness.ProductionActive;

        return ready
            ? new DependencyHealthResult("internal-csprng-provider", true)
            : new DependencyHealthResult(
                "internal-csprng-provider",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckProvablyFairRuntimeAsync(CancellationToken cancellationToken)
    {
        var readiness = await provablyFairRuntime.CheckReadinessAsync(cancellationToken);
        var ready = readiness.CommitmentPublicationReady &&
            readiness.NonceAllocatorDurable &&
            readiness.HmacDerivationReady &&
            readiness.ReceiptGenerationReady &&
            readiness.RevealVerificationReady &&
            readiness.ProductionGenerationDisabled;

        return ready
            ? new DependencyHealthResult("provably-fair-runtime", true)
            : new DependencyHealthResult(
                "provably-fair-runtime",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckOfficialResultsProviderAsync(CancellationToken cancellationToken)
    {
        var readiness = await officialResultsProvider.CheckReadinessAsync(cancellationToken);

        return readiness.IsReady
            ? new DependencyHealthResult("official-results-provider", true)
            : new DependencyHealthResult(
                "official-results-provider",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckManualCertifiedProviderAsync(CancellationToken cancellationToken)
    {
        var readiness = await manualCertifiedProvider.CheckReadinessAsync(cancellationToken);

        return readiness.IsReady
            ? new DependencyHealthResult("manual-certified-provider", true)
            : new DependencyHealthResult(
                "manual-certified-provider",
                false,
                string.Join("; ", readiness.Blockers));
    }

    public async Task<DependencyHealthResult> CheckPhysicalDrawRuntimeAsync(CancellationToken cancellationToken)
    {
        var readiness = await physicalDrawRuntime.CheckReadinessAsync(cancellationToken);
        var ready = readiness.AuthorityRepositoryReady &&
            readiness.WitnessValidationReady &&
            readiness.EquipmentValidationReady &&
            readiness.SchemaNormalizationReady &&
            readiness.EvidenceRepositoryReady &&
            readiness.DurableIdempotencyReady &&
            readiness.AdvisoryLockingReady &&
            readiness.ProductionGenerationDisabled;

        return ready
            ? new DependencyHealthResult("physical-draw-runtime", true)
            : new DependencyHealthResult(
                "physical-draw-runtime",
                false,
                string.Join("; ", readiness.Blockers));
    }

    private async Task<DependencyHealthResult> CheckTcpEndpointAsync(
        string name,
        string url,
        int defaultPort,
        CancellationToken cancellationToken)
    {
        try
        {
            var uri = new Uri(url);
            using var client = new TcpClient();
            await client.ConnectAsync(uri.Host, GetPort(uri, defaultPort), cancellationToken);

            return new DependencyHealthResult(name, true);
        }
        catch (Exception error) when (error is UriFormatException or SocketException or IOException or OperationCanceledException)
        {
            logger.LogWarning(error, "{DependencyName} readiness check failed.", name);
            return new DependencyHealthResult(name, false, error.Message);
        }
    }

    private static int GetPort(Uri uri, int defaultPort)
    {
        return uri.IsDefaultPort ? defaultPort : uri.Port;
    }
}
