using LedgerService.Application;
using LedgerService.Contracts;
using LedgerService.Infrastructure;

namespace LedgerService.Controllers;

public static class LedgerEndpoints
{
    public static void MapLedgerEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/ledger");

        group.MapPost("/entries", (
            HttpContext context,
            CreateLedgerEntryRequest request,
            LedgerContractService ledgerContractService,
            ILoggerFactory loggerFactory) =>
        {
            var correlationId = context.GetCorrelationId();
            var logger = loggerFactory.CreateLogger("LedgerCommandEndpoints");
            logger.LogInformation(
                "Ledger entry placeholder command received. TransactionType: {TransactionType}. Direction: {Direction}.",
                request.TransactionType,
                request.Direction);

            if (IsMissingIdempotencyKey(context))
            {
                return Results.BadRequest(ledgerContractService.CreateMissingIdempotencyKeyError(correlationId));
            }

            if (!ledgerContractService.HasValidMoney(request.Money))
            {
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    "Ledger amount must be a positive integer minor currency value with ISO-4217 currency.",
                    "money"));
            }

            return Results.Json(
                ledgerContractService.CreateNotImplementedError(correlationId),
                statusCode: StatusCodes.Status501NotImplemented);
        });

        group.MapPost("/entries/{ledgerEntryId:guid}/reverse", (
            HttpContext context,
            Guid ledgerEntryId,
            ReverseLedgerEntryRequest request,
            LedgerContractService ledgerContractService,
            ILoggerFactory loggerFactory) =>
        {
            var correlationId = context.GetCorrelationId();
            var logger = loggerFactory.CreateLogger("LedgerCommandEndpoints");
            logger.LogInformation(
                "Ledger reversal placeholder command received. LedgerEntryId: {LedgerEntryId}.",
                ledgerEntryId);

            if (IsMissingIdempotencyKey(context))
            {
                return Results.BadRequest(ledgerContractService.CreateMissingIdempotencyKeyError(correlationId));
            }

            if (string.IsNullOrWhiteSpace(request.Reason))
            {
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    "Reversal reason is required.",
                    "reason"));
            }

            return Results.Json(
                ledgerContractService.CreateNotImplementedError(correlationId),
                statusCode: StatusCodes.Status501NotImplemented);
        });

        group.MapGet("/entries/{ledgerEntryId:guid}", (
            HttpContext context,
            Guid ledgerEntryId,
            LedgerContractService ledgerContractService,
            ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger("LedgerQueryEndpoints");
            logger.LogInformation(
                "Ledger entry placeholder query received. LedgerEntryId: {LedgerEntryId}.",
                ledgerEntryId);

            return Results.Json(
                ledgerContractService.CreateNotImplementedError(context.GetCorrelationId()),
                statusCode: StatusCodes.Status501NotImplemented);
        });

        group.MapGet("/accounts/{accountId:guid}/entries", (
            HttpContext context,
            Guid accountId,
            Guid? walletId,
            LedgerTransactionType? transactionType,
            LedgerDirection? direction,
            string? referenceType,
            string? referenceId,
            DateTimeOffset? createdFrom,
            DateTimeOffset? createdTo,
            int? limit,
            string? cursor,
            string? sort,
            LedgerContractService ledgerContractService,
            ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger("LedgerQueryEndpoints");
            logger.LogInformation(
                "Ledger account entries placeholder query received. AccountId: {AccountId}.",
                accountId);

            if (limit is < 1 or > 250)
            {
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    context.GetCorrelationId(),
                    "Limit must be between 1 and 250.",
                    "limit"));
            }

            if (sort is not null && sort is not "createdAt.asc" and not "createdAt.desc")
            {
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    context.GetCorrelationId(),
                    "Sort must be createdAt.asc or createdAt.desc.",
                    "sort"));
            }

            _ = walletId;
            _ = transactionType;
            _ = direction;
            _ = referenceType;
            _ = referenceId;
            _ = createdFrom;
            _ = createdTo;
            _ = cursor;

            return Results.Json(
                ledgerContractService.CreateNotImplementedError(context.GetCorrelationId()),
                statusCode: StatusCodes.Status501NotImplemented);
        });

        group.MapPost("/shadow/execute", async (
            HttpContext context,
            LedgerShadowExecuteRequest request,
            LedgerShadowCalculator shadowCalculator,
            LedgerShadowPersistence shadowPersistence,
            ILoggerFactory loggerFactory,
            CancellationToken cancellationToken) =>
        {
            var correlationId = string.IsNullOrWhiteSpace(request.CorrelationId)
                ? context.GetCorrelationId()
                : request.CorrelationId.Trim();
            var logger = loggerFactory.CreateLogger("LedgerShadowEndpoints");

            logger.LogInformation(
                "Ledger shadow execution requested. TransactionId: {TransactionId}. EntryType: {EntryType}. CorrelationId: {CorrelationId}.",
                request.TransactionId,
                request.EntryType,
                correlationId);

            var normalizedRequest = request with { CorrelationId = correlationId };

            try
            {
                var evaluation = shadowCalculator.Evaluate(normalizedRequest);
                var persistedRunId = await shadowPersistence.PersistRunAsync(
                    normalizedRequest,
                    evaluation,
                    cancellationToken);

                return Results.Ok(new LedgerShadowExecuteResponse(
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
                        ["transactionId"] = request.TransactionId,
                        ["entryType"] = request.EntryType,
                        ["amountMinor"] = request.AmountMinor,
                        ["currency"] = request.Currency
                    },
                    cancellationToken);

                return Results.BadRequest(new ErrorResponse(
                    new ErrorDto(
                        LedgerErrorCodes.ValidationFailed,
                        error.Message),
                    correlationId));
            }
            catch (Exception error)
            {
                logger.LogError(
                    error,
                    "Ledger shadow execution failed. TransactionId: {TransactionId}. CorrelationId: {CorrelationId}.",
                    request.TransactionId,
                    correlationId);

                await shadowPersistence.PersistFailureAsync(
                    normalizedRequest,
                    correlationId,
                    "INTERNAL_ERROR",
                    "Ledger shadow execution failed.",
                    new Dictionary<string, object?>
                    {
                        ["transactionId"] = request.TransactionId,
                        ["error"] = error.Message
                    },
                    cancellationToken);

                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(
                            LedgerErrorCodes.InternalError,
                            "Ledger shadow execution failed."),
                        correlationId),
                    statusCode: StatusCodes.Status500InternalServerError);
            }
        });
    }

    private static bool IsMissingIdempotencyKey(HttpContext context)
    {
        var value = context.Request.Headers[LedgerHeaders.IdempotencyKey].FirstOrDefault();

        return string.IsNullOrWhiteSpace(value);
    }
}
