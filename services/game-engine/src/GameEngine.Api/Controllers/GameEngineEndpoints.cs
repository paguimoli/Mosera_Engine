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

        group.MapGet("/modules", (HttpContext context, GameEngineStatusService statusService) =>
        {
            return Results.Ok(new
            {
                success = true,
                modules = statusService.ListModules(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-authorities", (HttpContext context, GameEngineStatusService statusService) =>
        {
            return Results.Ok(new
            {
                success = true,
                drawAuthorities = statusService.ListDrawAuthorities(),
                approvalWorkflow = "required_before_production_use",
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
                correlationId = context.GetCorrelationId()
            });
        });
    }
}
