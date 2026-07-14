using SettlementService.Application;
using SettlementService.Contracts;

namespace SettlementService.Controllers;

public static class SettlementAuthorityEndpoints
{
    public static void MapSettlementAuthorityEndpoints(this WebApplication app)
    {
        app.MapGet("/v1/settlement/authority/readiness", async (
            SettlementAuthorityMode? mode,
            SettlementAuthorityService service,
            CancellationToken cancellationToken) =>
        {
            try
            {
                return Results.Ok(await service.BuildReadinessReportAsync(mode, cancellationToken));
            }
            catch (SettlementAuthorityValidationException error)
            {
                return Results.BadRequest(new { error = error.Message });
            }
        });

        app.MapPost("/v1/settlement/authority/promotion-dry-run", async (
            SettlementPromotionDryRunRequest request,
            SettlementAuthorityService service,
            CancellationToken cancellationToken) =>
        {
            try
            {
                return Results.Ok(await service.RunPromotionDryRunAsync(request, cancellationToken));
            }
            catch (SettlementAuthorityValidationException error)
            {
                return Results.BadRequest(new { error = error.Message });
            }
        });

        app.MapGet("/v1/settlement/authority/rollback-readiness", async (
            SettlementAuthorityMode? proposedAuthority,
            SettlementAuthorityService service,
            CancellationToken cancellationToken) =>
        {
            try
            {
                return Results.Ok(await service.GetRollbackReadinessAsync(proposedAuthority, cancellationToken));
            }
            catch (SettlementAuthorityValidationException error)
            {
                return Results.BadRequest(new { error = error.Message });
            }
        });
    }
}
