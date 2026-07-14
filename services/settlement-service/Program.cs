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
builder.Services.AddSingleton<DurableSettlementRepository>();
builder.Services.AddSingleton<SettlementInputIngestionRepository>();
builder.Services.AddSingleton<SettlementExecutionRepository>();
builder.Services.AddSingleton<FinancialInstructionRepository>();
builder.Services.AddSingleton<ResettlementRepository>();
builder.Services.AddSingleton<SettlementPromotionRepository>();
builder.Services.AddSingleton<SettlementLedgerServiceClient>();
builder.Services.AddSingleton<SettlementCreditWalletServiceClient>();
builder.Services.AddSingleton<ShadowSettlementCalculator>();
builder.Services.AddSingleton<SettlementInputIngestionService>();
builder.Services.AddSingleton<SettlementExecutionService>();
builder.Services.AddSingleton<FinancialInstructionService>();
builder.Services.AddSingleton<FinancialInstructionExecutionService>();
builder.Services.AddSingleton<SettlementRecoveryService>();
builder.Services.AddSingleton<ResettlementService>();
builder.Services.AddSingleton<SettlementAuthorityService>();

var app = builder.Build();

app.UseMiddleware<CorrelationIdMiddleware>();

app.MapHealthEndpoints();
app.MapSettlementShadowEndpoints();
app.MapSettlementPersistenceEndpoints();
app.MapSettlementInputIngestionEndpoints();
app.MapSettlementExecutionEndpoints();
app.MapFinancialInstructionEndpoints();
app.MapSettlementRecoveryEndpoints();
app.MapResettlementEndpoints();
app.MapSettlementAuthorityEndpoints();

app.Run();
