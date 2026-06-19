using SettlementService.Application;
using SettlementService.Configuration;
using SettlementService.Controllers;
using SettlementService.Infrastructure;
using SettlementService.Middleware;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options =>
{
    options.IncludeScopes = true;
    options.UseUtcTimestamp = true;
});

var serviceConfiguration = ServiceConfiguration.FromEnvironment(builder.Environment);

builder.Services.AddSingleton(serviceConfiguration);
builder.Services.AddHttpClient();
builder.Services.AddSingleton<InfrastructureReadinessChecks>();
builder.Services.AddSingleton<SettlementShadowPersistence>();
builder.Services.AddSingleton<ShadowSettlementCalculator>();

var app = builder.Build();

app.UseMiddleware<CorrelationIdMiddleware>();

app.MapHealthEndpoints();
app.MapSettlementShadowEndpoints();

app.Run();
