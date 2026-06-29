using GameEngine.Api.Configuration;
using GameEngine.Api.Controllers;
using GameEngine.Api.Middleware;
using GameEngine.Application.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options =>
{
    options.IncludeScopes = true;
    options.UseUtcTimestamp = true;
});

var serviceConfiguration = ServiceConfiguration.FromEnvironment(builder.Environment);

builder.Services.AddSingleton(serviceConfiguration);
builder.Services.AddSingleton<GameEngineStatusService>();

var app = builder.Build();

app.UseMiddleware<CorrelationIdMiddleware>();
app.MapGameEngineEndpoints();

app.Run();
