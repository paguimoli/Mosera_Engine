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
            DurableLedgerService durableLedgerService,
            LedgerPostingService ledgerPostingService,
            LedgerContractService ledgerContractService,
            ILoggerFactory loggerFactory) =>
        {
            var correlationId = context.GetCorrelationId();
            var idempotencyKey = GetIdempotencyKey(context);
            var logger = loggerFactory.CreateLogger("LedgerCommandEndpoints");
            logger.LogInformation(
                "Ledger entry command received. TransactionType: {TransactionType}. Direction: {Direction}.",
                request.TransactionType,
                request.Direction);

            if (string.IsNullOrWhiteSpace(idempotencyKey))
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

            var canonicalValidationErrors = ledgerContractService.ValidateCanonicalPostingRequest(
                request,
                idempotencyKey);
            if (canonicalValidationErrors.Count > 0)
            {
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    string.Join(" ", canonicalValidationErrors),
                    "canonicalRequest"));
            }

            if (!durableLedgerService.MutationCapabilityEnabled)
            {
                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(
                            LedgerErrorCodes.InternalError,
                            "Ledger durable persistence is not configured."),
                        correlationId),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }

            try
            {
                var result = ledgerPostingService.PostAsync(
                    request,
                    idempotencyKey,
                    correlationId,
                    context.RequestAborted).GetAwaiter().GetResult();

                return Results.Ok(new LedgerEntryResponse(
                    result.LedgerEntry,
                    correlationId,
                    result.PostingRequest.Id,
                    result.PostingRequest.JournalTransactionId));
            }
            catch (Exception error) when (DurableLedgerService.IsBusinessRuleError(error))
            {
                logger.LogWarning(error, "Ledger entry command failed validation.");
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    error.Message,
                    "ledgerEntry"));
            }
            catch (FinancialPostingCatalogException error)
            {
                logger.LogWarning(error, "Ledger posting catalog validation failed.");
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    error.Message,
                    "postingRule"));
            }
            catch (LedgerAccountingPeriodException error)
            {
                logger.LogWarning(error, "Ledger accounting-period validation failed.");
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    error.Message,
                    "accountingPeriod"));
            }
            catch (DurableLedgerIdempotencyConflictException error)
            {
                logger.LogWarning(error, "Ledger entry command failed idempotency conflict validation.");
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto(
                        LedgerErrorCodes.IdempotencyConflict,
                        "Idempotency key already exists for a different canonical ledger request."),
                    correlationId));
            }
            catch (LedgerPostingRequestConflictException error)
            {
                logger.LogWarning(error, "Ledger posting request failed durable idempotency conflict validation.");
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto(
                        LedgerErrorCodes.IdempotencyConflict,
                        "Idempotency key already exists for a different durable Ledger posting request."),
                    correlationId));
            }
            catch (LedgerUnknownResultException error)
            {
                logger.LogError(error, "Ledger posting result could not be proven.");
                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(LedgerErrorCodes.UnknownResult, error.Message),
                        correlationId),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
            catch (DurableLedgerRepositoryException error)
            {
                logger.LogWarning(error, "Ledger entry command failed repository validation.");
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    error.Message,
                    "ledgerEntry"));
            }
        });

        group.MapPost("/entries/{ledgerEntryId:guid}/reverse", (
            HttpContext context,
            Guid ledgerEntryId,
            ReverseLedgerEntryRequest request,
            DurableLedgerService durableLedgerService,
            LedgerPostingService ledgerPostingService,
            LedgerContractService ledgerContractService,
            ILoggerFactory loggerFactory) =>
        {
            var correlationId = context.GetCorrelationId();
            var idempotencyKey = GetIdempotencyKey(context);
            var logger = loggerFactory.CreateLogger("LedgerCommandEndpoints");
            logger.LogInformation(
                "Ledger reversal command received. LedgerEntryId: {LedgerEntryId}.",
                ledgerEntryId);

            if (string.IsNullOrWhiteSpace(idempotencyKey))
            {
                return Results.BadRequest(ledgerContractService.CreateMissingIdempotencyKeyError(correlationId));
            }

            var canonicalValidationErrors = ledgerContractService.ValidateCanonicalReversalRequest(
                ledgerEntryId,
                request,
                idempotencyKey);
            if (canonicalValidationErrors.Count > 0)
            {
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    string.Join(" ", canonicalValidationErrors),
                    "canonicalRequest"));
            }

            if (!durableLedgerService.MutationCapabilityEnabled)
            {
                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(
                            LedgerErrorCodes.InternalError,
                            "Ledger durable persistence is not configured."),
                        correlationId),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }

            try
            {
                var result = ledgerPostingService.ReverseAsync(
                    ledgerEntryId,
                    request,
                    idempotencyKey,
                    correlationId,
                    context.RequestAborted).GetAwaiter().GetResult();

                return result is null
                    ? Results.NotFound(new ErrorResponse(
                        new ErrorDto(
                            LedgerErrorCodes.EntryNotFound,
                            "Ledger entry was not found."),
                        correlationId))
                    : Results.Ok(new LedgerEntryResponse(
                        result.LedgerEntry,
                        correlationId,
                        result.PostingRequest.Id,
                        result.PostingRequest.JournalTransactionId));
            }
            catch (Exception error) when (DurableLedgerService.IsBusinessRuleError(error))
            {
                logger.LogWarning(error, "Ledger reversal command failed validation.");
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    error.Message,
                    "ledgerEntry"));
            }
            catch (LedgerAccountingPeriodException error)
            {
                logger.LogWarning(error, "Ledger reversal accounting-period validation failed.");
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    error.Message,
                    "accountingPeriod"));
            }
            catch (DurableLedgerIdempotencyConflictException error)
            {
                logger.LogWarning(error, "Ledger reversal command failed idempotency conflict validation.");
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto(
                        LedgerErrorCodes.IdempotencyConflict,
                        "Idempotency key already exists for a different canonical ledger reversal."),
                    correlationId));
            }
            catch (LedgerPostingRequestConflictException error)
            {
                logger.LogWarning(error, "Ledger reversal request failed durable idempotency conflict validation.");
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto(
                        LedgerErrorCodes.IdempotencyConflict,
                        "Idempotency key already exists for a different durable Ledger reversal request."),
                    correlationId));
            }
            catch (DurableLedgerReversalConflictException error)
            {
                logger.LogWarning(error, "Ledger reversal command failed reversal conflict validation.");
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto(
                        LedgerErrorCodes.ReversalNotAllowed,
                        error.Message),
                    correlationId));
            }
            catch (DurableLedgerRepositoryException error)
            {
                logger.LogWarning(error, "Ledger reversal command failed repository validation.");
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    error.Message,
                    "ledgerEntry"));
            }
            catch (LedgerUnknownResultException error)
            {
                logger.LogError(error, "Ledger reversal result could not be proven.");
                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(LedgerErrorCodes.UnknownResult, error.Message),
                        correlationId),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });

        group.MapGet("/entries/{ledgerEntryId:guid}", (
            HttpContext context,
            Guid ledgerEntryId,
            DurableLedgerService durableLedgerService,
            LedgerContractService ledgerContractService,
            ILoggerFactory loggerFactory) =>
        {
            var correlationId = context.GetCorrelationId();
            var logger = loggerFactory.CreateLogger("LedgerQueryEndpoints");
            logger.LogInformation(
                "Ledger entry query received. LedgerEntryId: {LedgerEntryId}.",
                ledgerEntryId);

            if (!durableLedgerService.DurablePersistenceConfigured)
            {
                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(
                            LedgerErrorCodes.InternalError,
                            "Ledger durable persistence is not configured."),
                        correlationId),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }

            var ledgerEntry = durableLedgerService.FindEntryAsync(
                ledgerEntryId,
                context.RequestAborted).GetAwaiter().GetResult();

            return ledgerEntry is null
                ? Results.NotFound(new ErrorResponse(
                    new ErrorDto(
                        LedgerErrorCodes.EntryNotFound,
                        "Ledger entry was not found."),
                    correlationId))
                : Results.Ok(new LedgerEntryResponse(ledgerEntry, correlationId));
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
            DurableLedgerService durableLedgerService,
            LedgerContractService ledgerContractService,
            ILoggerFactory loggerFactory) =>
        {
            var correlationId = context.GetCorrelationId();
            var logger = loggerFactory.CreateLogger("LedgerQueryEndpoints");
            logger.LogInformation(
                "Ledger account entries query received. AccountId: {AccountId}.",
                accountId);

            var resolvedLimit = limit ?? 100;

            if (resolvedLimit is < 1 or > 250)
            {
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
                    "Limit must be between 1 and 250.",
                    "limit"));
            }

            if (sort is not null && sort is not "createdAt.asc" and not "createdAt.desc")
            {
                return Results.BadRequest(ledgerContractService.CreateValidationError(
                    correlationId,
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

            if (!durableLedgerService.DurablePersistenceConfigured)
            {
                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(
                            LedgerErrorCodes.InternalError,
                            "Ledger durable persistence is not configured."),
                        correlationId),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }

            var page = durableLedgerService.ListAccountEntriesAsync(
                accountId,
                resolvedLimit,
                cursor,
                sort,
                context.RequestAborted).GetAwaiter().GetResult();

            return Results.Ok(new LedgerEntriesResponse(
                page.Entries,
                new PaginationDto(resolvedLimit, page.NextCursor),
                correlationId));
        });

        group.MapGet("/posting-requests/{requestId:guid}", (
            HttpContext context,
            Guid requestId,
            LedgerPostingService ledgerPostingService) =>
        {
            var request = ledgerPostingService.FindRequestAsync(
                requestId,
                context.RequestAborted).GetAwaiter().GetResult();
            return request is null
                ? Results.NotFound(new ErrorResponse(
                    new ErrorDto(
                        LedgerErrorCodes.PostingRequestNotFound,
                        "Ledger posting request was not found."),
                    context.GetCorrelationId()))
                : Results.Ok(new LedgerPostingRequestResponse(
                    request,
                    context.GetCorrelationId()));
        });

        group.MapGet("/posting-requests/{requestId:guid}/attempts", (
            HttpContext context,
            Guid requestId,
            LedgerPostingService ledgerPostingService) =>
        {
            var attempts = ledgerPostingService.ListAttemptsAsync(
                requestId,
                context.RequestAborted).GetAwaiter().GetResult();
            return Results.Ok(new LedgerPostingAttemptsResponse(
                attempts,
                context.GetCorrelationId()));
        });

        group.MapPost("/posting-requests/{requestId:guid}/recover", (
            HttpContext context,
            Guid requestId,
            LedgerPostingService ledgerPostingService) =>
        {
            try
            {
                var result = ledgerPostingService.RecoverAsync(
                    requestId,
                    context.RequestAborted).GetAwaiter().GetResult();
                return Results.Ok(new LedgerEntryResponse(
                    result.LedgerEntry,
                    context.GetCorrelationId(),
                    result.PostingRequest.Id,
                    result.PostingRequest.JournalTransactionId));
            }
            catch (LedgerPostingRequestNotFoundException)
            {
                return Results.NotFound(new ErrorResponse(
                    new ErrorDto(
                        LedgerErrorCodes.PostingRequestNotFound,
                        "Ledger posting request was not found."),
                    context.GetCorrelationId()));
            }
            catch (LedgerUnknownResultException error)
            {
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto(LedgerErrorCodes.UnknownResult, error.Message),
                    context.GetCorrelationId()));
            }
        });

        group.MapPost("/posting-requests/{requestId:guid}/replay", (
            HttpContext context,
            Guid requestId,
            LedgerPostingService ledgerPostingService) =>
        {
            try
            {
                var evidence = ledgerPostingService.ReplayAsync(
                    requestId,
                    context.RequestAborted).GetAwaiter().GetResult();
                return evidence.Result == LedgerReplayResult.MATCH
                    ? Results.Ok(new LedgerReplayResponse(evidence, context.GetCorrelationId()))
                    : Results.Conflict(new LedgerReplayResponse(evidence, context.GetCorrelationId()));
            }
            catch (LedgerPostingRequestNotFoundException)
            {
                return Results.NotFound(new ErrorResponse(
                    new ErrorDto(
                        LedgerErrorCodes.PostingRequestNotFound,
                        "Ledger posting request was not found."),
                    context.GetCorrelationId()));
            }
            catch (LedgerUnknownResultException error)
            {
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto(LedgerErrorCodes.UnknownResult, error.Message),
                    context.GetCorrelationId()));
            }
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

    private static string? GetIdempotencyKey(HttpContext context)
    {
        return context.Request.Headers[LedgerHeaders.IdempotencyKey].FirstOrDefault()?.Trim();
    }

    private static bool IsMissingIdempotencyKey(HttpContext context)
    {
        return string.IsNullOrWhiteSpace(GetIdempotencyKey(context));
    }
}
