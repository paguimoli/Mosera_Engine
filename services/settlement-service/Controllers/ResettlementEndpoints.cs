using SettlementService.Application;
using SettlementService.Contracts;

namespace SettlementService.Controllers;

public static class ResettlementEndpoints
{
    public static void MapResettlementEndpoints(this WebApplication app)
    {
        app.MapPost("/v1/settlement/resettlement-chains", async (
            ResettlementCreateRequest request,
            ResettlementService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                return Results.Ok(await service.CreateAsync(request, context.GetCorrelationId(), cancellationToken));
            }
            catch (SettlementExecutionConflictException error)
            {
                return Results.Conflict(new
                {
                    code = "RESETTLEMENT_CONFLICT",
                    message = error.Message,
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (ResettlementValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "RESETTLEMENT_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException error)
            {
                return Results.Json(new
                {
                    code = "RESETTLEMENT_UNAVAILABLE",
                    message = error.Message,
                    correlationId = context.GetCorrelationId()
                }, statusCode: 503);
            }
        });

        app.MapPost("/v1/settlement/resettlement-chains/{requestId:guid}/validate", async (
            Guid requestId,
            ResettlementService service,
            CancellationToken cancellationToken) =>
        {
            var result = await service.ValidateAsync(requestId, cancellationToken);
            return result.IsValid ? Results.Ok(result) : Results.BadRequest(result);
        });

        app.MapPost("/v1/settlement/resettlement-chains/{requestId:guid}/execute", async (
            Guid requestId,
            ResettlementExecuteRequest? request,
            ResettlementService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var body = request is null
                    ? new ResettlementExecuteRequest(requestId, false)
                    : request with { ResettlementRequestId = requestId };
                return Results.Ok(await service.ExecuteOrResumeAsync(body, context.GetCorrelationId(), cancellationToken));
            }
            catch (FinancialInstructionConflictException error)
            {
                return Results.Conflict(new
                {
                    code = "RESETTLEMENT_FINANCIAL_INSTRUCTION_CONFLICT",
                    message = error.Message,
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (ResettlementValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "RESETTLEMENT_EXECUTION_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (SettlementExecutionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "RESETTLEMENT_SETTLEMENT_EXECUTION_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        app.MapPost("/v1/settlement/resettlement-chains/{requestId:guid}/retry", async (
            Guid requestId,
            ResettlementRetryRequest request,
            ResettlementService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var body = request with { ResettlementRequestId = requestId };
                return Results.Ok(await service.RetryAsync(body, context.GetCorrelationId(), cancellationToken));
            }
            catch (ResettlementValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "RESETTLEMENT_RETRY_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        app.MapPost("/v1/settlement/resettlement-chains/{requestId:guid}/cancel", async (
            Guid requestId,
            ResettlementCancelRequest request,
            ResettlementService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var body = request with { ResettlementRequestId = requestId };
                return Results.Ok(await service.CancelAsync(body, context.GetCorrelationId(), cancellationToken));
            }
            catch (ResettlementValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "RESETTLEMENT_CANCEL_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        app.MapGet("/v1/settlement/resettlement-chains/{requestId:guid}", async (
            Guid requestId,
            ResettlementService service,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (request, chain, events) = await service.GetChainAsync(requestId, cancellationToken);
                return Results.Ok(new
                {
                    request,
                    chain,
                    events
                });
            }
            catch (ResettlementValidationException error)
            {
                return Results.Json(new
                {
                    code = "RESETTLEMENT_NOT_FOUND",
                    errors = error.Errors
                }, statusCode: 404);
            }
        });
    }
}
