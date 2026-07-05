using CreditWalletService.Application;
using CreditWalletService.Contracts;
using CreditWalletService.Infrastructure;

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

        group.MapPost("/{playerId:guid}/reserve", async (
            HttpContext context,
            Guid playerId,
            ReserveExposureRequest request,
            CreditWalletContractService service,
            DurableCreditWalletRepository repository,
            ILoggerFactory loggerFactory) =>
        {
            LogCommand(loggerFactory, "Credit reservation command received.", playerId);

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

            if (!repository.DurablePersistenceConfigured)
            {
                return NotImplemented(context, service);
            }

            return await ExecuteMutationAsync(
                context,
                loggerFactory,
                () => repository.ReserveAsync(
                    playerId,
                    request,
                    GetIdempotencyKey(context),
                    context.GetCorrelationId(),
                    context.RequestAborted));
        });

        group.MapPost("/{playerId:guid}/release", async (
            HttpContext context,
            Guid playerId,
            ReleaseExposureRequest request,
            CreditWalletContractService service,
            DurableCreditWalletRepository repository,
            ILoggerFactory loggerFactory) =>
        {
            LogCommand(loggerFactory, "Credit release command received.", playerId);

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

            if (!repository.DurablePersistenceConfigured)
            {
                return NotImplemented(context, service);
            }

            return await ExecuteMutationAsync(
                context,
                loggerFactory,
                () => repository.ReleaseAsync(
                    playerId,
                    request,
                    GetIdempotencyKey(context),
                    context.GetCorrelationId(),
                    context.RequestAborted));
        });

        group.MapPost("/{playerId:guid}/settle", async (
            HttpContext context,
            Guid playerId,
            SettleCreditRequest request,
            CreditWalletContractService service,
            DurableCreditWalletRepository repository,
            ILoggerFactory loggerFactory) =>
        {
            LogCommand(loggerFactory, "Credit settlement command received.", playerId);

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

            if (request.ReleaseAmount.Currency != request.BalanceImpact.Currency)
            {
                return Results.BadRequest(service.CreateValidationError(
                    context.GetCorrelationId(),
                    "Release amount and balance impact currencies must match.",
                    "currency"));
            }

            if (!repository.DurablePersistenceConfigured)
            {
                return NotImplemented(context, service);
            }

            return await ExecuteMutationAsync(
                context,
                loggerFactory,
                () => repository.SettleAsync(
                    playerId,
                    request,
                    GetIdempotencyKey(context),
                    context.GetCorrelationId(),
                    context.RequestAborted));
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

        group.MapGet("/{playerId:guid}", async (
            HttpContext context,
            Guid playerId,
            CreditWalletContractService service,
            DurableCreditWalletRepository repository,
            ILoggerFactory loggerFactory) =>
        {
            LogQuery(loggerFactory, "Credit wallet placeholder query received.", playerId);

            if (!repository.DurablePersistenceConfigured)
            {
                return NotImplemented(context, service);
            }

            return await ExecuteReadAsync(
                context,
                service,
                loggerFactory,
                async cancellationToken =>
                {
                    var summary = await repository.GetSummaryAsync(
                        playerId,
                        context.GetCorrelationId(),
                        cancellationToken);

                    return summary is null
                        ? NotFound(context, playerId)
                        : Results.Ok(new CreditWalletDto(
                            summary.PlayerId,
                            summary.CreditWalletId,
                            summary.CreditLimit,
                            summary.Balance,
                            summary.PendingExposure,
                            summary.AvailableCredit,
                            summary.Status,
                            summary.HierarchyModel,
                            summary.CorrelationId));
                });
        });

        group.MapGet("/{playerId:guid}/transactions", async (
            HttpContext context,
            Guid playerId,
            CreditWalletContractService service,
            DurableCreditWalletRepository repository,
            ILoggerFactory loggerFactory) =>
        {
            LogQuery(loggerFactory, "Credit wallet transactions placeholder query received.", playerId);
            var query = context.Request.Query;
            var limit = int.TryParse(query["limit"].FirstOrDefault(), out var parsedLimit)
                ? parsedLimit
                : null as int?;
            var cursor = query["cursor"].FirstOrDefault();
            var sort = query["sort"].FirstOrDefault();

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

            if (!repository.DurablePersistenceConfigured)
            {
                return NotImplemented(context, service);
            }

            return await ExecuteReadAsync(
                context,
                service,
                loggerFactory,
                async cancellationToken =>
                {
                    var resolvedLimit = limit ?? 100;
                    var offset = ParseCursor(cursor);
                    var ascending = sort == "createdAt.asc";
                    var transactions = await repository.ListTransactionsAsync(
                        playerId,
                        resolvedLimit,
                        offset,
                        ascending,
                        context.GetCorrelationId(),
                        cancellationToken);

                    return transactions is null ? NotFound(context, playerId) : Results.Ok(transactions);
                });
        });

        group.MapGet("/{playerId:guid}/exposure", async (
            HttpContext context,
            Guid playerId,
            Guid? marketId,
            Guid? drawId,
            bool? includeReservations,
            CreditWalletContractService service,
            DurableCreditWalletRepository repository,
            ILoggerFactory loggerFactory) =>
        {
            LogQuery(loggerFactory, "Credit wallet exposure placeholder query received.", playerId);

            _ = marketId;
            _ = drawId;

            if (!repository.DurablePersistenceConfigured)
            {
                return NotImplemented(context, service);
            }

            return await ExecuteReadAsync(
                context,
                service,
                loggerFactory,
                async cancellationToken =>
                {
                    var exposure = await repository.GetExposureAsync(
                        playerId,
                        includeReservations ?? true,
                        context.GetCorrelationId(),
                        cancellationToken);

                    return exposure is null ? NotFound(context, playerId) : Results.Ok(exposure);
                });
        });

        group.MapGet("/{playerId:guid}/summary", async (
            HttpContext context,
            Guid playerId,
            Guid? periodId,
            DateTimeOffset? from,
            DateTimeOffset? to,
            CreditWalletContractService service,
            DurableCreditWalletRepository repository,
            ILoggerFactory loggerFactory) =>
        {
            LogQuery(loggerFactory, "Credit wallet summary placeholder query received.", playerId);

            _ = periodId;
            _ = from;
            _ = to;

            if (!repository.DurablePersistenceConfigured)
            {
                return NotImplemented(context, service);
            }

            return await ExecuteReadAsync(
                context,
                service,
                loggerFactory,
                async cancellationToken =>
                {
                    var summary = await repository.GetSummaryAsync(
                        playerId,
                        context.GetCorrelationId(),
                        cancellationToken);

                    return summary is null ? NotFound(context, playerId) : Results.Ok(summary);
                });
        });

        group.MapGet("/{playerId:guid}/reconciliation", async (
            HttpContext context,
            Guid playerId,
            CreditWalletContractService service,
            DurableCreditWalletRepository repository,
            ILoggerFactory loggerFactory) =>
        {
            LogQuery(loggerFactory, "Credit wallet reconciliation query received.", playerId);

            if (!repository.DurablePersistenceConfigured)
            {
                return NotImplemented(context, service);
            }

            return await ExecuteReadAsync(
                context,
                service,
                loggerFactory,
                async cancellationToken =>
                {
                    var reconciliation = await repository.GetReconciliationAsync(
                        playerId,
                        context.GetCorrelationId(),
                        cancellationToken);

                    return reconciliation is null ? NotFound(context, playerId) : Results.Ok(reconciliation);
                });
        });

        var shadowGroup = app.MapGroup("/v1/credit/shadow");

        shadowGroup.MapPost("/reserve", (
            HttpContext context,
            CreditShadowExecuteRequest request,
            CreditShadowCalculator shadowCalculator,
            CreditShadowPersistence shadowPersistence,
            ILoggerFactory loggerFactory,
            CancellationToken cancellationToken) =>
            ExecuteShadow(
                CreditShadowOperationType.RESERVE,
                context,
                request,
                shadowCalculator,
                shadowPersistence,
                loggerFactory,
                cancellationToken));

        shadowGroup.MapPost("/release", (
            HttpContext context,
            CreditShadowExecuteRequest request,
            CreditShadowCalculator shadowCalculator,
            CreditShadowPersistence shadowPersistence,
            ILoggerFactory loggerFactory,
            CancellationToken cancellationToken) =>
            ExecuteShadow(
                CreditShadowOperationType.RELEASE,
                context,
                request,
                shadowCalculator,
                shadowPersistence,
                loggerFactory,
                cancellationToken));

        shadowGroup.MapPost("/settlement", (
            HttpContext context,
            CreditShadowExecuteRequest request,
            CreditShadowCalculator shadowCalculator,
            CreditShadowPersistence shadowPersistence,
            ILoggerFactory loggerFactory,
            CancellationToken cancellationToken) =>
            ExecuteShadow(
                CreditShadowOperationType.SETTLEMENT,
                context,
                request,
                shadowCalculator,
                shadowPersistence,
                loggerFactory,
                cancellationToken));
    }

    private static async Task<IResult> ExecuteShadow(
        CreditShadowOperationType operationType,
        HttpContext context,
        CreditShadowExecuteRequest request,
        CreditShadowCalculator shadowCalculator,
        CreditShadowPersistence shadowPersistence,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        var correlationId = string.IsNullOrWhiteSpace(request.CorrelationId)
            ? context.GetCorrelationId()
            : request.CorrelationId.Trim();
        var logger = loggerFactory.CreateLogger("CreditShadowEndpoints");

        logger.LogInformation(
            "Credit shadow execution requested. OperationType: {OperationType}. ReservationId: {ReservationId}. TicketId: {TicketId}. CorrelationId: {CorrelationId}.",
            operationType,
            request.ReservationId,
            request.TicketId,
            correlationId);

        var normalizedRequest = request with { CorrelationId = correlationId };

        try
        {
            var evaluation = shadowCalculator.Evaluate(operationType, normalizedRequest);
            var persistedRunId = await shadowPersistence.PersistRunAsync(
                operationType,
                normalizedRequest,
                evaluation,
                cancellationToken);

            return Results.Ok(new CreditShadowExecuteResponse(
                true,
                persistedRunId,
                evaluation.CalculatedResult,
                evaluation.ComparisonStatus,
                evaluation.Mismatches,
                correlationId));
        }
        catch (ArgumentException error)
        {
            await shadowPersistence.PersistFailureAsync(
                normalizedRequest,
                correlationId,
                "VALIDATION_ERROR",
                error.Message,
                new Dictionary<string, object?>
                {
                    ["operationType"] = operationType.ToString(),
                    ["reservationId"] = request.ReservationId,
                    ["ticketId"] = request.TicketId,
                    ["amountMinor"] = request.AmountMinor,
                    ["currency"] = request.Currency
                },
                cancellationToken);

            return Results.BadRequest(new ErrorResponse(
                new ErrorDto(
                    CreditWalletErrorCodes.ValidationFailed,
                    error.Message),
                correlationId));
        }
        catch (Exception error)
        {
            logger.LogError(
                error,
                "Credit shadow execution failed. OperationType: {OperationType}. CorrelationId: {CorrelationId}.",
                operationType,
                correlationId);

            await shadowPersistence.PersistFailureAsync(
                normalizedRequest,
                correlationId,
                "INTERNAL_ERROR",
                "Credit shadow execution failed.",
                new Dictionary<string, object?>
                {
                    ["operationType"] = operationType.ToString(),
                    ["error"] = error.Message
                },
                cancellationToken);

            return Results.Json(
                new ErrorResponse(
                    new ErrorDto(
                        CreditWalletErrorCodes.InternalError,
                        "Credit shadow execution failed."),
                    correlationId),
                statusCode: StatusCodes.Status500InternalServerError);
        }
    }

    private static bool IsMissingIdempotencyKey(HttpContext context)
    {
        var value = context.Request.Headers[CreditWalletHeaders.IdempotencyKey].FirstOrDefault();

        return string.IsNullOrWhiteSpace(value);
    }

    private static string GetIdempotencyKey(HttpContext context)
    {
        return context.Request.Headers[CreditWalletHeaders.IdempotencyKey].FirstOrDefault()?.Trim()
            ?? throw new InvalidOperationException("Idempotency-Key header is required.");
    }

    private static async Task<IResult> ExecuteMutationAsync<TResponse>(
        HttpContext context,
        ILoggerFactory loggerFactory,
        Func<Task<TResponse>> mutation)
    {
        try
        {
            return Results.Ok(await mutation());
        }
        catch (DurableCreditWalletDomainException error)
        {
            return Results.BadRequest(new ErrorResponse(
                new ErrorDto(error.Code, error.Message),
                context.GetCorrelationId()));
        }
        catch (Npgsql.PostgresException error)
        {
            var mapped = MapPostgresCreditError(error.MessageText);
            return Results.BadRequest(new ErrorResponse(
                new ErrorDto(mapped.Code, mapped.Message),
                context.GetCorrelationId()));
        }
        catch (Exception error) when (error is DurableCreditWalletRepositoryException or Npgsql.NpgsqlException or InvalidOperationException or TimeoutException)
        {
            loggerFactory
                .CreateLogger("CreditWalletCommandEndpoints")
                .LogWarning(error, "Credit wallet durable mutation failed.");

            return Results.Json(
                new ErrorResponse(
                    new ErrorDto(
                        CreditWalletErrorCodes.InternalError,
                        "Credit wallet durable mutation is unavailable."),
                    context.GetCorrelationId()),
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    private static (string Code, string Message) MapPostgresCreditError(string message)
    {
        if (message.Contains("Insufficient available credit", StringComparison.OrdinalIgnoreCase))
        {
            return (CreditWalletErrorCodes.InsufficientAvailable, message);
        }

        if (message.Contains("not found", StringComparison.OrdinalIgnoreCase))
        {
            return (CreditWalletErrorCodes.ReservationNotFound, message);
        }

        if (message.Contains("settlement", StringComparison.OrdinalIgnoreCase))
        {
            return (CreditWalletErrorCodes.InvalidSettlement, message);
        }

        if (message.Contains("release", StringComparison.OrdinalIgnoreCase))
        {
            return (CreditWalletErrorCodes.InvalidRelease, message);
        }

        return (CreditWalletErrorCodes.ValidationFailed, message);
    }

    private static async Task<IResult> ExecuteReadAsync(
        HttpContext context,
        CreditWalletContractService service,
        ILoggerFactory loggerFactory,
        Func<CancellationToken, Task<IResult>> read)
    {
        try
        {
            return await read(context.RequestAborted);
        }
        catch (DurableCreditWalletRepositoryException error)
        {
            return DurableReadUnavailable(context, service, error.Message);
        }
        catch (Exception error) when (error is Npgsql.NpgsqlException or InvalidOperationException or TimeoutException)
        {
            loggerFactory
                .CreateLogger("CreditWalletQueryEndpoints")
                .LogWarning(error, "Credit wallet durable read failed.");

            return DurableReadUnavailable(context, service, "Credit wallet durable persistence is unavailable.");
        }
    }

    private static IResult DurableReadUnavailable(
        HttpContext context,
        CreditWalletContractService service,
        string reason)
    {
        _ = service;
        return Results.Json(
            new ErrorResponse(
                new ErrorDto(
                    CreditWalletErrorCodes.InternalError,
                    reason),
                context.GetCorrelationId()),
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    private static IResult NotFound(HttpContext context, Guid playerId)
    {
        return Results.NotFound(new ErrorResponse(
            new ErrorDto(
                CreditWalletErrorCodes.ReservationNotFound,
                "Credit wallet was not found for the requested player.",
                new Dictionary<string, object?>
                {
                    ["playerId"] = playerId
                }),
            context.GetCorrelationId()));
    }

    private static int ParseCursor(string? cursor)
    {
        return int.TryParse(cursor, out var offset) && offset > 0 ? offset : 0;
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
