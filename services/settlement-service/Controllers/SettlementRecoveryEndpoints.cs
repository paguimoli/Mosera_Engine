using SettlementService.Application;
using SettlementService.Contracts;

namespace SettlementService.Controllers;

public static class SettlementRecoveryEndpoints
{
    public static void MapSettlementRecoveryEndpoints(this WebApplication app)
    {
        app.MapGet("/v1/settlement/records/{settlementId:guid}/recovery-status", async (
            Guid settlementId,
            SettlementRecoveryService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                return Results.Ok(await service.GetSettlementStatusAsync(
                    settlementId,
                    context.GetCorrelationId(),
                    cancellationToken));
            }
            catch (FinancialInstructionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "SETTLEMENT_RECOVERY_STATUS_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        app.MapGet("/v1/settlement/recovery/incomplete-instructions", async (
            SettlementRecoveryService service,
            CancellationToken cancellationToken) =>
        {
            return Results.Ok(new
            {
                instructions = await service.DiscoverIncompleteInstructionsAsync(cancellationToken)
            });
        });

        app.MapPost("/v1/settlement/records/{settlementId:guid}/recover", async (
            Guid settlementId,
            SettlementRecoveryRequest request,
            SettlementRecoveryService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var result = await service.RecoverSettlementAsync(
                    request with { SettlementId = settlementId },
                    context.GetCorrelationId(),
                    cancellationToken);
                return result.RecoveryState is SettlementRecoveryState.SettlementAwaitingVerification or SettlementRecoveryState.SettlementPartiallyExecuted
                    ? Results.Json(result, statusCode: 409)
                    : Results.Ok(result);
            }
            catch (FinancialInstructionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "SETTLEMENT_RECOVERY_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        app.MapPost("/v1/settlement/financial-instructions/{instructionId:guid}/recover", async (
            Guid instructionId,
            InstructionRecoveryRequest request,
            SettlementRecoveryService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var result = await service.RecoverInstructionAsync(
                    request with { InstructionId = instructionId },
                    context.GetCorrelationId(),
                    cancellationToken);
                return result.RecoveryState is SettlementRecoveryState.SettlementAwaitingVerification or SettlementRecoveryState.SettlementAwaitingRecovery
                    ? Results.Json(result, statusCode: 409)
                    : Results.Ok(result);
            }
            catch (FinancialInstructionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "INSTRUCTION_RECOVERY_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        app.MapPost("/v1/settlement/financial-instructions/{instructionId:guid}/verify-unknown", async (
            Guid instructionId,
            UnknownInstructionVerificationRequest request,
            SettlementRecoveryService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var result = await service.VerifyUnknownInstructionAsync(
                    request with { InstructionId = instructionId },
                    context.GetCorrelationId(),
                    cancellationToken);
                return result.RecoveryState == SettlementRecoveryState.SettlementAwaitingVerification
                    ? Results.Json(result, statusCode: 409)
                    : Results.Ok(result);
            }
            catch (FinancialInstructionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "INSTRUCTION_UNKNOWN_VERIFICATION_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        app.MapPost("/v1/settlement/financial-instructions/{instructionId:guid}/reconcile", async (
            Guid instructionId,
            InstructionReconciliationRequest request,
            SettlementRecoveryService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var result = await service.ReconcileInstructionAsync(
                    request with { InstructionId = instructionId },
                    context.GetCorrelationId(),
                    cancellationToken);
                return result.FailClosed
                    ? Results.Json(result, statusCode: 409)
                    : Results.Ok(result);
            }
            catch (FinancialInstructionValidationException error)
            {
                return Results.BadRequest(new
                {
                    code = "INSTRUCTION_RECONCILIATION_VALIDATION_FAILED",
                    errors = error.Errors,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        app.MapPost("/v1/settlement/records/{settlementId:guid}/recovery-replay", async (
            Guid settlementId,
            SettlementRecoveryService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            return Results.Ok(await service.ReplaySettlementDecisionAsync(
                settlementId,
                context.GetCorrelationId(),
                cancellationToken));
        });
    }
}
