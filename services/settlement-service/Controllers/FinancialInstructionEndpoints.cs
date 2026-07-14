using SettlementService.Application;
using SettlementService.Contracts;

namespace SettlementService.Controllers;

public static class FinancialInstructionEndpoints
{
    public static void MapFinancialInstructionEndpoints(this WebApplication app)
    {
        app.MapPost("/v1/settlement/records/{settlementId:guid}/financial-instructions/generate", async (
            Guid settlementId,
            FinancialInstructionService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var result = await service.GenerateAsync(
                    new FinancialInstructionGenerationRequest(settlementId),
                    context.GetCorrelationId(),
                    cancellationToken);
                return Results.Ok(result);
            }
            catch (FinancialInstructionConflictException error)
            {
                return Results.Conflict(new
                {
                    code = "FINANCIAL_INSTRUCTION_CONFLICT",
                    message = error.Message,
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (FinancialInstructionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "FINANCIAL_INSTRUCTION_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException error)
            {
                context.RequestServices.GetRequiredService<ILoggerFactory>()
                    .CreateLogger("FinancialInstructionEndpoints")
                    .LogWarning(error, "Financial instruction generation unavailable.");
                return Results.Json(new
                {
                    code = "FINANCIAL_INSTRUCTION_UNAVAILABLE",
                    message = error.Message,
                    correlationId = context.GetCorrelationId()
                }, statusCode: 503);
            }
        });

        app.MapPost("/v1/settlement/records/{settlementId:guid}/financial-instructions/replay", async (
            Guid settlementId,
            FinancialInstructionService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var result = await service.ReplayAsync(
                    new FinancialInstructionReplayRequest(settlementId),
                    context.GetCorrelationId(),
                    cancellationToken);
                return result.Status == "ReplayMismatch"
                    ? Results.Json(result, statusCode: 409)
                    : Results.Ok(result);
            }
            catch (FinancialInstructionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "FINANCIAL_INSTRUCTION_REPLAY_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException error)
            {
                context.RequestServices.GetRequiredService<ILoggerFactory>()
                    .CreateLogger("FinancialInstructionEndpoints")
                    .LogWarning(error, "Financial instruction replay unavailable.");
                return Results.Json(new
                {
                    code = "FINANCIAL_INSTRUCTION_REPLAY_UNAVAILABLE",
                    message = error.Message,
                    correlationId = context.GetCorrelationId()
                }, statusCode: 503);
            }
        });

        app.MapPost("/v1/settlement/financial-instructions/{instructionId:guid}/execute", async (
            Guid instructionId,
            FinancialInstructionExecutionService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var result = await service.ExecuteAsync(
                    new FinancialInstructionExecutionRequest(instructionId),
                    context.GetCorrelationId(),
                    cancellationToken);
                return result.Status == "Failed"
                    ? Results.Json(result, statusCode: 502)
                    : Results.Ok(result);
            }
            catch (FinancialInstructionConflictException error)
            {
                return Results.Conflict(new
                {
                    code = "FINANCIAL_INSTRUCTION_EXECUTION_CONFLICT",
                    message = error.Message,
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (FinancialInstructionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "FINANCIAL_INSTRUCTION_EXECUTION_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        app.MapPost("/v1/settlement/records/{settlementId:guid}/financial-instructions/execute", async (
            Guid settlementId,
            FinancialInstructionExecutionService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var result = await service.ExecuteSettlementAsync(
                    new FinancialInstructionSettlementExecutionRequest(settlementId),
                    context.GetCorrelationId(),
                    cancellationToken);
                return result.Results.Any(item => item.Status == "Failed")
                    ? Results.Json(result, statusCode: 502)
                    : Results.Ok(result);
            }
            catch (FinancialInstructionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "FINANCIAL_INSTRUCTION_SETTLEMENT_EXECUTION_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        app.MapPost("/v1/settlement/financial-instructions/{instructionId:guid}/retry", async (
            Guid instructionId,
            FinancialInstructionRetryRequest request,
            FinancialInstructionExecutionService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var result = await service.RetryAsync(
                    request with { InstructionId = instructionId },
                    context.GetCorrelationId(),
                    cancellationToken);
                return result.Status == "Failed"
                    ? Results.Json(result, statusCode: 502)
                    : Results.Ok(result);
            }
            catch (FinancialInstructionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "FINANCIAL_INSTRUCTION_RETRY_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        app.MapGet("/v1/settlement/financial-instructions/{instructionId:guid}/execution-state", async (
            Guid instructionId,
            FinancialInstructionExecutionService service,
            CancellationToken cancellationToken) =>
        {
            var attempts = await service.GetStateAsync(instructionId, cancellationToken);
            return Results.Ok(new
            {
                instructionId,
                attempts
            });
        });
    }
}
