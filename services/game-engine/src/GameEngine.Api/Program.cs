using GameEngine.Api.Configuration;
using GameEngine.Api.Controllers;
using GameEngine.Api.Middleware;
using GameEngine.Application.Services;
using System.Text.Json.Serialization;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options =>
{
    options.IncludeScopes = true;
    options.UseUtcTimestamp = true;
});

var serviceConfiguration = ServiceConfiguration.FromEnvironment(builder.Environment);

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
builder.Services.AddSingleton<IEvaluationRecordRepository, InMemoryEvaluationRecordRepository>();
builder.Services.AddSingleton<ITicketReader, DatabaseTicketReader>();
builder.Services.AddSingleton<EvaluationPersistenceService>();
builder.Services.AddSingleton<GameModuleExecutionService>();
builder.Services.AddSingleton<GameEngineStatusService>();
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

var app = builder.Build();

app.UseMiddleware<CorrelationIdMiddleware>();
app.MapGameEngineEndpoints();

app.Run();
