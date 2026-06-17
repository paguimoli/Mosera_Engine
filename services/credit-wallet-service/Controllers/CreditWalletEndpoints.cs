using CreditWalletService.Application;
using CreditWalletService.Contracts;

namespace CreditWalletService.Controllers;

public static class CreditWalletEndpoints
{
    public static void MapCreditWalletEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/credit-wallets");

        group.MapPost("/{playerId:guid}/limit", (
            HttpContext context,
            Guid playerId,
            SetCreditLimitRequest request,
            CreditWalletContractService service,
            ILoggerFactory loggerFactory) =>
        {
            LogCommand(loggerFactory, "Credit limit placeholder command received.", playerId);

            if (IsMissingIdempotencyKey(context))
            {
                return Results.BadRequest(service.CreateMissingIdempotencyKeyError(context.GetCorrelationId()));
            }

            if (!service.HasNonNegativeMoney(request.Limit))
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Credit limit must be a non-negative integer minor currency value with ISO-4217 currency.",
                    "limit"));
            }

            if (string.IsNullOrWhiteSpace(request.ReasonCode))
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Reason code is required.",
                    "reasonCode"));
            }

            return NotImplemented(context, service);
        });

        group.MapPost("/{agentId:guid}/allocate", (
            HttpContext context,
            Guid agentId,
            AllocateCreditRequest request,
            CreditWalletContractService service,
            ILoggerFactory loggerFactory) =>
        {
            LogCommand(loggerFactory, "Credit allocation placeholder command received.", agentId);

            if (IsMissingIdempotencyKey(context))
            {
                return Results.BadRequest(service.CreateMissingIdempotencyKeyError(context.GetCorrelationId()));
            }

            if (!service.HasNonNegativeMoney(request.Allocation))
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Allocation must be a non-negative integer minor currency value with ISO-4217 currency.",
                    "allocation"));
            }

            return NotImplemented(context, service);
        });

        group.MapPost("/{allocationId:guid}/reallocate", (
            HttpContext context,
            Guid allocationId,
            ReallocateCreditRequest request,
            CreditWalletContractService service,
            ILoggerFactory loggerFactory) =>
        {
            LogCommand(loggerFactory, "Credit reallocation placeholder command received.", allocationId);

            if (IsMissingIdempotencyKey(context))
            {
                return Results.BadRequest(service.CreateMissingIdempotencyKeyError(context.GetCorrelationId()));
            }

            if (!service.HasNonNegativeMoney(request.NewAllocation))
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "New allocation must be a non-negative integer minor currency value with ISO-4217 currency.",
                    "newAllocation"));
            }

            return NotImplemented(context, service);
        });

        group.MapPost("/{playerId:guid}/reserve", (
            HttpContext context,
            Guid playerId,
            ReserveExposureRequest request,
            CreditWalletContractService service,
            ILoggerFactory loggerFactory) =>
        {
            LogCommand(loggerFactory, "Credit reservation placeholder command received.", playerId);

            if (IsMissingIdempotencyKey(context))
            {
                return Results.BadRequest(service.CreateMissingIdempotencyKeyError(context.GetCorrelationId()));
            }

            if (!service.HasPositiveMoney(request.Amount))
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Reservation amount must be a positive integer minor currency value with ISO-4217 currency.",
                    "amount"));
            }

            return NotImplemented(context, service);
        });

        group.MapPost("/{playerId:guid}/release", (
            HttpContext context,
            Guid playerId,
            ReleaseExposureRequest request,
            CreditWalletContractService service,
            ILoggerFactory loggerFactory) =>
        {
            LogCommand(loggerFactory, "Credit release placeholder command received.", playerId);

            if (IsMissingIdempotencyKey(context))
            {
                return Results.BadRequest(service.CreateMissingIdempotencyKeyError(context.GetCorrelationId()));
            }

            if (!service.HasPositiveMoney(request.ReleaseAmount))
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Release amount must be a positive integer minor currency value with ISO-4217 currency.",
                    "releaseAmount"));
            }

            return NotImplemented(context, service);
        });

        group.MapPost("/{playerId:guid}/settle", (
            HttpContext context,
            Guid playerId,
            SettleCreditRequest request,
            CreditWalletContractService service,
            ILoggerFactory loggerFactory) =>
        {
            LogCommand(loggerFactory, "Credit settlement placeholder command received.", playerId);

            if (IsMissingIdempotencyKey(context))
            {
                return Results.BadRequest(service.CreateMissingIdempotencyKeyError(context.GetCorrelationId()));
            }

            if (!service.HasPositiveMoney(request.ReleaseAmount))
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Release amount must be a positive integer minor currency value with ISO-4217 currency.",
                    "releaseAmount"));
            }

            if (!service.HasNonZeroMoney(request.BalanceImpact))
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Balance impact must be a non-zero integer minor currency value with ISO-4217 currency.",
                    "balanceImpact"));
            }

            return NotImplemented(context, service);
        });

        group.MapPost("/{playerId:guid}/adjust", (
            HttpContext context,
            Guid playerId,
            AdjustCreditRequest request,
            CreditWalletContractService service,
            ILoggerFactory loggerFactory) =>
        {
            LogCommand(loggerFactory, "Credit adjustment placeholder command received.", playerId);

            if (IsMissingIdempotencyKey(context))
            {
                return Results.BadRequest(service.CreateMissingIdempotencyKeyError(context.GetCorrelationId()));
            }

            if (!service.HasNonZeroMoney(request.Amount))
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Adjustment amount must be a non-zero integer minor currency value with ISO-4217 currency.",
                    "amount"));
            }

            if (string.IsNullOrWhiteSpace(request.ReasonCode))
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Reason code is required.",
                    "reasonCode"));
            }

            return NotImplemented(context, service);
        });

        group.MapGet("/{playerId:guid}", (
            HttpContext context,
            Guid playerId,
            CreditWalletContractService service,
            ILoggerFactory loggerFactory) =>
        {
            LogQuery(loggerFactory, "Credit wallet placeholder query received.", playerId);
            return NotImplemented(context, service);
        });

        group.MapGet("/{playerId:guid}/transactions", (
            HttpContext context,
            Guid playerId,
            DateTimeOffset? from,
            DateTimeOffset? to,
            string? transactionType,
            int? limit,
            string? cursor,
            string? sort,
            CreditWalletContractService service,
            ILoggerFactory loggerFactory) =>
        {
            LogQuery(loggerFactory, "Credit wallet transactions placeholder query received.", playerId);

            if (limit is < 1 or > 250)
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Limit must be between 1 and 250.",
                    "limit"));
            }

            if (sort is not null && sort is not "createdAt.asc" and not "createdAt.desc")
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Sort must be createdAt.asc or createdAt.desc.",
                    "sort"));
            }

            _ = from;
            _ = to;
            _ = transactionType;
            _ = cursor;

            return NotImplemented(context, service);
        });

        group.MapGet("/{playerId:guid}/exposure", (
            HttpContext context,
            Guid playerId,
            Guid? marketId,
            Guid? drawId,
            bool? includeReservations,
            CreditWalletContractService service,
            ILoggerFactory loggerFactory) =>
        {
            LogQuery(loggerFactory, "Credit wallet exposure placeholder query received.", playerId);

            _ = marketId;
            _ = drawId;
            _ = includeReservations;

            return NotImplemented(context, service);
        });

        group.MapGet("/{playerId:guid}/summary", (
            HttpContext context,
            Guid playerId,
            Guid? periodId,
            DateTimeOffset? from,
            DateTimeOffset? to,
            CreditWalletContractService service,
            ILoggerFactory loggerFactory) =>
        {
            LogQuery(loggerFactory, "Credit wallet summary placeholder query received.", playerId);

            _ = periodId;
            _ = from;
            _ = to;

            return NotImplemented(context, service);
        });
    }

    private static bool IsMissingIdempotencyKey(HttpContext context)
    {
        var value = context.Request.Headers[CreditWalletHeaders.IdempotencyKey].FirstOrDefault();

        return string.IsNullOrWhiteSpace(value);
    }

    private static IResult NotImplemented(
        HttpContext context,
        CreditWalletContractService service)
    {
        return Results.Json(
            service.CreateNotImplementedError(context.GetCorrelationId()),
            statusCode: StatusCodes.Status501NotImplemented);
    }

    private static void LogCommand(
        ILoggerFactory loggerFactory,
        string message,
        Guid aggregateId)
    {
        var logger = loggerFactory.CreateLogger("CreditWalletCommandEndpoints");
        logger.LogInformation("{Message} AggregateId: {AggregateId}.", message, aggregateId);
    }

    private static void LogQuery(
        ILoggerFactory loggerFactory,
        string message,
        Guid aggregateId)
    {
        var logger = loggerFactory.CreateLogger("CreditWalletQueryEndpoints");
        logger.LogInformation("{Message} AggregateId: {AggregateId}.", message, aggregateId);
    }
}
