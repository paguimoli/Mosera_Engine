using System.Text.Json.Serialization;
using AuthService.Application;
using AuthService.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<AuthArchitectureService>();
builder.Services.AddSingleton<AuthInfrastructureStatusProvider>();
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    service = "auth-service",
    productionAuthenticationEnabled = false,
    timestamp = DateTimeOffset.UtcNow
}));

app.MapGet("/ready", (AuthInfrastructureStatusProvider infrastructure) => Results.Ok(new
{
    status = "ready",
    service = "auth-service",
    architectureOnly = true,
    infrastructure = infrastructure.GetStatus(),
    timestamp = DateTimeOffset.UtcNow
}));

var group = app.MapGroup("/api/auth-service");

group.MapGet("/status", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetStatus()
}));

group.MapGet("/identity-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetIdentityModel()
}));

group.MapGet("/oauth-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetOAuthModel()
}));

group.MapGet("/policy-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetPolicyModel()
}));

app.Run();
