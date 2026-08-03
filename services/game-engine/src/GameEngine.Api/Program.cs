using GameEngine.Api.Configuration;
using GameEngine.Api.Controllers;
using GameEngine.Api.Infrastructure;
using GameEngine.Api.Middleware;
using GameEngine.Application.Interfaces;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using GameEngine.Infrastructure.Persistence;
using System.Text.Json.Serialization;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options =>
{
    options.IncludeScopes = true;
    options.UseUtcTimestamp = true;
});

var serviceConfiguration = ServiceConfiguration.FromEnvironment(builder.Environment);
var databaseUrl = Environment.GetEnvironmentVariable("DATABASE_URL");
var persistenceMode = string.IsNullOrWhiteSpace(databaseUrl) ? "in-memory" : "postgres";

builder.Services.AddSingleton(serviceConfiguration);
builder.Services.AddSingleton<IOperationalSecurityAuthority>(
    new OperationalSecurityAuthority(databaseUrl));
builder.Services.AddSingleton<IOperationalChangeAuthority>(
    new OperationalChangeAuthority(databaseUrl));
builder.Services.AddSingleton(new GameEngineProductionActivationOptions(
    serviceConfiguration.ProductionActivation.Enabled,
    serviceConfiguration.CanonicalOutcomePipelineEnabled,
    serviceConfiguration.ProductionActivation.SigningEnabled,
    serviceConfiguration.ProductionActivation.SigningProviderId,
    serviceConfiguration.ProductionActivation.SigningProviderVersion,
    serviceConfiguration.ProductionActivation.SigningKeyVersion,
    serviceConfiguration.ProductionActivation.SigningPublicKeyPem));
builder.Services.AddSingleton<InfrastructureReadinessChecks>();
builder.Services.AddSingleton<IGameEngineProductionInfrastructureReadiness, ProductionActivationInfrastructureReadiness>();
builder.Services.AddSingleton<GameModuleRegistry>();
builder.Services.AddSingleton<DrawAuthorityRegistry>();
builder.Services.AddSingleton<RandomnessRegistry>();
builder.Services.AddSingleton<IOsEntropyProvider, AutoOsEntropyProvider>();
builder.Services.AddSingleton<IHmacDrbgRuntime, HmacDrbgRuntime>();
builder.Services.AddSingleton<ICertifiedCsprngSampler, CertifiedCsprngSampler>();
builder.Services.AddSingleton<IProvablyFairClientSeedService, ProvablyFairClientSeedService>();
builder.Services.AddSingleton<ValidationSuite>();
builder.Services.AddSingleton<CertificationSuite>();
builder.Services.AddSingleton<DrawGenerationFramework>();
builder.Services.AddSingleton<DrawSchedulerService>();
builder.Services.AddSingleton<EvaluationOrchestrator>();
builder.Services.AddSingleton<EvaluationRabbitMqDiagnostics>();
builder.Services.AddSingleton<ProvablyFairRuntimeService>();
builder.Services.AddSingleton<PhysicalDrawResultRuntimeService>();
builder.Services.AddSingleton<IOutcomeRuntimeCrashInjector, EnvironmentOutcomeRuntimeCrashInjector>();
builder.Services.AddSingleton<OutcomeRuntimeRecoveryService>();
builder.Services.AddSingleton<CanonicalOutcomeProviderAuthority>();
builder.Services.AddSingleton<InternalCsprngOutcomeProvider>();
builder.Services.AddSingleton<OfficialResultsProvider>();
builder.Services.AddSingleton<ManualCertifiedProvider>();
builder.Services.AddSingleton<IProductionSigningKeyResolver, PemProductionSigningKeyResolver>();
builder.Services.AddSingleton<CertificateVerificationService>();
builder.Services.AddSingleton<IMathEvaluator, KenoMathEvaluator>();
builder.Services.AddSingleton<MathEvaluatorRegistry>();
builder.Services.AddSingleton<MathCertificateEvaluationService>();
builder.Services.AddSingleton<DurableMathEvaluationService>();
builder.Services.AddSingleton<MathEvaluationBatchService>();
builder.Services.AddSingleton<SettlementInputAdapter>();
builder.Services.AddSingleton<CanonicalOutcomeAuthority>();
builder.Services.AddSingleton<CanonicalOutcomeLifecycleAuthority>();
builder.Services.AddSingleton<GameEngineProductionReadinessAuthority>();
builder.Services.AddSingleton<GameEngineProductionActivationAuthority>();
if (string.IsNullOrWhiteSpace(databaseUrl))
{
    builder.Services.AddSingleton<IDrawScheduleRepository, InMemoryDrawScheduleRepository>();
    builder.Services.AddSingleton<IGameModuleRepository, InMemoryGameModuleRepository>();
    builder.Services.AddSingleton<IGameModuleVersionRepository, InMemoryGameModuleVersionRepository>();
    builder.Services.AddSingleton<IGameDefinitionRepository, InMemoryGameDefinitionRepository>();
    builder.Services.AddSingleton<IGameDefinitionVersionRepository, InMemoryGameDefinitionVersionRepository>();
    builder.Services.AddSingleton<IEvaluationRunRepository, InMemoryEvaluationRunRepository>();
    builder.Services.AddSingleton<IEvaluationBatchRepository, InMemoryEvaluationBatchRepository>();
    builder.Services.AddSingleton<IEvaluationRecordRepository, InMemoryEvaluationRecordRepository>();
    builder.Services.AddSingleton<IEvaluationCheckpointRepository, InMemoryEvaluationCheckpointRepository>();
    builder.Services.AddSingleton<IOutcomeRuntimeRequestRepository, InMemoryOutcomeRuntimeRequestRepository>();
    builder.Services.AddSingleton<IOutcomeRuntimeLockManager, InMemoryOutcomeRuntimeLockManager>();
    builder.Services.AddSingleton<IOutcomeRuntimeProvenanceRepository, InMemoryOutcomeRuntimeProvenanceRepository>();
    builder.Services.AddSingleton<IProvablyFairSeedCustodyRepository, InMemoryProvablyFairSeedCustodyRepository>();
    builder.Services.AddSingleton<IProvablyFairNonceAllocator, InMemoryProvablyFairNonceAllocator>();
    builder.Services.AddSingleton<IProvablyFairRuntimeEvidenceRepository, InMemoryProvablyFairRuntimeEvidenceRepository>();
    builder.Services.AddSingleton<IExternalResultSourceRepository, InMemoryExternalResultSourceRepository>();
    builder.Services.AddSingleton<IPhysicalDrawAuthorityRepository, InMemoryPhysicalDrawAuthorityRepository>();
    builder.Services.AddSingleton<IPhysicalDrawEvidenceRepository, InMemoryPhysicalDrawEvidenceRepository>();
    builder.Services.AddSingleton<IMathEvaluationDurableRepository, InMemoryMathEvaluationDurableRepository>();
    builder.Services.AddSingleton<IMathEvaluationBatchRepository, InMemoryMathEvaluationBatchRepository>();
    builder.Services.AddSingleton<ISettlementInputRepository, InMemorySettlementInputRepository>();
    builder.Services.AddSingleton<ICanonicalOutcomeProviderRepository, DisabledCanonicalOutcomeProviderRepository>();
    builder.Services.AddSingleton<ICanonicalOutcomePipelineRepository, DisabledCanonicalOutcomePipelineRepository>();
    builder.Services.AddSingleton<IGameEngineProductionActivationRepository, DisabledGameEngineProductionActivationRepository>();
}
else
{
    builder.Services.AddSingleton<IDrawScheduleRepository>(_ => new PostgresDrawScheduleRepository(databaseUrl));
    builder.Services.AddSingleton<IGameModuleRepository>(_ => new PostgresGameModuleRepository(databaseUrl));
    builder.Services.AddSingleton<IGameModuleVersionRepository>(_ => new PostgresGameModuleVersionRepository(databaseUrl));
    builder.Services.AddSingleton<IGameDefinitionRepository>(_ => new PostgresGameDefinitionRepository(databaseUrl));
    builder.Services.AddSingleton<IGameDefinitionVersionRepository>(_ => new PostgresGameDefinitionVersionRepository(databaseUrl));
    builder.Services.AddSingleton<IEvaluationRunRepository>(_ => new PostgresEvaluationRunRepository(databaseUrl));
    builder.Services.AddSingleton<IEvaluationBatchRepository>(_ => new PostgresEvaluationBatchRepository(databaseUrl));
    builder.Services.AddSingleton<IEvaluationRecordRepository>(_ => new PostgresEvaluationRecordRepository(databaseUrl));
    builder.Services.AddSingleton<IEvaluationCheckpointRepository>(_ => new PostgresEvaluationCheckpointRepository(databaseUrl));
    builder.Services.AddSingleton<IOutcomeRuntimeRequestRepository>(_ => new PostgresOutcomeRuntimeRequestRepository(databaseUrl));
    builder.Services.AddSingleton<IOutcomeRuntimeLockManager>(_ => new PostgresOutcomeRuntimeLockManager(databaseUrl));
    builder.Services.AddSingleton<IOutcomeRuntimeProvenanceRepository>(_ => new PostgresOutcomeRuntimeProvenanceRepository(databaseUrl));
    builder.Services.AddSingleton<IProvablyFairSeedCustodyRepository, InMemoryProvablyFairSeedCustodyRepository>();
    builder.Services.AddSingleton<IProvablyFairNonceAllocator>(_ => new PostgresProvablyFairNonceAllocator(databaseUrl));
    builder.Services.AddSingleton<IProvablyFairRuntimeEvidenceRepository>(_ => new PostgresProvablyFairRuntimeEvidenceRepository(databaseUrl));
    builder.Services.AddSingleton<IExternalResultSourceRepository>(_ => new PostgresExternalResultSourceRepository(databaseUrl));
    builder.Services.AddSingleton<IPhysicalDrawAuthorityRepository>(_ => new PostgresPhysicalDrawAuthorityRepository(databaseUrl));
    builder.Services.AddSingleton<IPhysicalDrawEvidenceRepository>(_ => new PostgresPhysicalDrawEvidenceRepository(databaseUrl));
    builder.Services.AddSingleton<IMathEvaluationDurableRepository>(_ => new PostgresMathEvaluationDurableRepository(databaseUrl));
    builder.Services.AddSingleton<IMathEvaluationBatchRepository>(_ => new PostgresMathEvaluationBatchRepository(databaseUrl));
    builder.Services.AddSingleton<ISettlementInputRepository>(_ => new PostgresSettlementInputRepository(databaseUrl));
    builder.Services.AddSingleton<ICanonicalOutcomeProviderRepository>(
        _ => new PostgresCanonicalOutcomeProviderRepository(databaseUrl));
    builder.Services.AddSingleton<ICanonicalOutcomePipelineRepository>(
        _ => new PostgresCanonicalOutcomePipelineRepository(
            databaseUrl,
            serviceConfiguration.LegacyOutcomePublicationEnabled));
    builder.Services.AddSingleton<IGameEngineProductionActivationRepository>(
        _ => new PostgresGameEngineProductionActivationRepository(databaseUrl));
}

builder.Services.AddSingleton<ITicketReader, DatabaseTicketReader>();
builder.Services.AddSingleton<EvaluationPersistenceService>();
builder.Services.AddSingleton<ISettlementEvaluationReadModel, SettlementEvaluationReadService>();
builder.Services.AddSingleton<SettlementConsumerActivationGate>();
builder.Services.AddSingleton<GameModuleExecutionService>();
builder.Services.AddSingleton<GameEngineStatusService>();
builder.Services.AddHostedService<CanonicalOutcomeRecoveryHostedService>();
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

var app = builder.Build();
app.Logger.LogInformation(
    "Game Engine persistence mode active: {PersistenceMode}",
    persistenceMode);
await app.Services.GetRequiredService<OutcomeRuntimeRecoveryService>()
    .RecordBootAsync(app.Lifetime.ApplicationStopping);

app.UseMiddleware<CorrelationIdMiddleware>();
app.MapGameEngineEndpoints();

app.Run();
