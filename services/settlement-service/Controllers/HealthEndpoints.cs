using SettlementService.Configuration;
using SettlementService.Contracts;
using SettlementService.Infrastructure;
using SettlementService.Application;

namespace SettlementService.Controllers;

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
            SettlementInputIngestionService settlementInputIngestionService,
            SettlementExecutionService settlementExecutionService,
            FinancialInstructionService financialInstructionService,
            SettlementRecoveryService settlementRecoveryService,
            ResettlementService resettlementService,
            SettlementAuthorityService settlementAuthorityService,
            CancellationToken cancellationToken) =>
        {
            var rabbitMqReady = await readinessChecks.CheckRabbitMqAsync(cancellationToken);
            var redisReady = await readinessChecks.CheckRedisAsync(cancellationToken);
            var databaseConfigured = !string.IsNullOrWhiteSpace(configuration.Database.Url);
            var databaseReady = databaseConfigured
                ? await readinessChecks.CheckDatabaseAsync(cancellationToken)
                : new DependencyHealthResult("database", false, "DATABASE_URL is not configured.");
            var durablePersistenceReady = databaseConfigured && databaseReady.Ready;
            var settlementInputIngestionReady = await settlementInputIngestionService.CheckReadinessAsync(cancellationToken);
            var settlementExecutionReady = await settlementExecutionService.CheckReadinessAsync(cancellationToken);
            var financialInstructionsReady = await financialInstructionService.CheckReadinessAsync(cancellationToken);
            var settlementRecoveryReady = await settlementRecoveryService.CheckReadinessAsync(cancellationToken);
            var resettlementReady = await resettlementService.CheckReadinessAsync(cancellationToken);
            var settlementAuthorityReady = await settlementAuthorityService.BuildReadinessReportAsync(null, cancellationToken);
            var dependencies = new Dictionary<string, string>
            {
                ["database"] = durablePersistenceReady ? "ready" : databaseConfigured ? "not_ready" : "not_configured",
                ["settlementInputIngestion"] = settlementInputIngestionReady.RepositoryReachable ? "ready" : "not_ready",
                ["settlementExecution"] = settlementExecutionReady.RepositoryReachable ? "ready" : "not_ready",
                ["financialInstructions"] = financialInstructionsReady.RepositoryReachable ? "ready" : "not_ready",
                ["settlementRecovery"] = settlementRecoveryReady.RepositoryReachable ? "ready" : "not_ready",
                ["resettlement"] = resettlementReady.RepositoryReachable ? "ready" : "not_ready",
                ["rabbitmq"] = rabbitMqReady.Ready ? "ready" : "not_ready",
                ["redis"] = redisReady.Ready ? "ready" : "not_ready"
            };
            var ready = rabbitMqReady.Ready &&
                redisReady.Ready &&
                (!databaseConfigured || databaseReady.Ready) &&
                (!databaseConfigured || settlementInputIngestionReady.RepositoryReachable) &&
                (!databaseConfigured || settlementExecutionReady.RepositoryReachable) &&
                (!databaseConfigured || financialInstructionsReady.RepositoryReachable) &&
                (!databaseConfigured || settlementRecoveryReady.RepositoryReachable) &&
                (!databaseConfigured || resettlementReady.RepositoryReachable);

            var response = new SettlementHealthResponse(
                ready ? "ok" : "error",
                configuration.ServiceName,
                "0.1.0",
                DateTimeOffset.UtcNow,
                dependencies,
                new SettlementPersistenceCapabilityDto(
                    durablePersistenceReady,
                    false,
                    durablePersistenceReady,
                    durablePersistenceReady ? "integrationDryRunOnly" : "none",
                    durablePersistenceReady ? "settlement-service-integration-dry-run" : null,
                    durablePersistenceReady,
                    durablePersistenceReady,
                    durablePersistenceReady,
                    durablePersistenceReady,
                    durablePersistenceReady,
                    durablePersistenceReady
                        ? [
                            "settlement-service-durable-baseline",
                            "settlement-service-execution-dry-run",
                            "settlement-service-integration-dry-run",
                            "settlement-service-recovery-resume",
                            "settlement-service-resettlement-dry-run",
                            "settlement-service-authority-switch",
                            "settlement-input-ingestion",
                            "settlement-execution",
                            "financial-instruction-generation",
                            "financial-instruction-execution",
                            "financial-instruction-partial-failure",
                            "financial-instruction-target-idempotency",
                            "settlement-recovery",
                            "settlement-resume",
                            "instruction-reconciliation",
                            "unknown-result-recovery",
                            "resettlement-request",
                            "resettlement-reversal",
                            "resettlement-correction",
                            "resettlement-recovery",
                            "resettlement-idempotency"
                        ]
                        : []),
                settlementInputIngestionReady,
                settlementExecutionReady,
                financialInstructionsReady,
                settlementRecoveryReady,
                resettlementReady,
                settlementAuthorityReady,
                context.GetCorrelationId());

            return ready ? Results.Ok(response) : Results.Json(response, statusCode: 503);
        });
    }
}
