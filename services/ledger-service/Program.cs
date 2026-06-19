using LedgerService.Application;
using LedgerService.Configuration;
using LedgerService.Controllers;
using LedgerService.Infrastructure;
using LedgerService.Middleware;

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
builder.Services.AddSingleton<LedgerContractService>();
builder.Services.AddSingleton<LedgerShadowCalculator>();
builder.Services.AddSingleton<LedgerShadowPersistence>();

var app = builder.Build();

app.UseMiddleware<CorrelationIdMiddleware>();

app.MapHealthEndpoints();
app.MapLedgerEndpoints();

app.Run();
