using CreditWalletService.Application;
using CreditWalletService.Configuration;
using CreditWalletService.Controllers;
using CreditWalletService.Infrastructure;
using CreditWalletService.Middleware;

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
builder.Services.AddSingleton<CreditWalletContractService>();
builder.Services.AddSingleton<CreditShadowCalculator>();
builder.Services.AddSingleton<CreditShadowPersistence>();
builder.Services.AddSingleton<DurableCreditWalletRepository>();

var app = builder.Build();

app.UseMiddleware<CorrelationIdMiddleware>();

app.MapHealthEndpoints();
app.MapCreditWalletEndpoints();

app.Run();
