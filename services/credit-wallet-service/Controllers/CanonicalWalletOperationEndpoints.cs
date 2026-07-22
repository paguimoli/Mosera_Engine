using CreditWalletService.Application;
using CreditWalletService.Contracts;
using CreditWalletService.Infrastructure;

namespace CreditWalletService.Controllers;

public static class CanonicalWalletOperationEndpoints
{
    public static void MapCanonicalWalletOperationEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/credit-wallets/internal");

        group.MapGet("/instruments", async (
            HttpContext context,
            InternalServiceAuthorizer authorizer,
            CanonicalWalletOperationRepository repository,
            CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            if (!repository.Configured) return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            return Results.Ok(await repository.ListInstrumentsAsync(cancellationToken));
        });

        group.MapGet("/exposure/{playerId:guid}", async (
            HttpContext context,
            Guid playerId,
            InternalServiceAuthorizer authorizer,
            CanonicalWalletOperationRepository repository,
            CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            if (!repository.Configured) return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            var exposure = await repository.GetPlayerExposureAsync(
                playerId, context.GetCorrelationId(), cancellationToken);
            return exposure is null ? Results.NotFound() : Results.Ok(exposure);
        });

        group.MapGet("/reservations/{reservationId:guid}/settlement-context", async (
            HttpContext context,
            Guid reservationId,
            InternalServiceAuthorizer authorizer,
            CanonicalWalletOperationRepository repository,
            CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            if (!repository.Configured) return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            var reservation = await repository.GetReservationSettlementContextAsync(reservationId, cancellationToken);
            return reservation is null ? Results.NotFound() : Results.Ok(reservation);
        });

        group.MapGet("/settlements/{settlementId:guid}/operation-trace", async (
            HttpContext context,
            Guid settlementId,
            InternalServiceAuthorizer authorizer,
            CanonicalWalletOperationRepository repository,
            CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            if (!repository.Configured) return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            var trace = await repository.GetSettlementOperationTraceAsync(settlementId, cancellationToken);
            return trace is null ? Results.NotFound() : Results.Ok(trace);
        });

        group.MapPost("/operations", async (
            HttpContext context,
            CanonicalWalletOperationRequest request,
            InternalServiceAuthorizer authorizer,
            CanonicalWalletOperationService service,
            CanonicalWalletOperationRepository repository,
            ILoggerFactory loggerFactory,
            CancellationToken cancellationToken) =>
        {
            if (!authorizer.IsAuthorized(context)) return Results.Unauthorized();
            if (!repository.Configured)
            {
                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(CreditWalletErrorCodes.InternalError, "Canonical wallet persistence is unavailable."),
                        context.GetCorrelationId()),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }

            var idempotencyKey = context.Request.Headers[CreditWalletHeaders.IdempotencyKey]
                .FirstOrDefault()?.Trim() ?? string.Empty;
            try
            {
                return Results.Ok(await service.ExecuteAsync(
                    request, idempotencyKey,
                    InternalServiceAuthorizer.GetCaller(context) ?? string.Empty,
                    context.GetCorrelationId(), cancellationToken));
            }
            catch (CanonicalWalletOperationConflictException error)
            {
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto(CreditWalletErrorCodes.DuplicateIdempotencyKey, error.Message),
                    context.GetCorrelationId()));
            }
            catch (CanonicalWalletOperationDisabledException error)
            {
                return Results.UnprocessableEntity(new ErrorResponse(
                    new ErrorDto(CreditWalletErrorCodes.NotImplemented, error.Message),
                    context.GetCorrelationId()));
            }
            catch (CanonicalWalletOperationValidationException error)
            {
                return Results.BadRequest(new ErrorResponse(
                    new ErrorDto(CreditWalletErrorCodes.ValidationFailed, error.Message),
                    context.GetCorrelationId()));
            }
            catch (Exception error) when (error is Npgsql.NpgsqlException or InvalidOperationException or TimeoutException)
            {
                loggerFactory.CreateLogger("CanonicalWalletOperationEndpoints")
                    .LogWarning(error, "Canonical wallet operation persistence failed.");
                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(CreditWalletErrorCodes.InternalError, "Canonical wallet operation is unavailable."),
                        context.GetCorrelationId()),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });
    }
}
