using LedgerService.Application;
using LedgerService.Contracts;

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
    }

    private static bool IsMissingIdempotencyKey(HttpContext context)
    {
        var value = context.Request.Headers[LedgerHeaders.IdempotencyKey].FirstOrDefault();

        return string.IsNullOrWhiteSpace(value);
    }
}
