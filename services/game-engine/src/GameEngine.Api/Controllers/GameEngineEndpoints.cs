using GameEngine.Api.Configuration;
using GameEngine.Application.Services;

namespace GameEngine.Api.Controllers;

public static class GameEngineEndpoints
{
    public static void MapGameEngineEndpoints(this WebApplication app)
    {
        app.MapGet("/health", (HttpContext context, ServiceConfiguration configuration) =>
        {
            return Results.Ok(new
            {
                status = "ok",
                service = configuration.ServiceName,
                environment = configuration.Environment,
                productionGameLogicEnabled = false,
                timestamp = DateTimeOffset.UtcNow,
                correlationId = context.GetCorrelationId()
            });
        });

        app.MapGet("/ready", (HttpContext context, ServiceConfiguration configuration) =>
        {
            return Results.Ok(new
            {
                status = "ready",
                service = configuration.ServiceName,
                schema = configuration.Schema.SchemaName,
                messaging = "not_wired",
                database = "schema_draft_only",
                timestamp = DateTimeOffset.UtcNow,
                correlationId = context.GetCorrelationId()
            });
        });

        var group = app.MapGroup("/api/game-engine");

        group.MapGet("/status", (HttpContext context, GameEngineStatusService statusService) =>
        {
            return Results.Ok(new
            {
                success = true,
                data = statusService.GetStatus(),
                authBoundary = "admin_placeholder",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/modules", (HttpContext context, GameModuleRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                modules = registry.GetRegisteredModules().Select(ToModuleDiagnostic),
                inactiveModules = registry.GetInactiveModules(),
                productionReadyModules = registry.GetProductionReadyModules(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/modules/{id}", (string id, HttpContext context, GameModuleRegistry registry) =>
        {
            var module = registry.GetModule(id);
            return module is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Game module not found.",
                    moduleId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    module,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/modules/{id}/versions", (string id, HttpContext context, GameModuleRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                moduleId = id,
                versions = registry.GetModuleVersions(id),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/game-bindings", (HttpContext context, GameModuleRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                gameBindings = registry.GetGameBindings(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/game-bindings/{id:guid}", (Guid id, HttpContext context, GameModuleRegistry registry) =>
        {
            var binding = registry.GetGameBinding(id);
            return binding is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Game binding not found.",
                    gameBindingId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    gameBinding = binding,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/registry-status", (HttpContext context, GameModuleRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                registryStatus = registry.GetRegistryStatus(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-authorities", (HttpContext context, DrawAuthorityRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                drawAuthorities = registry.GetRegisteredAuthorities(),
                providers = registry.GetProviders(),
                approvalWorkflow = "required_before_production_use",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-authorities/{id:guid}", (Guid id, HttpContext context, DrawAuthorityRegistry registry) =>
        {
            var authority = registry.GetAuthority(id);
            return authority is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Draw Authority not found.",
                    drawAuthorityId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    drawAuthority = authority,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/draw-authorities/{id:guid}/versions", (Guid id, HttpContext context, DrawAuthorityRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                drawAuthorityId = id,
                versions = registry.GetAuthorityVersions(id),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-authorities/{id:guid}/health", (Guid id, HttpContext context, DrawAuthorityRegistry registry) =>
        {
            var authority = registry.GetAuthority(id);
            return authority is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Draw Authority not found.",
                    drawAuthorityId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    drawAuthorityId = id,
                    providerHealth = authority.ProviderHealth,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/draw-authority-registry-status", (HttpContext context, DrawAuthorityRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                registryStatus = registry.GetRegistryStatus(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-result-submissions", (HttpContext context, DrawAuthorityRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                drawResultSubmissions = registry.GetResultSubmissions(),
                immutable = true,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/official-certified-results", (HttpContext context, DrawAuthorityRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                officialCertifiedResults = registry.GetOfficialCertifiedResults(),
                settlementIntegrationEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-runs", (HttpContext context, GameEngineStatusService statusService) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationRuns = statusService.ListEvaluationRuns(),
                checkpointProcessing = "planned",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapPost("/evaluation-runs/{id:guid}/retry", (Guid id, HttpContext context) =>
        {
            return Results.Accepted(value: new
            {
                success = true,
                evaluationRunId = id,
                action = "retry_placeholder",
                mutationPerformed = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapPost("/draw-authorities/{id:guid}/approve", (Guid id, HttpContext context) =>
        {
            return Results.Accepted(value: new
            {
                success = true,
                drawAuthorityId = id,
                action = "approval_placeholder",
                productionUseEnabled = false,
                authBoundary = "admin_placeholder",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapPost("/manual-results", (HttpContext context) =>
        {
            return Results.Accepted(value: new
            {
                success = true,
                action = "manual_result_submission_placeholder",
                officialCertifiedResultCreated = false,
                authBoundary = "admin_placeholder",
                correlationId = context.GetCorrelationId()
            });
        });
    }

    private static object ToModuleDiagnostic(GameEngine.Domain.Model.GameModuleRegistryEntry entry)
    {
        return new
        {
            manifest = new
            {
                moduleId = entry.ModuleId,
                moduleName = entry.ModuleName,
                moduleVersion = entry.ModuleVersion,
                gameTypes = entry.SupportedGameTypes,
                supportedWagerTypes = entry.SupportedWagerTypes,
                supportedDrawAuthorityTypes = entry.SupportedDrawAuthorities,
                supportsInternalDrawGeneration = entry.DrawGenerationCapability,
                configurationSchemaVersion = entry.ConfigurationSchemaVersion,
                lifecycleStatus = entry.LifecycleStatus
            },
            healthStatus = entry.HealthStatus,
            approvalStatus = entry.ApprovalStatus,
            productionReady = entry.ProductionReady,
            loadedAssembly = entry.LoadedAssembly,
            loadTimestamp = entry.LoadTimestamp,
            registrationStatus = entry.RegistrationStatus,
            validation = entry.Validation,
            lifecycleGateBlockers = entry.LifecycleGateBlockers,
            lifecycleGateWarnings = entry.LifecycleGateWarnings
        };
    }
}
