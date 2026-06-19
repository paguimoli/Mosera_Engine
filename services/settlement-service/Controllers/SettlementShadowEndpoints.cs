using SettlementService.Application;
using SettlementService.Contracts;
using SettlementService.Infrastructure;

namespace SettlementService.Controllers;

public static class SettlementShadowEndpoints
{
    public static void MapSettlementShadowEndpoints(this WebApplication app)
    {
        app.MapPost("/v1/settlement/shadow/execute", async (
            HttpContext context,
            ShadowSettlementExecuteRequest request,
            ShadowSettlementCalculator calculator,
            SettlementShadowPersistence persistence,
            ILoggerFactory loggerFactory) =>
        {
            var correlationId = string.IsNullOrWhiteSpace(request.CorrelationId)
                ? context.GetCorrelationId()
                : request.CorrelationId.Trim();
            var logger = loggerFactory.CreateLogger("SettlementShadow");
            ShadowCalculationResult calculated;

            try
            {
                calculated = calculator.Execute(request, correlationId);
            }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException)
            {
                logger.LogWarning(
                    error,
                    "Settlement shadow execution failed. SettlementRunId={SettlementRunId} TicketId={TicketId}",
                    request.SettlementRunId,
                    request.TicketId);

                await persistence.PersistFailureAsync(
                    request,
                    correlationId,
                    error.GetType().Name,
                    error.Message,
                    new Dictionary<string, object?>
                    {
                        ["settlementRunId"] = request.SettlementRunId,
                        ["gameId"] = request.GameId,
                        ["drawingId"] = request.DrawingId
                    },
                    context.RequestAborted);

                return Results.BadRequest(new
                {
                    success = false,
                    error = error.Message,
                    correlationId
                });
            }

            var persistedRunId = await persistence.PersistRunAsync(
                request,
                calculated,
                context.RequestAborted);
            var response = new ShadowSettlementExecuteResponse(
                true,
                calculated.ShadowSettlementId,
                persistedRunId,
                calculated.CalculatedOutcome,
                calculated.GrossPayout,
                calculated.NetAmount,
                calculated.StakeAmount,
                calculated.Currency,
                calculated.ComparisonStatus,
                calculated.Mismatches,
                calculated.CorrelationId);

            logger.LogInformation(
                "Settlement shadow execution completed. Status={ComparisonStatus} SettlementRunId={SettlementRunId} TicketId={TicketId}",
                response.ComparisonStatus,
                request.SettlementRunId,
                request.TicketId);

            return Results.Ok(response);
        });
    }
}
