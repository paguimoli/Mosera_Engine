using CreditWalletService.Configuration;
using CreditWalletService.Contracts;
using CreditWalletService.Infrastructure;

namespace CreditWalletService.Controllers;

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
            var databaseConfigured = !string.IsNullOrWhiteSpace(configuration.Database.Url);
            var databaseReady = databaseConfigured
                ? await readinessChecks.CheckDatabaseAsync(cancellationToken)
                : new DependencyHealthResult("database", true, "DATABASE_URL is not configured; durable reads are disabled.");
            var ready = rabbitMqReady.Ready && redisReady.Ready && databaseReady.Ready;

            var response = new
            {
                status = ready ? "ok" : "error",
                service = configuration.ServiceName,
                timestamp = DateTimeOffset.UtcNow,
                dependencies = new
                {
                    database = databaseReady,
                    rabbitMq = rabbitMqReady,
                    redis = redisReady
                },
                correlationId = context.GetCorrelationId()
            };

            return ready ? Results.Ok(response) : Results.Json(response, statusCode: 503);
        });

        app.MapGet("/v1/credit-wallets/health", async (
            HttpContext context,
            ServiceConfiguration configuration,
            InfrastructureReadinessChecks readinessChecks,
            CancellationToken cancellationToken) =>
        {
            var rabbitMqReady = await readinessChecks.CheckRabbitMqAsync(cancellationToken);
            var redisReady = await readinessChecks.CheckRedisAsync(cancellationToken);
            var databaseConfigured = !string.IsNullOrWhiteSpace(configuration.Database.Url);
            var databaseReady = databaseConfigured
                ? await readinessChecks.CheckDatabaseAsync(cancellationToken)
                : new DependencyHealthResult("database", false, "DATABASE_URL is not configured.");
            var durableReadsReady = databaseConfigured && databaseReady.Ready;
            var reconciliationReady = durableReadsReady;
            var ready = rabbitMqReady.Ready && redisReady.Ready && (!databaseConfigured || databaseReady.Ready);
            var dependencies = new Dictionary<string, string>
            {
                ["database"] = durableReadsReady ? "ready" : "not_configured",
                ["ledgerService"] = "not_configured",
                ["rabbitmq"] = rabbitMqReady.Ready ? "ready" : "not_ready",
                ["redis"] = redisReady.Ready ? "ready" : "not_ready"
            };
            if (databaseConfigured && !databaseReady.Ready)
            {
                dependencies["database"] = "not_ready";
            }

            var response = new CreditWalletHealthResponse(
                ready ? "ok" : "error",
                configuration.ServiceName,
                "0.1.0",
                DateTimeOffset.UtcNow,
                dependencies,
                new CreditWalletCapabilityDto(
                    durableReadsReady,
                    durableReadsReady,
                    reconciliationReady,
                    reconciliationReady ? "reserveReleaseSettleReconcileOnly" : "none",
                    reconciliationReady,
                    reconciliationReady ? "reserveReleaseSettleReconcileOnly" : "none",
                    reconciliationReady ? "credit-wallet-authority-dry-run-baseline" : null,
                    reconciliationReady),
                context.GetCorrelationId());

            return ready ? Results.Ok(response) : Results.Json(response, statusCode: 503);
        });
    }
}
