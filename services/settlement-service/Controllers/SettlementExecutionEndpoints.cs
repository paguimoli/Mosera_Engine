using SettlementService.Application;
using SettlementService.Contracts;

namespace SettlementService.Controllers;

public static class SettlementExecutionEndpoints
{
    public static void MapSettlementExecutionEndpoints(this WebApplication app)
    {
        app.MapPost("/v1/settlement/requests/{settlementRequestId:guid}/execute", async (
            Guid settlementRequestId,
            SettlementExecutionRequest request,
            SettlementExecutionService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var effectiveRequest = request with { SettlementRequestId = settlementRequestId };
                var result = await service.ExecuteAsync(effectiveRequest, context.GetCorrelationId(), cancellationToken);
                return Results.Ok(result);
            }
            catch (SettlementExecutionConflictException error)
            {
                return Results.Conflict(new
                {
                    code = "SETTLEMENT_EXECUTION_CONFLICT",
                    message = error.Message,
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (SettlementExecutionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "SETTLEMENT_EXECUTION_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException error)
            {
                context.RequestServices.GetRequiredService<ILoggerFactory>()
                    .CreateLogger("SettlementExecutionEndpoints")
                    .LogWarning(error, "Settlement execution unavailable.");
                return Results.Json(new
                {
                    code = "SETTLEMENT_EXECUTION_UNAVAILABLE",
                    message = error.Message,
                    correlationId = context.GetCorrelationId()
                }, statusCode: 503);
            }
        });

        app.MapPost("/v1/settlement/requests/{settlementRequestId:guid}/replay", async (
            Guid settlementRequestId,
            SettlementExecutionService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var result = await service.ReplayAsync(new SettlementReplayRequest(settlementRequestId), context.GetCorrelationId(), cancellationToken);
                return result.Status == SettlementExecutionStatus.ReplayMismatch
                    ? Results.Json(result, statusCode: 409)
                    : Results.Ok(result);
            }
            catch (SettlementExecutionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "SETTLEMENT_REPLAY_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException error)
            {
                context.RequestServices.GetRequiredService<ILoggerFactory>()
                    .CreateLogger("SettlementExecutionEndpoints")
                    .LogWarning(error, "Settlement replay unavailable.");
                return Results.Json(new
                {
                    code = "SETTLEMENT_REPLAY_UNAVAILABLE",
                    message = error.Message,
                    correlationId = context.GetCorrelationId()
                }, statusCode: 503);
            }
        });
    }
}
