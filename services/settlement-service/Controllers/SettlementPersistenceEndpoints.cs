using SettlementService.Contracts;
using SettlementService.Infrastructure;
using Npgsql;
using System.Text.Json;

namespace SettlementService.Controllers;

public static class SettlementPersistenceEndpoints
{
    public static void MapSettlementPersistenceEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/v1/settlement/runs");

        app.MapPost("/v1/settlement/resettlements", async (
            HttpContext context,
            CreateResettlementRequest request,
            DurableSettlementRepository repository,
            SettlementLedgerServiceClient ledgerServiceClient,
            SettlementCreditWalletServiceClient creditWalletServiceClient,
            ILoggerFactory loggerFactory) =>
        {
            if (!repository.DurablePersistenceConfigured)
            {
                return DurablePersistenceUnavailable(context);
            }

            var validationErrors = ValidateResettlement(request);
            if (validationErrors.Count > 0)
            {
                return Results.BadRequest(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_RESETTLEMENT_VALIDATION_FAILED", string.Join(" ", validationErrors)),
                    context.GetCorrelationId()));
            }

            try
            {
                var originalRun = await repository.GetRunAsync(request.OriginalRunId.Trim(), context.RequestAborted);
                if (originalRun is null || originalRun.Status != "completed")
                {
                    return Results.NotFound(new ErrorResponse(
                        new ErrorDto("SETTLEMENT_ORIGINAL_RUN_NOT_FOUND", "Original completed settlement run was not found."),
                        context.GetCorrelationId()));
                }

                var originalRecords = await repository.ListRecordsByRunAsync(originalRun.Id, context.RequestAborted);
                var originalEffects = await repository.ListLedgerEffectsByRunAsync(originalRun.Id, context.RequestAborted);
                var selectedOriginalRecords = request.Lines
                    .Select(line => originalRecords.FirstOrDefault(record => record.Id == line.OriginalSettlementRecordId.Trim())
                        ?? throw new InvalidOperationException($"Original settlement record {line.OriginalSettlementRecordId} was not found."))
                    .ToArray();
                var generatedAt = DateTimeOffset.UtcNow;
                var resettlementId = ResolveResettlementId(request);
                var runRequest = BuildResettlementRun(originalRun, request, resettlementId, selectedOriginalRecords, generatedAt);
                var run = await repository.SaveRunAsync(runRequest, context.RequestAborted);
                var existingRecords = await repository.ListRecordsByRunAsync(run.Id, context.RequestAborted);
                var existingEffects = await repository.ListLedgerEffectsByRunAsync(run.Id, context.RequestAborted);
                var existingReferences = ExtractExternalReferences(existingEffects);

                var reversalRecordRequests = request.Lines
                    .Select((line, index) => BuildReversalRecord(run, selectedOriginalRecords[index], resettlementId, generatedAt))
                    .ToArray();
                var correctionRecordRequests = request.Lines
                    .Select((line, index) => BuildCorrectionRecord(run, selectedOriginalRecords[index], line, resettlementId, generatedAt))
                    .ToArray();
                var expectedRecords = reversalRecordRequests.Concat(correctionRecordRequests).ToArray();
                var missingRecords = expectedRecords
                    .Where(record => existingRecords.All(existing => existing.Id != record.Id))
                    .ToArray();
                var appendedRecords = missingRecords.Length > 0
                    ? await repository.AppendRecordsAsync(run.Id, missingRecords, context.RequestAborted)
                    : Array.Empty<SettlementRecordDto>();
                var allRecords = MergeRecords(expectedRecords, existingRecords, appendedRecords);
                var reversalRecords = reversalRecordRequests
                    .Select(record => allRecords.Single(persisted => persisted.Id == record.Id))
                    .ToArray();
                var correctionRecords = correctionRecordRequests
                    .Select(record => allRecords.Single(persisted => persisted.Id == record.Id))
                    .ToArray();

                var provisionalReversalEffects = reversalRecords
                    .Select((record, index) => BuildReversalLedgerEffect(
                        run,
                        record,
                        selectedOriginalRecords[index],
                        originalEffects.FirstOrDefault(effect => effect.SettlementRecordId == selectedOriginalRecords[index].Id),
                        resettlementId,
                        generatedAt,
                        existingReferences))
                    .ToArray();
                var provisionalCorrectionEffects = correctionRecords
                    .Select((record, index) => BuildCorrectionLedgerEffect(
                        run,
                        record,
                        selectedOriginalRecords[index],
                        resettlementId,
                        generatedAt,
                        existingReferences))
                    .ToArray();
                var provisionalEffects = provisionalReversalEffects.Concat(provisionalCorrectionEffects).ToArray();
                var externalReferences = request.IntegrationDryRun
                    ? await ExecuteResettlementIntegrationDryRunAsync(
                        run,
                        request,
                        reversalRecords,
                        correctionRecords,
                        provisionalReversalEffects,
                        provisionalCorrectionEffects,
                        ledgerServiceClient,
                        creditWalletServiceClient,
                        context.GetCorrelationId(),
                        context.RequestAborted,
                        existingReferences)
                    : existingReferences;
                var expectedEffects = reversalRecords
                    .Select((record, index) => BuildReversalLedgerEffect(
                        run,
                        record,
                        selectedOriginalRecords[index],
                        originalEffects.FirstOrDefault(effect => effect.SettlementRecordId == selectedOriginalRecords[index].Id),
                        resettlementId,
                        generatedAt,
                        externalReferences))
                    .Concat(correctionRecords.Select((record, index) => BuildCorrectionLedgerEffect(
                        run,
                        record,
                        selectedOriginalRecords[index],
                        resettlementId,
                        generatedAt,
                        externalReferences)))
                    .ToArray();
                var missingEffects = expectedEffects
                    .Where(effect => existingEffects.All(existing => existing.IdempotencyKey != effect.IdempotencyKey))
                    .ToArray();
                var appendedEffects = missingEffects.Length > 0
                    ? await repository.AppendLedgerEffectsAsync(run.Id, missingEffects, context.RequestAborted)
                    : Array.Empty<SettlementLedgerEffectDto>();
                var allEffects = MergeEffects(expectedEffects, existingEffects, appendedEffects);
                var reversalEffects = expectedEffects
                    .Where(effect => effect.EffectType == "SETTLEMENT_REVERSAL")
                    .Select(effect => allEffects.Single(persisted => persisted.IdempotencyKey == effect.IdempotencyKey))
                    .ToArray();
                var correctionEffects = expectedEffects
                    .Where(effect => effect.EffectType == "SETTLEMENT_CORRECTION")
                    .Select(effect => allEffects.Single(persisted => persisted.IdempotencyKey == effect.IdempotencyKey))
                    .ToArray();

                var completedRun = await repository.SaveRunAsync(
                    BuildResettlementCompletedRun(run, request, allRecords, generatedAt),
                    context.RequestAborted);

                return Results.Ok(new SettlementResettlementResponse(
                    completedRun,
                    selectedOriginalRecords,
                    reversalRecords,
                    correctionRecords,
                    reversalEffects,
                    correctionEffects,
                    externalReferences,
                    false,
                    request.IntegrationDryRun && externalReferences.Any(reference => reference.ReferenceType == "credit_settlement_application"),
                    request.IntegrationDryRun,
                    existingRecords.Count >= expectedRecords.Length && existingEffects.Count >= provisionalEffects.Length,
                    "RESETTLEMENT_DRY_RUN",
                    context.GetCorrelationId()));
            }
            catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation)
            {
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_RESETTLEMENT_DUPLICATE_SCOPE", error.MessageText),
                    context.GetCorrelationId()));
            }
            catch (Exception error) when (error is DurableSettlementRepositoryException or SettlementIntegrationException or NpgsqlException or TimeoutException or InvalidOperationException)
            {
                loggerFactory
                    .CreateLogger("SettlementPersistenceEndpoints")
                    .LogWarning(error, "Settlement durable resettlement dry-run request failed.");

                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(
                            "SETTLEMENT_RESETTLEMENT_UNAVAILABLE",
                            "Settlement durable resettlement dry run is unavailable."),
                        context.GetCorrelationId()),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });

        group.MapPost("", async (
            HttpContext context,
            CreateSettlementRunRequest request,
            DurableSettlementRepository repository,
            ILoggerFactory loggerFactory) =>
        {
            if (!repository.DurablePersistenceConfigured)
            {
                return DurablePersistenceUnavailable(context);
            }

            var validationErrors = ValidateRun(request);
            if (validationErrors.Count > 0)
            {
                return Results.BadRequest(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_VALIDATION_FAILED", string.Join(" ", validationErrors)),
                    context.GetCorrelationId()));
            }

            try
            {
                var run = await repository.SaveRunAsync(request, context.RequestAborted);
                var records = request.Records is { Count: > 0 }
                    ? await repository.AppendRecordsAsync(run.Id, request.Records, context.RequestAborted)
                    : Array.Empty<SettlementRecordDto>();
                var ledgerEffects = request.LedgerEffects is { Count: > 0 }
                    ? await repository.AppendLedgerEffectsAsync(run.Id, request.LedgerEffects, context.RequestAborted)
                    : Array.Empty<SettlementLedgerEffectDto>();

                return Results.Ok(new SettlementRunCreateResponse(
                    run,
                    records,
                    ledgerEffects,
                    context.GetCorrelationId()));
            }
            catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation)
            {
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_DUPLICATE_COMPLETED_SCOPE", error.MessageText),
                    context.GetCorrelationId()));
            }
            catch (PostgresException error)
            {
                return Results.BadRequest(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_PERSISTENCE_REJECTED", error.MessageText),
                    context.GetCorrelationId()));
            }
            catch (Exception error) when (error is DurableSettlementRepositoryException or NpgsqlException or TimeoutException or InvalidOperationException)
            {
                loggerFactory
                    .CreateLogger("SettlementPersistenceEndpoints")
                    .LogWarning(error, "Settlement durable persistence request failed.");

                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(
                            "SETTLEMENT_PERSISTENCE_UNAVAILABLE",
                            "Settlement durable persistence is unavailable."),
                        context.GetCorrelationId()),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });

        group.MapGet("", async (
            HttpContext context,
            string? drawingId,
            DurableSettlementRepository repository) =>
        {
            if (!repository.DurablePersistenceConfigured)
            {
                return DurablePersistenceUnavailable(context);
            }

            var runs = await repository.ListRunsAsync(drawingId, context.RequestAborted);
            return Results.Ok(new
            {
                runs,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/incomplete", async (
            HttpContext context,
            DurableSettlementRepository repository) =>
        {
            if (!repository.DurablePersistenceConfigured)
            {
                return DurablePersistenceUnavailable(context);
            }

            var runs = await repository.ListIncompleteRunsAsync(context.RequestAborted);
            return Results.Ok(new
            {
                runs,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapPost("/{id}/execute", async (
            HttpContext context,
            string id,
            ExecuteSettlementRunRequest request,
            DurableSettlementRepository repository,
            SettlementLedgerServiceClient ledgerServiceClient,
            SettlementCreditWalletServiceClient creditWalletServiceClient,
            ILoggerFactory loggerFactory) =>
        {
            if (!repository.DurablePersistenceConfigured)
            {
                return DurablePersistenceUnavailable(context);
            }

            var validationErrors = ValidateExecution(request);
            if (validationErrors.Count > 0)
            {
                return Results.BadRequest(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_EXECUTION_VALIDATION_FAILED", string.Join(" ", validationErrors)),
                    context.GetCorrelationId()));
            }

            try
            {
                var existingRun = await repository.GetRunAsync(id, context.RequestAborted);
                if (existingRun is null)
                {
                    return Results.NotFound(new ErrorResponse(
                        new ErrorDto("SETTLEMENT_RUN_NOT_FOUND", "Settlement run was not found."),
                        context.GetCorrelationId()));
                }

                var generatedAt = DateTimeOffset.UtcNow;
                var recordsToAppend = request.TicketLines
                    .Select((line, index) => BuildRecord(existingRun, line, index, generatedAt))
                    .ToArray();
                var records = await repository.AppendRecordsAsync(existingRun.Id, recordsToAppend, context.RequestAborted);
                var externalReferences = request.IntegrationDryRun
                    ? await ExecuteIntegrationDryRunAsync(
                        existingRun,
                        records,
                        request.TicketLines,
                        ledgerServiceClient,
                        creditWalletServiceClient,
                        context.GetCorrelationId(),
                        context.RequestAborted)
                    : Array.Empty<SettlementExternalReferenceDto>();
                var ledgerEffectsToAppend = records
                    .Select(record => BuildLedgerEffect(existingRun, record, generatedAt, externalReferences))
                    .ToArray();
                var ledgerEffects = await repository.AppendLedgerEffectsAsync(existingRun.Id, ledgerEffectsToAppend, context.RequestAborted);
                var completedRun = await repository.SaveRunAsync(
                    BuildCompletedRun(existingRun, request, records, generatedAt),
                    context.RequestAborted);

                return Results.Ok(new SettlementRunExecutionResponse(
                    completedRun,
                    records,
                    ledgerEffects,
                    externalReferences,
                    false,
                    request.IntegrationDryRun && externalReferences.Any(reference => reference.ReferenceType == "credit_settlement_application"),
                    request.IntegrationDryRun,
                    "DRY_RUN",
                    context.GetCorrelationId()));
            }
            catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation)
            {
                return Results.Conflict(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_DUPLICATE_COMPLETED_SCOPE", error.MessageText),
                    context.GetCorrelationId()));
            }
            catch (PostgresException error)
            {
                return Results.BadRequest(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_PERSISTENCE_REJECTED", error.MessageText),
                    context.GetCorrelationId()));
            }
            catch (SettlementTargetRejectedException error)
            {
                loggerFactory
                    .CreateLogger("SettlementPersistenceEndpoints")
                    .LogWarning(
                        error,
                        "Settlement integration target {TargetService} rejected the canonical request with status {StatusCode}.",
                        error.TargetService,
                        error.StatusCode);

                var statusCode = error.StatusCode is StatusCodes.Status400BadRequest or StatusCodes.Status409Conflict
                    ? error.StatusCode
                    : StatusCodes.Status502BadGateway;
                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(
                            "SETTLEMENT_INTEGRATION_TARGET_REJECTED",
                            $"{error.TargetService} rejected the canonical settlement request."),
                        context.GetCorrelationId()),
                    statusCode: statusCode);
            }
            catch (Exception error) when (error is DurableSettlementRepositoryException or SettlementIntegrationException or NpgsqlException or TimeoutException or InvalidOperationException)
            {
                loggerFactory
                    .CreateLogger("SettlementPersistenceEndpoints")
                    .LogWarning(error, "Settlement durable execution dry-run request failed.");

                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(
                            "SETTLEMENT_EXECUTION_UNAVAILABLE",
                            "Settlement durable execution dry run is unavailable."),
                        context.GetCorrelationId()),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });

        group.MapPost("/{id}/resume", async (
            HttpContext context,
            string id,
            ResumeSettlementRunRequest request,
            DurableSettlementRepository repository,
            SettlementLedgerServiceClient ledgerServiceClient,
            SettlementCreditWalletServiceClient creditWalletServiceClient,
            ILoggerFactory loggerFactory) =>
        {
            if (!repository.DurablePersistenceConfigured)
            {
                return DurablePersistenceUnavailable(context);
            }

            var validationErrors = ValidateExecution(ToExecuteRequest(request));
            if (validationErrors.Count > 0)
            {
                return Results.BadRequest(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_RESUME_VALIDATION_FAILED", string.Join(" ", validationErrors)),
                    context.GetCorrelationId()));
            }

            SettlementRunDto? runForFailure = null;
            try
            {
                var existingRun = await repository.GetRunAsync(id, context.RequestAborted);
                runForFailure = existingRun;
                if (existingRun is null)
                {
                    return Results.NotFound(new ErrorResponse(
                        new ErrorDto("SETTLEMENT_RUN_NOT_FOUND", "Settlement run was not found."),
                        context.GetCorrelationId()));
                }

                var existingRecords = await repository.ListRecordsByRunAsync(existingRun.Id, context.RequestAborted);
                var existingEffects = await repository.ListLedgerEffectsByRunAsync(existingRun.Id, context.RequestAborted);
                var existingExternalReferences = ExtractExternalReferences(existingEffects);
                var beforeDiagnostics = BuildRecoveryDiagnostics(
                    existingRun,
                    request.TicketLines.Count,
                    existingRecords,
                    existingEffects,
                    existingExternalReferences);

                if (!IsStateConsistent(request.TicketLines, existingRecords, existingEffects, out var inconsistencyReason))
                {
                    return Results.Conflict(new ErrorResponse(
                        new ErrorDto("SETTLEMENT_RESUME_INCONSISTENT_STATE", inconsistencyReason),
                        context.GetCorrelationId()));
                }

                if (existingRun.Status == "completed" &&
                    beforeDiagnostics.MissingRecordCount == 0 &&
                    beforeDiagnostics.MissingLedgerEffectCount == 0 &&
                    !beforeDiagnostics.IsPartiallyIntegrated)
                {
                    return Results.Ok(new SettlementRunResumeResponse(
                        existingRun,
                        existingRecords,
                        existingEffects,
                        existingExternalReferences,
                        beforeDiagnostics,
                        false,
                        request.IntegrationDryRun && existingExternalReferences.Any(reference => reference.ReferenceType == "credit_settlement_application"),
                        request.IntegrationDryRun,
                        true,
                        "RESUME_DRY_RUN",
                        context.GetCorrelationId()));
                }

                var generatedAt = DateTimeOffset.UtcNow;
                var expectedRecords = request.TicketLines
                    .Select((line, index) => BuildRecord(existingRun, line, index, generatedAt))
                    .ToArray();
                var missingRecords = expectedRecords
                    .Where(record => existingRecords.All(existing => existing.Id != record.Id))
                    .ToArray();
                var appendedRecords = missingRecords.Length > 0
                    ? await repository.AppendRecordsAsync(existingRun.Id, missingRecords, context.RequestAborted)
                    : Array.Empty<SettlementRecordDto>();
                var allRecords = MergeRecords(expectedRecords, existingRecords, appendedRecords);

                var externalReferences = request.IntegrationDryRun
                    ? await ExecuteIntegrationDryRunAsync(
                        existingRun,
                        allRecords,
                        request.TicketLines,
                        ledgerServiceClient,
                        creditWalletServiceClient,
                        context.GetCorrelationId(),
                        context.RequestAborted,
                        existingExternalReferences)
                    : existingExternalReferences;
                var expectedEffects = allRecords
                    .Select(record => BuildLedgerEffect(existingRun, record, generatedAt, externalReferences))
                    .ToArray();
                var missingEffects = expectedEffects
                    .Where(effect => existingEffects.All(existing => existing.IdempotencyKey != effect.IdempotencyKey))
                    .ToArray();
                var appendedEffects = missingEffects.Length > 0
                    ? await repository.AppendLedgerEffectsAsync(existingRun.Id, missingEffects, context.RequestAborted)
                    : Array.Empty<SettlementLedgerEffectDto>();
                var allEffects = MergeEffects(expectedEffects, existingEffects, appendedEffects);

                var completedRun = await repository.SaveRunAsync(
                    BuildCompletedRun(existingRun, ToExecuteRequest(request), allRecords, generatedAt),
                    context.RequestAborted);
                var afterDiagnostics = BuildRecoveryDiagnostics(
                    completedRun,
                    request.TicketLines.Count,
                    allRecords,
                    allEffects,
                    externalReferences);

                return Results.Ok(new SettlementRunResumeResponse(
                    completedRun,
                    allRecords,
                    allEffects,
                    externalReferences,
                    afterDiagnostics,
                    false,
                    request.IntegrationDryRun && externalReferences.Any(reference => reference.ReferenceType == "credit_settlement_application"),
                    request.IntegrationDryRun,
                    false,
                    "RESUME_DRY_RUN",
                    context.GetCorrelationId()));
            }
            catch (PostgresException error)
            {
                return Results.BadRequest(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_RESUME_PERSISTENCE_REJECTED", error.MessageText),
                    context.GetCorrelationId()));
            }
            catch (Exception error) when (error is DurableSettlementRepositoryException or SettlementIntegrationException or NpgsqlException or TimeoutException or InvalidOperationException)
            {
                if (runForFailure is not null)
                {
                    await MarkResumeFailedAsync(repository, runForFailure, error, context.RequestAborted);
                }

                loggerFactory
                    .CreateLogger("SettlementPersistenceEndpoints")
                    .LogWarning(error, "Settlement durable resume request failed.");

                return Results.Json(
                    new ErrorResponse(
                        new ErrorDto(
                            "SETTLEMENT_RESUME_UNAVAILABLE",
                            "Settlement durable resume is unavailable."),
                        context.GetCorrelationId()),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });

        group.MapGet("/recovery/diagnostics", async (
            HttpContext context,
            DurableSettlementRepository repository) =>
        {
            if (!repository.DurablePersistenceConfigured)
            {
                return DurablePersistenceUnavailable(context);
            }

            var runs = await repository.ListRunsAsync(null, context.RequestAborted);
            var diagnostics = new List<SettlementRecoveryDiagnosticsDto>();
            foreach (var run in runs)
            {
                var records = await repository.ListRecordsByRunAsync(run.Id, context.RequestAborted);
                var effects = await repository.ListLedgerEffectsByRunAsync(run.Id, context.RequestAborted);
                diagnostics.Add(BuildRecoveryDiagnostics(
                    run,
                    Math.Max(run.ExpectedLineCount, records.Count),
                    records,
                    effects,
                    ExtractExternalReferences(effects)));
            }

            return Results.Ok(new SettlementRecoveryDiagnosticsResponse(
                diagnostics.Where(diagnostic => diagnostic.IsIncomplete).ToArray(),
                diagnostics.Where(diagnostic => diagnostic.IsFailed).ToArray(),
                diagnostics.Where(diagnostic => diagnostic.IsPartiallyIntegrated).ToArray(),
                context.GetCorrelationId()));
        });

        group.MapGet("/{id}", async (
            HttpContext context,
            string id,
            DurableSettlementRepository repository) =>
        {
            if (!repository.DurablePersistenceConfigured)
            {
                return DurablePersistenceUnavailable(context);
            }

            var run = await repository.GetRunAsync(id, context.RequestAborted);
            return run is null
                ? Results.NotFound(new ErrorResponse(
                    new ErrorDto("SETTLEMENT_RUN_NOT_FOUND", "Settlement run was not found."),
                    context.GetCorrelationId()))
                : Results.Ok(new
                {
                    run,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/{id}/records", async (
            HttpContext context,
            string id,
            DurableSettlementRepository repository) =>
        {
            if (!repository.DurablePersistenceConfigured)
            {
                return DurablePersistenceUnavailable(context);
            }

            var records = await repository.ListRecordsByRunAsync(id, context.RequestAborted);
            return Results.Ok(new
            {
                records,
                correlationId = context.GetCorrelationId()
            });
        });
    }

    private static IResult DurablePersistenceUnavailable(HttpContext context)
    {
        return Results.Json(
            new ErrorResponse(
                new ErrorDto(
                    "SETTLEMENT_DURABLE_PERSISTENCE_DISABLED",
                    "Settlement durable persistence is not configured."),
                context.GetCorrelationId()),
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    private static List<string> ValidateRun(CreateSettlementRunRequest request)
    {
        var errors = new List<string>();

        if (string.IsNullOrWhiteSpace(request.DrawingId))
        {
            errors.Add("drawingId is required.");
        }

        if (string.IsNullOrWhiteSpace(request.GameId))
        {
            errors.Add("gameId is required.");
        }

        if (string.IsNullOrWhiteSpace(request.Status))
        {
            errors.Add("status is required.");
        }

        return errors;
    }

    private static List<string> ValidateExecution(ExecuteSettlementRunRequest request)
    {
        var errors = new List<string>();

        if (request.TicketLines is not { Count: > 0 })
        {
            errors.Add("ticketLines must include at least one line.");
            return errors;
        }

        foreach (var line in request.TicketLines)
        {
            if (string.IsNullOrWhiteSpace(line.TicketId))
            {
                errors.Add("ticketId is required.");
            }

            if (string.IsNullOrWhiteSpace(line.TicketLineId))
            {
                errors.Add("ticketLineId is required.");
            }

            if (string.IsNullOrWhiteSpace(line.AccountId))
            {
                errors.Add("accountId is required.");
            }

            if (string.IsNullOrWhiteSpace(line.WagerTypeId))
            {
                errors.Add("wagerTypeId is required.");
            }

            if (line.Stake < 0)
            {
                errors.Add("stake must be greater than or equal to zero.");
            }

            if (line.Payout < 0)
            {
                errors.Add("payout must be greater than or equal to zero.");
            }

            if (request.IntegrationDryRun && line.LedgerWalletId is null)
            {
                errors.Add("ledgerWalletId is required when integrationDryRun is true.");
            }
        }

        return errors;
    }

    private static List<string> ValidateResettlement(CreateResettlementRequest request)
    {
        var errors = new List<string>();

        if (string.IsNullOrWhiteSpace(request.OriginalRunId))
        {
            errors.Add("originalRunId is required.");
        }

        if (request.Lines is not { Count: > 0 })
        {
            errors.Add("lines must include at least one resettlement line.");
            return errors;
        }

        foreach (var line in request.Lines)
        {
            if (string.IsNullOrWhiteSpace(line.OriginalSettlementRecordId))
            {
                errors.Add("originalSettlementRecordId is required.");
            }

            if (line.CorrectedStake < 0)
            {
                errors.Add("correctedStake must be greater than or equal to zero.");
            }

            if (line.CorrectedPayout < 0)
            {
                errors.Add("correctedPayout must be greater than or equal to zero.");
            }

            if (request.IntegrationDryRun && line.LedgerWalletId is null)
            {
                errors.Add("ledgerWalletId is required when integrationDryRun is true.");
            }
        }

        return errors;
    }

    private static string ResolveResettlementId(CreateResettlementRequest request)
    {
        return string.IsNullOrWhiteSpace(request.ResettlementId)
            ? BuildDeterministicId(
                "resettlement",
                request.OriginalRunId,
                string.Join("-", request.Lines.Select(line => line.OriginalSettlementRecordId)))
            : request.ResettlementId.Trim();
    }

    private static CreateSettlementRunRequest BuildResettlementRun(
        SettlementRunDto originalRun,
        CreateResettlementRequest request,
        string resettlementId,
        IReadOnlyList<SettlementRecordDto> originalRecords,
        DateTimeOffset generatedAt)
    {
        return new CreateSettlementRunRequest(
            BuildDeterministicId("settlement-resettlement-run", originalRun.Id, resettlementId),
            $"{originalRun.DrawingId}:resettlement:{resettlementId}",
            originalRun.GameId,
            "running",
            originalRecords.Select(record => record.TicketId).Distinct(StringComparer.Ordinal).Count(),
            originalRecords.Count * 2,
            generatedAt,
            null,
            BuildDeterministicId("settlement-resettlement-execution", originalRun.Id, resettlementId),
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            originalRun.DrawToSettlementMs,
            Math.Max(originalRun.PeakConcurrentSettlements, 1),
            $"resettlement dry run for originalRunId={originalRun.Id}; integrationDryRun={request.IntegrationDryRun}",
            null,
            originalRun.RecordHash,
            "settlement-service-resettlement-dry-run-v1",
            generatedAt,
            null,
            null);
    }

    private static CreateSettlementRecordRequest BuildReversalRecord(
        SettlementRunDto resettlementRun,
        SettlementRecordDto originalRecord,
        string resettlementId,
        DateTimeOffset generatedAt)
    {
        return new CreateSettlementRecordRequest(
            BuildDeterministicId("settlement-resettlement-reversal-record", resettlementRun.Id, originalRecord.Id, resettlementId),
            originalRecord.TicketId,
            originalRecord.TicketLineId,
            originalRecord.AccountId,
            originalRecord.GameId,
            originalRecord.DrawingId,
            originalRecord.WagerTypeId,
            originalRecord.WagerOptionId,
            originalRecord.Stake,
            0,
            decimal.Negate(originalRecord.NetAmount),
            "void",
            "reversed",
            originalRecord.Version + 1,
            originalRecord.Id,
            originalRecord.Id,
            Array.Empty<string>(),
            null,
            originalRecord.RecordHash,
            "settlement-service-resettlement-dry-run-v1",
            generatedAt);
    }

    private static CreateSettlementRecordRequest BuildCorrectionRecord(
        SettlementRunDto resettlementRun,
        SettlementRecordDto originalRecord,
        SettlementResettlementLineRequest line,
        string resettlementId,
        DateTimeOffset generatedAt)
    {
        var stake = decimal.Round(line.CorrectedStake, 2);
        var payout = decimal.Round(line.CorrectedPayout, 2);
        var netAmount = payout - stake;
        var outcome = netAmount > 0
            ? "win"
            : netAmount == 0
                ? "push"
                : "loss";

        return new CreateSettlementRecordRequest(
            BuildDeterministicId("settlement-resettlement-correction-record", resettlementRun.Id, originalRecord.Id, resettlementId),
            originalRecord.TicketId,
            originalRecord.TicketLineId,
            originalRecord.AccountId,
            originalRecord.GameId,
            originalRecord.DrawingId,
            originalRecord.WagerTypeId,
            originalRecord.WagerOptionId,
            stake,
            payout,
            netAmount,
            outcome,
            "settled",
            originalRecord.Version + 2,
            originalRecord.Id,
            originalRecord.Id,
            Array.Empty<string>(),
            null,
            originalRecord.RecordHash,
            "settlement-service-resettlement-dry-run-v1",
            generatedAt);
    }

    private static CreateSettlementLedgerEffectRequest BuildReversalLedgerEffect(
        SettlementRunDto resettlementRun,
        SettlementRecordDto reversalRecord,
        SettlementRecordDto originalRecord,
        SettlementLedgerEffectDto? originalEffect,
        string resettlementId,
        DateTimeOffset generatedAt,
        IReadOnlyList<SettlementExternalReferenceDto> externalReferences)
    {
        var amount = originalEffect is { Amount: > 0 }
            ? originalEffect.Amount
            : Math.Max(originalRecord.Payout, 0);
        var direction = originalEffect?.Direction == "CREDIT" ? "DEBIT" : originalEffect?.Direction == "DEBIT" ? "CREDIT" : "NOOP";
        if (amount <= 0)
        {
            direction = "NOOP";
        }

        return new CreateSettlementLedgerEffectRequest(
            BuildDeterministicId("settlement-resettlement-reversal-effect", resettlementRun.Id, originalRecord.Id, resettlementId),
            reversalRecord.Id,
            reversalRecord.TicketId,
            reversalRecord.TicketLineId,
            reversalRecord.DrawingId,
            reversalRecord.AccountId,
            "SETTLEMENT_REVERSAL",
            amount > 0 ? "REVERSAL" : "SETTLEMENT_DEBIT",
            direction,
            decimal.Round(amount, 2),
            BuildDeterministicId("settlement-resettlement-reversal", resettlementRun.Id, originalRecord.Id, resettlementId),
            amount > 0 ? "SKIPPED" : "NO_OP",
            "settlement_record",
            reversalRecord.Id,
            originalEffect?.Id,
            BuildEffectMetadata(
                "RESETTLEMENT_DRY_RUN",
                externalReferences,
                reversalRecord.Id,
                new Dictionary<string, object?>
                {
                    ["resettlementId"] = resettlementId,
                    ["originalSettlementRunId"] = originalRecord.SettlementRunId,
                    ["originalSettlementRecordId"] = originalRecord.Id,
                    ["originalSettlementLedgerEffectId"] = originalEffect?.Id
                }),
            generatedAt);
    }

    private static CreateSettlementLedgerEffectRequest BuildCorrectionLedgerEffect(
        SettlementRunDto resettlementRun,
        SettlementRecordDto correctionRecord,
        SettlementRecordDto originalRecord,
        string resettlementId,
        DateTimeOffset generatedAt,
        IReadOnlyList<SettlementExternalReferenceDto> externalReferences)
    {
        var amount = Math.Max(correctionRecord.Payout, 0);

        return new CreateSettlementLedgerEffectRequest(
            BuildDeterministicId("settlement-resettlement-correction-effect", resettlementRun.Id, originalRecord.Id, resettlementId),
            correctionRecord.Id,
            correctionRecord.TicketId,
            correctionRecord.TicketLineId,
            correctionRecord.DrawingId,
            correctionRecord.AccountId,
            "SETTLEMENT_CORRECTION",
            amount > 0 ? "SETTLEMENT_CREDIT" : "SETTLEMENT_DEBIT",
            amount > 0 ? "CREDIT" : "NOOP",
            decimal.Round(amount, 2),
            BuildDeterministicId("settlement-resettlement-correction", resettlementRun.Id, originalRecord.Id, resettlementId),
            amount > 0 ? "SKIPPED" : "NO_OP",
            "settlement_record",
            correctionRecord.Id,
            null,
            BuildEffectMetadata(
                "RESETTLEMENT_DRY_RUN",
                externalReferences,
                correctionRecord.Id,
                new Dictionary<string, object?>
                {
                    ["resettlementId"] = resettlementId,
                    ["originalSettlementRunId"] = originalRecord.SettlementRunId,
                    ["originalSettlementRecordId"] = originalRecord.Id
                }),
            generatedAt);
    }

    private static CreateSettlementRecordRequest BuildRecord(
        SettlementRunDto run,
        SettlementExecutionTicketLineRequest line,
        int index,
        DateTimeOffset generatedAt)
    {
        var payout = decimal.Round(line.Payout, 2);
        var stake = decimal.Round(line.Stake, 2);
        var netAmount = payout - stake;
        var outcome = netAmount > 0
            ? "win"
            : netAmount == 0
                ? "push"
                : "loss";

        return new CreateSettlementRecordRequest(
            BuildDeterministicId("settlement-record", run.Id, line.TicketId, line.TicketLineId, index.ToString()),
            line.TicketId,
            line.TicketLineId,
            line.AccountId,
            string.IsNullOrWhiteSpace(line.GameId) ? run.GameId : line.GameId.Trim(),
            string.IsNullOrWhiteSpace(line.DrawingId) ? run.DrawingId : line.DrawingId.Trim(),
            line.WagerTypeId,
            line.WagerOptionId,
            stake,
            payout,
            netAmount,
            outcome,
            "settled",
            1,
            null,
            null,
            Array.Empty<string>(),
            null,
            null,
            "settlement-service-dry-run-v1",
            generatedAt);
    }

    private static CreateSettlementLedgerEffectRequest BuildLedgerEffect(
        SettlementRunDto run,
        SettlementRecordDto record,
        DateTimeOffset generatedAt,
        IReadOnlyList<SettlementExternalReferenceDto> externalReferences)
    {
        var hasPositivePayout = record.Payout > 0;
        var effectType = record.Outcome switch
        {
            "win" => "WIN_PAYOUT",
            "push" => "PUSH_REFUND",
            _ => "LOSS_RECOGNITION_NOOP"
        };
        var amount = hasPositivePayout ? record.Payout : 0;
        var recordExternalReferences = externalReferences
            .Where(reference => reference.SettlementRecordId == record.Id)
            .Select(reference => new Dictionary<string, object?>
            {
                ["referenceType"] = reference.ReferenceType,
                ["referenceId"] = reference.ReferenceId,
                ["idempotencyKey"] = reference.IdempotencyKey,
                ["status"] = reference.Status
            })
            .ToArray();

        return new CreateSettlementLedgerEffectRequest(
            BuildDeterministicId("settlement-ledger-effect", run.Id, record.Id),
            record.Id,
            record.TicketId,
            record.TicketLineId,
            record.DrawingId,
            record.AccountId,
            effectType,
            hasPositivePayout ? "SETTLEMENT_CREDIT" : "SETTLEMENT_DEBIT",
            hasPositivePayout ? "CREDIT" : "NOOP",
            decimal.Round(amount, 2),
            BuildDeterministicId("settlement-service-dry-run", run.Id, record.Id),
            hasPositivePayout ? "SKIPPED" : "NO_OP",
            "settlement_record",
            record.Id,
            null,
            new Dictionary<string, object?>
            {
                ["executionMode"] = "DRY_RUN",
                ["authoritativeLedgerPosted"] = false,
                ["creditSettlementApplied"] = false,
                ["source"] = "settlement-service",
                ["externalReferences"] = recordExternalReferences
            },
            generatedAt);
    }

    private static IReadOnlyDictionary<string, object?> BuildEffectMetadata(
        string executionMode,
        IReadOnlyList<SettlementExternalReferenceDto> externalReferences,
        string settlementRecordId,
        IReadOnlyDictionary<string, object?> extra)
    {
        var recordExternalReferences = externalReferences
            .Where(reference => reference.SettlementRecordId == settlementRecordId)
            .Select(reference => new Dictionary<string, object?>
            {
                ["referenceType"] = reference.ReferenceType,
                ["referenceId"] = reference.ReferenceId,
                ["idempotencyKey"] = reference.IdempotencyKey,
                ["status"] = reference.Status
            })
            .ToArray();
        var metadata = new Dictionary<string, object?>
        {
            ["executionMode"] = executionMode,
            ["authoritativeLedgerPosted"] = false,
            ["creditSettlementApplied"] = false,
            ["source"] = "settlement-service",
            ["externalReferences"] = recordExternalReferences
        };

        foreach (var item in extra)
        {
            metadata[item.Key] = item.Value;
        }

        return metadata;
    }

    private static async Task<IReadOnlyList<SettlementExternalReferenceDto>> ExecuteIntegrationDryRunAsync(
        SettlementRunDto run,
        IReadOnlyList<SettlementRecordDto> records,
        IReadOnlyList<SettlementExecutionTicketLineRequest> ticketLines,
        SettlementLedgerServiceClient ledgerServiceClient,
        SettlementCreditWalletServiceClient creditWalletServiceClient,
        string correlationId,
        CancellationToken cancellationToken,
        IReadOnlyList<SettlementExternalReferenceDto>? existingReferences = null)
    {
        var externalReferences = new List<SettlementExternalReferenceDto>(existingReferences ?? Array.Empty<SettlementExternalReferenceDto>());

        foreach (var record in records)
        {
            var line = ticketLines.FirstOrDefault(candidate =>
                candidate.TicketId == record.TicketId &&
                candidate.TicketLineId == record.TicketLineId);
            if (line is null)
            {
                throw new SettlementIntegrationException(
                    $"Unable to resolve execution input for settlement record {record.Id}.");
            }

            if (line.LedgerWalletId is null)
            {
                throw new SettlementIntegrationException(
                    $"ledgerWalletId is required for settlement record {record.Id}.");
            }

            var provisionalEffect = ToLedgerEffectDto(
                run,
                record,
                BuildLedgerEffect(run, record, record.CreatedAt, Array.Empty<SettlementExternalReferenceDto>()));
            if (!HasExternalReference(externalReferences, record.Id, "ledger_entry") &&
                !HasExternalReference(externalReferences, record.Id, "ledger_noop"))
            {
                externalReferences.Add(await ledgerServiceClient.PostLedgerEffectAsync(
                    provisionalEffect,
                    line.LedgerWalletId.Value,
                    correlationId,
                    cancellationToken));
            }

            if (line.CreditPlayerId is not null || line.CreditReservationId is not null)
            {
                if (!HasExternalReference(externalReferences, record.Id, "credit_settlement_application") &&
                    !HasExternalReference(externalReferences, record.Id, "credit_settlement"))
                {
                    externalReferences.Add(await creditWalletServiceClient.ApplySettlementAsync(
                        record,
                        line,
                        BuildDeterministicId("credit-settlement-dry-run", run.Id, record.Id),
                        correlationId,
                        cancellationToken));
                }
            }
        }

        return externalReferences;
    }

    private static async Task<IReadOnlyList<SettlementExternalReferenceDto>> ExecuteResettlementIntegrationDryRunAsync(
        SettlementRunDto run,
        CreateResettlementRequest request,
        IReadOnlyList<SettlementRecordDto> reversalRecords,
        IReadOnlyList<SettlementRecordDto> correctionRecords,
        IReadOnlyList<CreateSettlementLedgerEffectRequest> reversalEffects,
        IReadOnlyList<CreateSettlementLedgerEffectRequest> correctionEffects,
        SettlementLedgerServiceClient ledgerServiceClient,
        SettlementCreditWalletServiceClient creditWalletServiceClient,
        string correlationId,
        CancellationToken cancellationToken,
        IReadOnlyList<SettlementExternalReferenceDto>? existingReferences = null)
    {
        var externalReferences = new List<SettlementExternalReferenceDto>(existingReferences ?? Array.Empty<SettlementExternalReferenceDto>());
        var effectsByRecordId = reversalEffects
            .Concat(correctionEffects)
            .ToDictionary(effect => effect.SettlementRecordId, StringComparer.Ordinal);

        foreach (var record in reversalRecords.Concat(correctionRecords))
        {
            var line = request.Lines.FirstOrDefault(candidate =>
                candidate.OriginalSettlementRecordId == record.ReversalOfSettlementRecordId ||
                candidate.OriginalSettlementRecordId == record.PreviousSettlementRecordId);
            if (line is null)
            {
                throw new SettlementIntegrationException($"Unable to resolve resettlement input for settlement record {record.Id}.");
            }

            if (line.LedgerWalletId is null)
            {
                throw new SettlementIntegrationException($"ledgerWalletId is required for resettlement record {record.Id}.");
            }

            if (!effectsByRecordId.TryGetValue(record.Id, out var effect))
            {
                throw new SettlementIntegrationException($"Unable to resolve ledger effect for resettlement record {record.Id}.");
            }

            if (!HasExternalReference(externalReferences, record.Id, "ledger_entry") &&
                !HasExternalReference(externalReferences, record.Id, "ledger_noop"))
            {
                externalReferences.Add(await ledgerServiceClient.PostLedgerEffectAsync(
                    ToLedgerEffectDto(run, record, effect),
                    line.LedgerWalletId.Value,
                    correlationId,
                    cancellationToken));
            }

            if (record.Status == "settled" &&
                (line.CreditPlayerId is not null || line.CreditReservationId is not null) &&
                !HasExternalReference(externalReferences, record.Id, "credit_settlement_application") &&
                !HasExternalReference(externalReferences, record.Id, "credit_settlement"))
            {
                externalReferences.Add(await creditWalletServiceClient.ApplySettlementAsync(
                    record,
                    ToSettlementLine(record, line),
                    BuildDeterministicId("credit-resettlement-dry-run", run.Id, record.Id),
                    correlationId,
                    cancellationToken));
            }
        }

        return externalReferences;
    }

    private static SettlementExecutionTicketLineRequest ToSettlementLine(
        SettlementRecordDto record,
        SettlementResettlementLineRequest line)
    {
        return new SettlementExecutionTicketLineRequest(
            record.TicketId,
            record.TicketLineId,
            record.AccountId,
            line.LedgerWalletId,
            line.CreditPlayerId,
            line.CreditReservationId,
            line.CreditSettlementId,
            line.CreditSettlementBatchId,
            record.GameId,
            record.DrawingId,
            record.WagerTypeId,
            record.WagerOptionId,
            record.Stake,
            record.Payout);
    }

    private static bool HasExternalReference(
        IReadOnlyList<SettlementExternalReferenceDto> references,
        string settlementRecordId,
        string referenceType)
    {
        return references.Any(reference =>
            reference.SettlementRecordId == settlementRecordId &&
            reference.ReferenceType == referenceType &&
            !string.IsNullOrWhiteSpace(reference.ReferenceId));
    }

    private static ExecuteSettlementRunRequest ToExecuteRequest(ResumeSettlementRunRequest request)
    {
        return new ExecuteSettlementRunRequest(
            request.ExecutionId,
            request.IntegrationDryRun,
            request.TicketLines);
    }

    private static IReadOnlyList<SettlementRecordDto> MergeRecords(
        IReadOnlyList<CreateSettlementRecordRequest> expectedRecords,
        IReadOnlyList<SettlementRecordDto> existingRecords,
        IReadOnlyList<SettlementRecordDto> appendedRecords)
    {
        var byId = existingRecords
            .Concat(appendedRecords)
            .ToDictionary(record => record.Id, StringComparer.Ordinal);

        return expectedRecords
            .Select(expected => byId.TryGetValue(expected.Id ?? string.Empty, out var record)
                ? record
                : throw new InvalidOperationException($"Settlement record {expected.Id} was not persisted."))
            .ToArray();
    }

    private static IReadOnlyList<SettlementLedgerEffectDto> MergeEffects(
        IReadOnlyList<CreateSettlementLedgerEffectRequest> expectedEffects,
        IReadOnlyList<SettlementLedgerEffectDto> existingEffects,
        IReadOnlyList<SettlementLedgerEffectDto> appendedEffects)
    {
        var byIdempotencyKey = existingEffects
            .Concat(appendedEffects)
            .ToDictionary(effect => effect.IdempotencyKey, StringComparer.Ordinal);

        return expectedEffects
            .Select(expected => byIdempotencyKey.TryGetValue(expected.IdempotencyKey, out var effect)
                ? effect
                : throw new InvalidOperationException($"Settlement ledger effect {expected.IdempotencyKey} was not persisted."))
            .ToArray();
    }

    private static bool IsStateConsistent(
        IReadOnlyList<SettlementExecutionTicketLineRequest> ticketLines,
        IReadOnlyList<SettlementRecordDto> existingRecords,
        IReadOnlyList<SettlementLedgerEffectDto> existingEffects,
        out string reason)
    {
        var expectedTicketLines = ticketLines
            .Select(line => $"{line.TicketId}:{line.TicketLineId}")
            .ToHashSet(StringComparer.Ordinal);
        var duplicateRecord = existingRecords
            .GroupBy(record => $"{record.TicketId}:{record.TicketLineId}", StringComparer.Ordinal)
            .FirstOrDefault(group => group.Count() > 1);
        if (duplicateRecord is not null)
        {
            reason = $"Duplicate settlement records exist for ticket line {duplicateRecord.Key}.";
            return false;
        }

        var unexpectedRecord = existingRecords.FirstOrDefault(record =>
            !expectedTicketLines.Contains($"{record.TicketId}:{record.TicketLineId}"));
        if (unexpectedRecord is not null)
        {
            reason = $"Existing settlement record {unexpectedRecord.Id} is not represented in the resume request.";
            return false;
        }

        var existingRecordIds = existingRecords
            .Select(record => record.Id)
            .ToHashSet(StringComparer.Ordinal);
        var orphanEffect = existingEffects.FirstOrDefault(effect => !existingRecordIds.Contains(effect.SettlementRecordId));
        if (orphanEffect is not null)
        {
            reason = $"Existing settlement ledger effect {orphanEffect.Id} references missing settlement record {orphanEffect.SettlementRecordId}.";
            return false;
        }

        reason = string.Empty;
        return true;
    }

    private static IReadOnlyList<SettlementExternalReferenceDto> ExtractExternalReferences(
        IReadOnlyList<SettlementLedgerEffectDto> ledgerEffects)
    {
        var references = new List<SettlementExternalReferenceDto>();
        foreach (var effect in ledgerEffects)
        {
            if (!effect.Metadata.TryGetValue("externalReferences", out var value) || value is null)
            {
                continue;
            }

            if (value is JsonElement element && element.ValueKind == JsonValueKind.Array)
            {
                foreach (var referenceElement in element.EnumerateArray())
                {
                    var reference = TryReadExternalReference(effect, referenceElement);
                    if (reference is not null)
                    {
                        references.Add(reference);
                    }
                }
            }
        }

        return references
            .GroupBy(reference => $"{reference.SettlementRecordId}:{reference.ReferenceType}:{reference.IdempotencyKey}", StringComparer.Ordinal)
            .Select(group => group.First())
            .ToArray();
    }

    private static SettlementExternalReferenceDto? TryReadExternalReference(
        SettlementLedgerEffectDto effect,
        JsonElement element)
    {
        var referenceType = TryGetString(element, "referenceType");
        var referenceId = TryGetString(element, "referenceId");
        var idempotencyKey = TryGetString(element, "idempotencyKey");
        var status = TryGetString(element, "status");
        if (string.IsNullOrWhiteSpace(referenceType) ||
            string.IsNullOrWhiteSpace(referenceId) ||
            string.IsNullOrWhiteSpace(idempotencyKey) ||
            string.IsNullOrWhiteSpace(status))
        {
            return null;
        }

        return new SettlementExternalReferenceDto(
            effect.SettlementRecordId,
            effect.TicketId,
            effect.TicketLineId,
            referenceType,
            referenceId,
            idempotencyKey,
            status);
    }

    private static string? TryGetString(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static SettlementRecoveryDiagnosticsDto BuildRecoveryDiagnostics(
        SettlementRunDto run,
        int expectedRecordCount,
        IReadOnlyList<SettlementRecordDto> records,
        IReadOnlyList<SettlementLedgerEffectDto> effects,
        IReadOnlyList<SettlementExternalReferenceDto> externalReferences)
    {
        var missingRecordCount = Math.Max(expectedRecordCount - records.Count, 0);
        var missingEffectCount = Math.Max(records.Count - effects.Count, 0);
        var isFailed = run.Status == "failed";
        var isIncomplete = run.Status is "running" or "partially_completed" or "recovering";
        var isPartiallyIntegrated =
            run.Status != "completed" &&
            (records.Count > 0 || effects.Count > 0 || externalReferences.Count > 0) &&
            (missingRecordCount > 0 || missingEffectCount > 0 || externalReferences.Count > 0);

        return new SettlementRecoveryDiagnosticsDto(
            run.Id,
            run.Status,
            isIncomplete,
            isFailed,
            isPartiallyIntegrated,
            expectedRecordCount,
            records.Count,
            missingRecordCount,
            effects.Count,
            missingEffectCount,
            externalReferences.Count,
            ExtractLastFailureReason(run.Notes));
    }

    private static string? ExtractLastFailureReason(string? notes)
    {
        const string marker = "lastFailureReason=";
        if (string.IsNullOrWhiteSpace(notes))
        {
            return null;
        }

        var index = notes.LastIndexOf(marker, StringComparison.Ordinal);
        return index < 0 ? null : notes[(index + marker.Length)..].Trim();
    }

    private static async Task MarkResumeFailedAsync(
        DurableSettlementRepository repository,
        SettlementRunDto run,
        Exception error,
        CancellationToken cancellationToken)
    {
        await repository.SaveRunAsync(new CreateSettlementRunRequest(
            run.Id,
            run.DrawingId,
            run.GameId,
            "failed",
            run.ExpectedTicketCount,
            run.ExpectedLineCount,
            run.StartedAt,
            null,
            run.ExecutionId,
            run.ProcessedTicketCount,
            run.ProcessedLineCount,
            run.WinCount,
            run.LossCount,
            run.PushCount,
            Math.Max(run.FailedCount, 1),
            run.TotalStake,
            run.TotalPayout,
            run.TotalNet,
            run.DurationMs,
            run.TicketsPerSecond,
            run.LinesPerSecond,
            run.DrawToSettlementMs,
            run.PeakConcurrentSettlements,
            $"{run.Notes ?? string.Empty}; lastFailureReason={error.Message}",
            run.RecordHash,
            run.PreviousHash,
            run.HashVersion,
            run.CreatedAt,
            null,
            null),
            cancellationToken);
    }

    private static SettlementLedgerEffectDto ToLedgerEffectDto(
        SettlementRunDto run,
        SettlementRecordDto record,
        CreateSettlementLedgerEffectRequest effect)
    {
        return new SettlementLedgerEffectDto(
            effect.Id ?? BuildDeterministicId("settlement-ledger-effect", run.Id, record.Id),
            run.Id,
            record.Id,
            record.TicketId,
            record.TicketLineId,
            record.DrawingId,
            record.AccountId,
            effect.EffectType,
            effect.TransactionType,
            effect.Direction,
            effect.Amount,
            effect.IdempotencyKey,
            effect.PostingStatus,
            effect.ReferenceType,
            effect.ReferenceId,
            effect.ReversalOfLedgerEffectId,
            effect.Metadata ?? new Dictionary<string, object?>(),
            effect.CreatedAt ?? DateTimeOffset.UtcNow);
    }

    private static CreateSettlementRunRequest BuildCompletedRun(
        SettlementRunDto existingRun,
        ExecuteSettlementRunRequest request,
        IReadOnlyList<SettlementRecordDto> records,
        DateTimeOffset completedAt)
    {
        var winCount = records.Count(record => record.Outcome == "win");
        var lossCount = records.Count(record => record.Outcome == "loss");
        var pushCount = records.Count(record => record.Outcome == "push");
        var totalStake = records.Sum(record => record.Stake);
        var totalPayout = records.Sum(record => record.Payout);
        var totalNet = records.Sum(record => record.NetAmount);

        return new CreateSettlementRunRequest(
            existingRun.Id,
            existingRun.DrawingId,
            existingRun.GameId,
            "completed",
            existingRun.ExpectedTicketCount,
            existingRun.ExpectedLineCount,
            existingRun.StartedAt ?? completedAt,
            completedAt,
            string.IsNullOrWhiteSpace(request.ExecutionId)
                ? BuildDeterministicId("settlement-execution-dry-run", existingRun.Id)
                : request.ExecutionId.Trim(),
            records.Select(record => record.TicketId).Distinct(StringComparer.Ordinal).Count(),
            records.Count,
            winCount,
            lossCount,
            pushCount,
            0,
            totalStake,
            totalPayout,
            totalNet,
            existingRun.DurationMs > 0 ? existingRun.DurationMs : 1,
            records.Count,
            records.Count,
            existingRun.DrawToSettlementMs,
            Math.Max(existingRun.PeakConcurrentSettlements, 1),
            "settlement-service execution dry run; no authoritative ledger posting; no credit settlement applied",
            existingRun.RecordHash,
            existingRun.PreviousHash,
            "settlement-service-dry-run-v1",
            existingRun.CreatedAt,
            null,
            null);
    }

    private static CreateSettlementRunRequest BuildResettlementCompletedRun(
        SettlementRunDto existingRun,
        CreateResettlementRequest request,
        IReadOnlyList<SettlementRecordDto> records,
        DateTimeOffset completedAt)
    {
        var winCount = records.Count(record => record.Outcome == "win");
        var lossCount = records.Count(record => record.Outcome == "loss");
        var pushCount = records.Count(record => record.Outcome == "push");
        var totalStake = records.Sum(record => record.Stake);
        var totalPayout = records.Sum(record => record.Payout);
        var totalNet = records.Sum(record => record.NetAmount);

        return new CreateSettlementRunRequest(
            existingRun.Id,
            existingRun.DrawingId,
            existingRun.GameId,
            "completed",
            records.Select(record => record.TicketId).Distinct(StringComparer.Ordinal).Count(),
            records.Count,
            existingRun.StartedAt ?? completedAt,
            completedAt,
            existingRun.ExecutionId,
            records.Select(record => record.TicketId).Distinct(StringComparer.Ordinal).Count(),
            records.Count,
            winCount,
            lossCount,
            pushCount,
            0,
            totalStake,
            totalPayout,
            totalNet,
            existingRun.DurationMs > 0 ? existingRun.DurationMs : 1,
            records.Count,
            records.Count,
            existingRun.DrawToSettlementMs,
            Math.Max(existingRun.PeakConcurrentSettlements, 1),
            $"{existingRun.Notes}; resettlement dry run complete; originalRunId={request.OriginalRunId}",
            existingRun.RecordHash,
            existingRun.PreviousHash,
            existingRun.HashVersion,
            existingRun.CreatedAt,
            null,
            null);
    }

    private static string BuildDeterministicId(string prefix, params string[] parts)
    {
        var normalized = string.Join(
            "-",
            parts.Select(part => new string(
                part.Trim()
                    .ToLowerInvariant()
                    .Select(character => char.IsLetterOrDigit(character) ? character : '-')
                    .ToArray())));

        return $"{prefix}-{normalized}";
    }
}
