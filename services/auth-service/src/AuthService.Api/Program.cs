using System.Text.Json.Serialization;
using AuthService.Application;
using AuthService.Application.Services;
using AuthService.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<AuthArchitectureService>();
builder.Services.AddSingleton<AuthInfrastructureStatusProvider>();
builder.Services.AddSingleton<IdentityMappingService>();
builder.Services.AddSingleton<ShadowValidationService>();
builder.Services.AddHttpClient<SupabaseLegacyPlatformIdentitySource>();
builder.Services.AddSingleton<ILegacyPlatformIdentitySource>(services =>
{
    var source = services.GetRequiredService<SupabaseLegacyPlatformIdentitySource>();
    return source.Configured ? source : new EmptyLegacyPlatformIdentitySource();
});
builder.Services.AddSingleton<ShadowIdentityImportService>();
builder.Services.AddSingleton<MigrationReadinessService>();
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

app.MapGet("/health/live", () => Results.Ok(new
{
    status = "ok",
    service = "auth-service",
    check = "live",
    timestamp = DateTimeOffset.UtcNow
}));

object ReadyResponse(AuthInfrastructureStatusProvider infrastructure) => new
{
    status = "ready",
    service = "auth-service",
    architectureOnly = true,
    infrastructure = infrastructure.GetStatus(),
    timestamp = DateTimeOffset.UtcNow
};

app.MapGet("/ready", (AuthInfrastructureStatusProvider infrastructure) => Results.Ok(ReadyResponse(infrastructure)));
app.MapGet("/health/ready", (AuthInfrastructureStatusProvider infrastructure) => Results.Ok(ReadyResponse(infrastructure)));

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

group.MapGet("/oauth-model/runtime", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetOAuthRuntimeModel()
}));

group.MapGet("/policy-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetPolicyModel()
}));

group.MapGet("/session-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetSessionModel()
}));

group.MapGet("/token-issuance-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetTokenIssuanceModel()
}));

group.MapGet("/jwks-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetJwksModel()
}));

group.MapGet("/service-auth-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetServiceAuthModel()
}));

group.MapGet("/session-readiness", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetSessionReadiness()
}));

group.MapGet("/token-readiness", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetTokenReadiness()
}));

group.MapGet("/oauth-readiness", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetOAuthReadiness()
}));

group.MapGet("/persistence-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetPersistenceModel()
}));

group.MapGet("/credential-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetCredentialModel()
}));

group.MapGet("/credential-verification-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetCredentialVerificationModel()
}));

group.MapGet("/password-policy", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetPasswordPolicy()
}));

group.MapGet("/mfa-policy", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetMfaPolicy()
}));

group.MapGet("/authentication-eligibility", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetAuthenticationEligibility()
}));

group.MapGet("/credential-verifiers", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetCredentialVerifiers()
}));

group.MapGet("/token-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetTokenModel()
}));

group.MapGet("/migration-readiness", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetMigrationReadiness()
}));

group.MapGet("/migration-plan", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetMigrationPlan()
}));

group.MapGet("/coexistence-status", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetCoexistenceStatus()
}));

group.MapGet("/compatibility-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetCompatibilityModel()
}));

group.MapGet("/schema-status", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetSchemaStatus()
}));

group.MapGet("/shadow-import-status", async (ShadowIdentityImportService service, CancellationToken cancellationToken) => Results.Ok(new
{
    success = true,
    data = await service.GetStatusAsync(cancellationToken)
}));

group.MapGet("/migration-validation", async (MigrationReadinessService service, CancellationToken cancellationToken) => Results.Ok(new
{
    success = true,
    data = await service.ValidateAsync(cancellationToken)
}));

group.MapGet("/migration-report", async (MigrationReadinessService service, CancellationToken cancellationToken) => Results.Ok(new
{
    success = true,
    data = await service.BuildReportAsync(cancellationToken)
}));

group.MapPost("/shadow-import/run", async (ShadowIdentityImportService service, CancellationToken cancellationToken) => Results.Ok(new
{
    success = true,
    data = await service.RunAsync(cancellationToken)
}));

app.Run();
