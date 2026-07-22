using CreditWalletService.Application;
using CreditWalletService.Contracts;
using CreditWalletService.Infrastructure;

namespace CreditWalletService.Controllers;

public static class CreditWalletRecoveryEndpoints
{
    public static void MapCreditWalletRecoveryEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/credit-wallets/internal/operations");

        group.MapGet("/recovery/backlog", async (
            HttpContext context, InternalServiceAuthorizer authorizer,
            CreditWalletRecoveryRepository repository, CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            if (!repository.Configured) return Results.StatusCode(503);
            return Results.Ok(await repository.ListRecoveryCandidatesAsync(500, cancellationToken));
        });

        group.MapGet("/recovery/statistics", async (
            HttpContext context, InternalServiceAuthorizer authorizer,
            CreditWalletRecoveryRepository repository, CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            if (!repository.Configured) return Results.StatusCode(503);
            return Results.Ok(await repository.GetOperationalReportAsync(cancellationToken));
        });

        group.MapPost("/recovery/startup-scan", async (
            HttpContext context, InternalServiceAuthorizer authorizer,
            CreditWalletRecoveryService service, CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            return Results.Ok(await service.RunStartupRecoveryAsync(cancellationToken));
        });

        group.MapPost("/{operationId:guid}/recover", async (
            HttpContext context, Guid operationId, WalletRecoveryRequest request,
            InternalServiceAuthorizer authorizer, CreditWalletRecoveryService service,
            CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            try
            {
                return Results.Ok(await service.RecoverAsync(operationId, request.AllowRetry,
                    request.AllowRetry ? "RETRY" : "MANUAL", context.GetCorrelationId(), cancellationToken));
            }
            catch (KeyNotFoundException) { return Results.NotFound(); }
            catch (CanonicalWalletOperationConflictException error)
            {
                return Results.Conflict(new { error = error.Message, correlationId = context.GetCorrelationId() });
            }
            catch (CanonicalWalletOperationValidationException error)
            {
                return Results.BadRequest(new { error = error.Message, correlationId = context.GetCorrelationId() });
            }
        });

        group.MapPost("/{operationId:guid}/replay", async (
            HttpContext context, Guid operationId, InternalServiceAuthorizer authorizer,
            CreditWalletRecoveryService service, CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            try
            {
                var result = await service.ReplayAsync(operationId, context.GetCorrelationId(), cancellationToken);
                return result.ReplayResult == "MISMATCH" ? Results.Conflict(result) : Results.Ok(result);
            }
            catch (KeyNotFoundException) { return Results.NotFound(); }
        });

        group.MapPost("/reconciliation/projection/{walletId:guid}", async (
            HttpContext context, Guid walletId, InternalServiceAuthorizer authorizer,
            CreditWalletRecoveryService service, CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            var result = await service.VerifyProjectionAsync(walletId, context.GetCorrelationId(), cancellationToken);
            return result is null ? Results.NotFound() : Results.Ok(result);
        });

        group.MapPost("/reconciliation/ledger", async (
            HttpContext context, InternalServiceAuthorizer authorizer,
            CreditWalletRecoveryService service, CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            return Results.Ok(await service.ReconcileLedgerAsync(context.GetCorrelationId(), cancellationToken));
        });

        group.MapPost("/reconciliation/settlement", async (
            HttpContext context, InternalServiceAuthorizer authorizer,
            CreditWalletRecoveryService service, CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            return Results.Ok(await service.ReconcileSettlementAsync(context.GetCorrelationId(), cancellationToken));
        });
    }
}
