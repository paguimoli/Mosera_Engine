using LedgerService.Application;
using LedgerService.Contracts;

namespace LedgerService.Controllers;

public static class LedgerAuthorityEndpoints
{
    public static void MapLedgerAuthorityEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/internal/ledger/authority");

        group.MapGet("/readiness", async (
            LedgerAuthorityMode? mode,
            LedgerAuthorityService service,
            CancellationToken cancellationToken) =>
            Results.Ok(await service.BuildReadinessReportAsync(mode, cancellationToken)));

        group.MapGet("/blockers", async (
            LedgerAuthorityMode? mode,
            LedgerAuthorityService service,
            CancellationToken cancellationToken) =>
        {
            var report = await service.BuildReadinessReportAsync(mode, cancellationToken);
            return Results.Ok(new { report.AuthorityMode, report.PromotionAllowed, report.Blockers, report.ReadinessReportHash });
        });

        group.MapPost("/promotion-dry-run", async (
            LedgerPromotionDryRunRequest request,
            LedgerAuthorityService service,
            CancellationToken cancellationToken) =>
        {
            try
            {
                return Results.Ok(await service.RunPromotionDryRunAsync(request, cancellationToken));
            }
            catch (LedgerAuthorityValidationException error)
            {
                return Results.BadRequest(new { error = error.Message });
            }
        });

        group.MapGet("/rollback-readiness", async (
            LedgerAuthorityMode? proposedMode,
            LedgerAuthorityService service,
            CancellationToken cancellationToken) =>
            Results.Ok(await service.GetRollbackReadinessAsync(proposedMode, cancellationToken)));
    }
}
