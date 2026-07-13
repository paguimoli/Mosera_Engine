using GameEngine.Api.Configuration;
using GameEngine.Api.Controllers;
using GameEngine.Api.Infrastructure;
using GameEngine.Api.Middleware;
using GameEngine.Application.Interfaces;
using GameEngine.Application.Services;
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
builder.Services.AddSingleton<InfrastructureReadinessChecks>();
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
builder.Services.AddSingleton<IOutcomeProviderResolver, OutcomeProviderResolver>();
builder.Services.AddSingleton<IOutcomeProviderRuntime, CertifiedCsprngOutcomeProviderRuntime>();
builder.Services.AddSingleton<IOutcomeProviderRuntime, ProvablyFairOutcomeProviderRuntime>();
builder.Services.AddSingleton<IOutcomeProviderRuntime, ExternalOfficialResultOutcomeProviderRuntime>();
builder.Services.AddSingleton<IOutcomeProviderRuntime, PhysicalDrawResultOutcomeProviderRuntime>();
builder.Services.AddSingleton<IOutcomeProviderRuntime, SimulationTestOutcomeProviderRuntime>();
builder.Services.AddSingleton<ProvablyFairRuntimeService>();
builder.Services.AddSingleton<ExternalOfficialResultRuntimeService>();
builder.Services.AddSingleton<PhysicalDrawResultRuntimeService>();
builder.Services.AddSingleton<IOutcomeRuntimeCrashInjector, EnvironmentOutcomeRuntimeCrashInjector>();
builder.Services.AddSingleton<OutcomeRuntimeRecoveryService>();
builder.Services.AddSingleton<OutcomeProviderOrchestrationService>();
builder.Services.AddSingleton<IMathEvaluator, KenoMathEvaluator>();
builder.Services.AddSingleton<MathEvaluatorRegistry>();
builder.Services.AddSingleton<MathCertificateEvaluationService>();
builder.Services.AddSingleton<DurableMathEvaluationService>();
builder.Services.AddSingleton<MathEvaluationBatchService>();
builder.Services.AddSingleton<SettlementInputAdapter>();
if (string.IsNullOrWhiteSpace(databaseUrl))
{
    builder.Services.AddSingleton<IDrawScheduleRepository, InMemoryDrawScheduleRepository>();
    builder.Services.AddSingleton<IDrawAuthorityRepository, InMemoryDrawAuthorityRepository>();
    builder.Services.AddSingleton<IDrawAuthorityVersionRepository, InMemoryDrawAuthorityVersionRepository>();
    builder.Services.AddSingleton<IDrawAuthorityAssignmentRepository, InMemoryDrawAuthorityAssignmentRepository>();
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
    builder.Services.AddSingleton<ICertifiedCsprngEvidenceRepository, InMemoryCertifiedCsprngEvidenceRepository>();
    builder.Services.AddSingleton<IProvablyFairSeedCustodyRepository, InMemoryProvablyFairSeedCustodyRepository>();
    builder.Services.AddSingleton<IProvablyFairNonceAllocator, InMemoryProvablyFairNonceAllocator>();
    builder.Services.AddSingleton<IProvablyFairRuntimeEvidenceRepository, InMemoryProvablyFairRuntimeEvidenceRepository>();
    builder.Services.AddSingleton<IExternalResultSourceRepository, InMemoryExternalResultSourceRepository>();
    builder.Services.AddSingleton<IExternalResultEvidenceRepository, InMemoryExternalResultEvidenceRepository>();
    builder.Services.AddSingleton<IPhysicalDrawAuthorityRepository, InMemoryPhysicalDrawAuthorityRepository>();
    builder.Services.AddSingleton<IPhysicalDrawEvidenceRepository, InMemoryPhysicalDrawEvidenceRepository>();
    builder.Services.AddSingleton<IMathEvaluationDurableRepository, InMemoryMathEvaluationDurableRepository>();
    builder.Services.AddSingleton<IMathEvaluationBatchRepository, InMemoryMathEvaluationBatchRepository>();
    builder.Services.AddSingleton<ISettlementInputRepository, InMemorySettlementInputRepository>();
}
else
{
    builder.Services.AddSingleton<IDrawScheduleRepository>(_ => new PostgresDrawScheduleRepository(databaseUrl));
    builder.Services.AddSingleton<IDrawAuthorityRepository>(_ => new PostgresDrawAuthorityRepository(databaseUrl));
    builder.Services.AddSingleton<IDrawAuthorityVersionRepository>(_ => new PostgresDrawAuthorityVersionRepository(databaseUrl));
    builder.Services.AddSingleton<IDrawAuthorityAssignmentRepository>(_ => new PostgresDrawAuthorityAssignmentRepository(databaseUrl));
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
    builder.Services.AddSingleton<ICertifiedCsprngEvidenceRepository>(_ => new PostgresCertifiedCsprngEvidenceRepository(databaseUrl));
    builder.Services.AddSingleton<IProvablyFairSeedCustodyRepository, InMemoryProvablyFairSeedCustodyRepository>();
    builder.Services.AddSingleton<IProvablyFairNonceAllocator>(_ => new PostgresProvablyFairNonceAllocator(databaseUrl));
    builder.Services.AddSingleton<IProvablyFairRuntimeEvidenceRepository>(_ => new PostgresProvablyFairRuntimeEvidenceRepository(databaseUrl));
    builder.Services.AddSingleton<IExternalResultSourceRepository>(_ => new PostgresExternalResultSourceRepository(databaseUrl));
    builder.Services.AddSingleton<IExternalResultEvidenceRepository>(_ => new PostgresExternalResultEvidenceRepository(databaseUrl));
    builder.Services.AddSingleton<IPhysicalDrawAuthorityRepository>(_ => new PostgresPhysicalDrawAuthorityRepository(databaseUrl));
    builder.Services.AddSingleton<IPhysicalDrawEvidenceRepository>(_ => new PostgresPhysicalDrawEvidenceRepository(databaseUrl));
    builder.Services.AddSingleton<IMathEvaluationDurableRepository>(_ => new PostgresMathEvaluationDurableRepository(databaseUrl));
    builder.Services.AddSingleton<IMathEvaluationBatchRepository>(_ => new PostgresMathEvaluationBatchRepository(databaseUrl));
    builder.Services.AddSingleton<ISettlementInputRepository>(_ => new PostgresSettlementInputRepository(databaseUrl));
}

builder.Services.AddSingleton<ITicketReader, DatabaseTicketReader>();
builder.Services.AddSingleton<EvaluationPersistenceService>();
builder.Services.AddSingleton<ISettlementEvaluationReadModel, SettlementEvaluationReadService>();
builder.Services.AddSingleton<SettlementConsumerActivationGate>();
builder.Services.AddSingleton<GameModuleExecutionService>();
builder.Services.AddSingleton<GameEngineStatusService>();
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
