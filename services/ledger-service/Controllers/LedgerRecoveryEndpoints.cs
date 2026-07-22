using LedgerService.Application;
using LedgerService.Contracts;
using LedgerService.Infrastructure;

namespace LedgerService.Controllers;

public static class LedgerRecoveryEndpoints
{
    public static void MapLedgerRecoveryEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/internal/ledger");

        group.MapPost("/posting-requests/{requestId:guid}/recover", async (
            HttpContext context,
            Guid requestId,
            LedgerRecoveryService service,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var result = await service.RecoverPostingAsync(requestId, cancellationToken);
                return Results.Ok(new LedgerRecoveryResponse(
                    result.Evidence, result.Request, result.Entry, context.GetCorrelationId()));
            }
            catch (LedgerPostingRequestNotFoundException)
            {
                return Results.NotFound();
            }
            catch (Exception error) when (error is LedgerUnknownResultException or LedgerJournalException or LedgerRecoveryException)
            {
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto(LedgerErrorCodes.UnknownResult, error.Message), context.GetCorrelationId()));
            }
        });

        group.MapPost("/posting-requests/{requestId:guid}/verify-journal", async (
            HttpContext context,
            Guid requestId,
            LedgerRecoveryService service,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var evidence = await service.VerifyJournalAsync(requestId, cancellationToken);
                return evidence.Classification == LedgerRecoveryClassification.JOURNAL_MATCH
                    ? Results.Ok(evidence)
                    : Results.Conflict(evidence);
            }
            catch (LedgerPostingRequestNotFoundException)
            {
                return Results.NotFound();
            }
        });

        group.MapPost("/settlement-instructions/{instructionId:guid}/reconcile", async (
            HttpContext context,
            Guid instructionId,
            LedgerRecoveryService service,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var evidence = await service.ReconcileSettlementInstructionAsync(instructionId, cancellationToken);
                var response = new LedgerReconciliationResponse(evidence, context.GetCorrelationId());
                return evidence.Result == LedgerReconciliationResult.RECONCILED
                    ? Results.Ok(response)
                    : Results.Conflict(response);
            }
            catch (LedgerReconciliationNotFoundException)
            {
                return Results.NotFound();
            }
        });

        group.MapGet("/settlement-instructions/{instructionId:guid}/reconciliation", async (
            HttpContext context,
            Guid instructionId,
            LedgerRecoveryService service,
            CancellationToken cancellationToken) =>
        {
            var evidence = await service.FindReconciliationAsync(instructionId, cancellationToken);
            return evidence is null
                ? Results.NotFound()
                : Results.Ok(new LedgerReconciliationResponse(evidence, context.GetCorrelationId()));
        });

        group.MapGet("/recovery/incomplete", async (
            LedgerRecoveryService service,
            CancellationToken cancellationToken) =>
            Results.Ok(new { requestIds = await service.DiscoverIncompleteAsync(cancellationToken) }));

        group.MapGet("/recovery/readiness", async (
            LedgerRecoveryService service,
            CancellationToken cancellationToken) =>
        {
            var readiness = await service.CheckReadinessAsync(cancellationToken);
            return readiness.Reachable && readiness.Blockers.Count == 0
                ? Results.Ok(readiness)
                : Results.Json(readiness, statusCode: 503);
        });
    }
}
