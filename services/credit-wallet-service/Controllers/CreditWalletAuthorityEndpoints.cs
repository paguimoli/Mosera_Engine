using CreditWalletService.Application;
using CreditWalletService.Contracts;

namespace CreditWalletService.Controllers;

public static class CreditWalletAuthorityEndpoints
{
    public static void MapCreditWalletAuthorityEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/credit-wallets/internal/authority");

        group.MapGet("/readiness", async (
            HttpContext context,
            CreditWalletAuthorityMode? mode,
            InternalServiceAuthorizer authorizer,
            CreditWalletAuthorityService service,
            CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            try
            {
                return Results.Ok(await service.BuildReadinessReportAsync(mode, cancellationToken));
            }
            catch (CreditWalletAuthorityValidationException error)
            {
                return Results.BadRequest(new { error = error.Message, correlationId = context.GetCorrelationId() });
            }
        });

        group.MapGet("/blockers", async (
            HttpContext context,
            CreditWalletAuthorityMode? mode,
            InternalServiceAuthorizer authorizer,
            CreditWalletAuthorityService service,
            CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            var report = await service.BuildReadinessReportAsync(mode, cancellationToken);
            return Results.Ok(new
            {
                report.ConfiguredAuthorityMode,
                report.EvaluatedAuthorityMode,
                report.PromotionAllowed,
                report.Findings,
                report.ReadinessFingerprint,
                report.ProjectionRepairPolicy
            });
        });

        group.MapPost("/verify", async (
            HttpContext context,
            CreditWalletAuthorityMode? mode,
            string? operatorReference,
            InternalServiceAuthorizer authorizer,
            CreditWalletAuthorityService service,
            CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            try
            {
                return Results.Ok(await service.VerifyAsync(
                    mode, operatorReference ?? InternalServiceAuthorizer.GetCaller(context) ?? string.Empty,
                    cancellationToken));
            }
            catch (CreditWalletAuthorityValidationException error)
            {
                return Results.BadRequest(new { error = error.Message, correlationId = context.GetCorrelationId() });
            }
        });

        group.MapPost("/promotion-rehearsal", async (
            HttpContext context,
            CreditWalletPromotionRehearsalRequest request,
            InternalServiceAuthorizer authorizer,
            CreditWalletAuthorityService service,
            CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            try
            {
                return Results.Ok(await service.RunPromotionRehearsalAsync(request, cancellationToken));
            }
            catch (CreditWalletAuthorityValidationException error)
            {
                return Results.BadRequest(new { error = error.Message, correlationId = context.GetCorrelationId() });
            }
        });

        group.MapPost("/rollback-rehearsal", async (
            HttpContext context,
            CreditWalletRollbackRehearsalRequest request,
            InternalServiceAuthorizer authorizer,
            CreditWalletAuthorityService service,
            CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            try
            {
                return Results.Ok(await service.RunRollbackRehearsalAsync(request, cancellationToken));
            }
            catch (CreditWalletAuthorityValidationException error)
            {
                return Results.BadRequest(new { error = error.Message, correlationId = context.GetCorrelationId() });
            }
        });
    }
}
