using GameEngine.Api.Configuration;
using GameEngine.Api.Controllers;
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
builder.Services.AddSingleton<GameModuleRegistry>();
builder.Services.AddSingleton<DrawAuthorityRegistry>();
builder.Services.AddSingleton<RandomnessRegistry>();
builder.Services.AddSingleton<ValidationSuite>();
builder.Services.AddSingleton<CertificationSuite>();
builder.Services.AddSingleton<DrawGenerationFramework>();
builder.Services.AddSingleton<DrawSchedulerService>();
builder.Services.AddSingleton<EvaluationOrchestrator>();
builder.Services.AddSingleton<EvaluationRabbitMqDiagnostics>();
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

app.UseMiddleware<CorrelationIdMiddleware>();
app.MapGameEngineEndpoints();

app.Run();
