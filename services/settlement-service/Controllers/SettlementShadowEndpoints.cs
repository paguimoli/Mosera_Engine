using SettlementService.Application;
using SettlementService.Contracts;

namespace SettlementService.Controllers;

public static class SettlementShadowEndpoints
{
    public static void MapSettlementShadowEndpoints(this WebApplication app)
    {
        app.MapPost("/v1/settlement/shadow/execute", (
            HttpContext context,
            ShadowSettlementExecuteRequest request,
            ShadowSettlementCalculator calculator,
            ILoggerFactory loggerFactory) =>
        {
            var correlationId = string.IsNullOrWhiteSpace(request.CorrelationId)
                ? context.GetCorrelationId()
                : request.CorrelationId.Trim();
            var logger = loggerFactory.CreateLogger("SettlementShadow");
            var response = calculator.Execute(request, correlationId);

            logger.LogInformation(
                "Settlement shadow execution completed. Status={ComparisonStatus} SettlementRunId={SettlementRunId} TicketId={TicketId}",
                response.ComparisonStatus,
                request.SettlementRunId,
                request.TicketId);

            return Results.Ok(response);
        });
    }
}
