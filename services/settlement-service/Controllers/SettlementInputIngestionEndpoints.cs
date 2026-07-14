using SettlementService.Application;
using SettlementService.Contracts;
using SettlementService.Infrastructure;

namespace SettlementService.Controllers;

public static class SettlementInputIngestionEndpoints
{
    public static void MapSettlementInputIngestionEndpoints(this WebApplication app)
    {
        app.MapPost("/v1/settlement/inputs/ingest", async (
            HttpContext context,
            SettlementInputIngestionRequest request,
            SettlementInputIngestionService service,
            ILoggerFactory loggerFactory) =>
        {
            try
            {
                var result = await service.IngestAsync(
                    request,
                    context.GetCorrelationId(),
                    context.RequestAborted);
                return Results.Ok(result);
            }
            catch (SettlementInputIngestionConflictException error)
            {
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_INPUT_INGESTION_CONFLICT", error.Message),
                    context.GetCorrelationId()));
            }
            catch (SettlementInputIngestionValidationException error)
            {
                return Results.BadRequest(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_INPUT_INGESTION_VALIDATION_FAILED", string.Join(" ", error.Errors)),
                    context.GetCorrelationId()));
            }
            catch (Exception error) when (error is Npgsql.NpgsqlException or InvalidOperationException or TimeoutException)
            {
                loggerFactory
                    .CreateLogger("SettlementInputIngestionEndpoints")
                    .LogWarning(error, "SettlementInput ingestion request failed.");

                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(
                            "SETTLEMENT_INPUT_INGESTION_UNAVAILABLE",
                            "SettlementInput ingestion is unavailable."),
                        context.GetCorrelationId()),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });
    }
}
