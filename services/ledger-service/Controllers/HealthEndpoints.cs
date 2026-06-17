using LedgerService.Configuration;
using LedgerService.Contracts;
using LedgerService.Infrastructure;

namespace LedgerService.Controllers;

public static class HealthEndpoints
{
    public static void MapHealthEndpoints(this WebApplication app)
    {
        app.MapGet("/health", (HttpContext context, ServiceConfiguration configuration) =>
        {
            return Results.Ok(new
            {
                status = "ok",
                service = configuration.ServiceName,
                environment = configuration.Environment,
                timestamp = DateTimeOffset.UtcNow,
                correlationId = context.GetCorrelationId()
            });
        });

        app.MapGet("/health/live", (HttpContext context, ServiceConfiguration configuration) =>
        {
            return Results.Ok(new
            {
                status = "ok",
                service = configuration.ServiceName,
                timestamp = DateTimeOffset.UtcNow,
                correlationId = context.GetCorrelationId()
            });
        });

        app.MapGet("/health/ready", async (
            HttpContext context,
            ServiceConfiguration configuration,
            InfrastructureReadinessChecks readinessChecks,
            CancellationToken cancellationToken) =>
        {
            var rabbitMqReady = await readinessChecks.CheckRabbitMqAsync(cancellationToken);
            var redisReady = await readinessChecks.CheckRedisAsync(cancellationToken);
            var ready = rabbitMqReady.Ready && redisReady.Ready;

            var response = new
            {
                status = ready ? "ok" : "error",
                service = configuration.ServiceName,
                timestamp = DateTimeOffset.UtcNow,
                dependencies = new
                {
                    rabbitMq = rabbitMqReady,
                    redis = redisReady
                },
                correlationId = context.GetCorrelationId()
            };

            return ready ? Results.Ok(response) : Results.Json(response, statusCode: 503);
        });

        app.MapGet("/v1/ledger/health", async (
            HttpContext context,
            ServiceConfiguration configuration,
            InfrastructureReadinessChecks readinessChecks,
            CancellationToken cancellationToken) =>
        {
            var rabbitMqReady = await readinessChecks.CheckRabbitMqAsync(cancellationToken);
            var redisReady = await readinessChecks.CheckRedisAsync(cancellationToken);
            var dependencies = new Dictionary<string, string>
            {
                ["database"] = "not_configured",
                ["rabbitmq"] = rabbitMqReady.Ready ? "ready" : "not_ready",
                ["redis"] = redisReady.Ready ? "ready" : "not_ready"
            };
            var ready = rabbitMqReady.Ready && redisReady.Ready;

            var response = new LedgerHealthResponse(
                ready ? "ok" : "error",
                configuration.ServiceName,
                "0.1.0",
                DateTimeOffset.UtcNow,
                dependencies,
                context.GetCorrelationId());

            return ready ? Results.Ok(response) : Results.Json(response, statusCode: 503);
        });
    }
}
