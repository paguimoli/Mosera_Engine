using GamingEngine.Application;
using GamingEngine.Domain;
using GamingEngine.Infrastructure;
using Microsoft.OpenApi.Models;
using System.Text.Json.Serialization;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options =>
{
    options.IncludeScopes = true;
    options.UseUtcTimestamp = true;
});

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(options =>
{
    options.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "Gaming Engine API",
        Version = "v1"
    });
});
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});
builder.Services.AddSingleton<IRandomNumberGenerator, CryptoRandomNumberGenerator>();
builder.Services.AddSingleton<IGameEngineRegistry, GameEngineRegistry>();
builder.Services.AddSingleton<NumberSetEngine>();

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/swagger/v1/swagger.json", "Gaming Engine API v1");
});

app.MapGet("/api/engines", (IGameEngineRegistry registry) =>
    Results.Ok(registry.GetAvailableEngines().Select(EngineMetadataResponse.FromDefinition)))
.WithName("GetEngines");

app.MapGet("/api/engines/{engineType}", (string engineType, IGameEngineRegistry registry) =>
{
    if (!TryParseEngineType(engineType, out var parsedEngineType))
    {
        return Results.NotFound(new ValidationProblemResponse($"Unknown engine type '{engineType}'."));
    }

    try
    {
        var definition = registry.GetByType(parsedEngineType);
        return Results.Ok(EngineMetadataResponse.FromDefinition(definition));
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound(new ValidationProblemResponse($"Unknown engine type '{engineType}'."));
    }
})
.WithName("GetEngineByType");

app.MapPost("/api/engines/number-set/draw", (NumberSetDrawRequest request, NumberSetEngine engine) =>
{
    try
    {
        var result = engine.Draw(new DrawRequest(
            request.MinNumber,
            request.MaxNumber,
            request.NumbersToDraw,
            request.CorrelationId));

        return Results.Ok(new EngineDrawResponse<NumberSetResult>(
            result.EngineType,
            result.EngineVersion,
            result.ResultType,
            result.NumberSetResult,
            result.GeneratedAtUtc,
            result.CorrelationId));
    }
    catch (ArgumentException exception)
    {
        return Results.BadRequest(new ValidationProblemResponse(exception.Message));
    }
})
.WithName("DrawNumberSet");

app.MapGet("/health", () => Results.Ok(new { status = "UP", service = "gaming-engine" }))
    .WithName("Health");

app.MapGet("/health/live", () => Results.Ok(new HealthResponse("UP", "gaming-engine", "live")))
    .WithName("Liveness");

app.MapGet("/health/ready", () => Results.Ok(new HealthResponse("UP", "gaming-engine", "ready")))
    .WithName("Readiness");

app.Run();

static bool TryParseEngineType(string value, out EngineType engineType)
{
    if (string.Equals(value, "number-set", StringComparison.OrdinalIgnoreCase))
    {
        engineType = EngineType.NumberSet;
        return true;
    }

    return Enum.TryParse(value, ignoreCase: true, out engineType);
}

public partial class Program;

public sealed record NumberSetDrawRequest(
    int MinNumber,
    int MaxNumber,
    int NumbersToDraw,
    string CorrelationId);

public sealed record ValidationProblemResponse(string Error);

public sealed record HealthResponse(string Status, string Service, string Check);

public sealed record EngineMetadataResponse(
    EngineType EngineType,
    string Name,
    string Version,
    string Description,
    bool SupportsMetrics,
    bool SupportsMarketEvaluation)
{
    public static EngineMetadataResponse FromDefinition(GameEngineDefinition definition)
    {
        return new EngineMetadataResponse(
            definition.EngineType,
            definition.Name,
            definition.Version,
            definition.Description,
            definition.SupportsMetrics,
            definition.SupportsMarketEvaluation);
    }
}
