using GameEngine.Api.Configuration;
using GameEngine.Api.Infrastructure;
using GameEngine.Application.Interfaces;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;

namespace GameEngine.Api.Controllers;

public static class GameEngineEndpoints
{
    public static void MapGameEngineEndpoints(this WebApplication app)
    {
        app.MapGet("/health", (HttpContext context, ServiceConfiguration configuration) =>
        {
            return Results.Ok(new
            {
                status = "ok",
                service = configuration.ServiceName,
                environment = configuration.Environment,
                productionGameLogicEnabled = false,
                productionActivationConfigured = configuration.ProductionActivation.Enabled,
                productionActivationAuthority = "GameEngineProductionActivationAuthority",
                timestamp = DateTimeOffset.UtcNow,
                correlationId = context.GetCorrelationId()
            });
        });

        app.MapGet("/health/live", (HttpContext context, ServiceConfiguration configuration) =>
        {
            return Results.Ok(new
            {
                status = "ok",
                service = configuration.ServiceName,
                check = "live",
                timestamp = DateTimeOffset.UtcNow,
                correlationId = context.GetCorrelationId()
            });
        });

        app.MapGet("/ready", ReadinessResponse);
        app.MapGet("/health/ready", ReadinessResponse);

        var group = app.MapGroup("/api/game-engine");

        group.MapPost("/outcome-publications", PublishCanonicalOutcomeAsync);
        group.MapGet("/outcome-publications/current/{drawId:guid}", GetCurrentCanonicalOutcomeAsync);
        group.MapPost("/outcome-settlement-requests", EmitOutcomeSettlementRequestAsync);
        group.MapPost("/outcome-publications/recover", RecoverCanonicalOutcomeRequestsAsync);
        group.MapPost("/outcome-publications/{outcomeVersionId:guid}/replay", ReplayCanonicalOutcomeAsync);
        group.MapGet("/production-activation/readiness", GetProductionActivationReadinessAsync);
        group.MapPost("/production-activation/transitions", AdvanceProductionActivationAsync);
        group.MapGet("/outcome-publication-status", async (
            HttpContext context,
            ServiceConfiguration configuration,
            CanonicalOutcomeProviderAuthority providerAuthority,
            CanonicalOutcomeAuthority orchestrator) =>
        {
            var readiness = await orchestrator.CheckReadinessAsync(context.RequestAborted);
            var providerReadiness =
                await providerAuthority.CheckReadinessAsync(context.RequestAborted);
            return Results.Ok(new
            {
                success = true,
                readiness,
                providerReadiness,
                authorityBoundary = "outcome_only",
                settlementTransport = "shared_outbox",
                directSettlementCallsEnabled = false,
                canonicalPipelineEnabled = configuration.CanonicalOutcomePipelineEnabled,
                canonicalRecoveryEnabled = configuration.CanonicalOutcomeRecoveryEnabled,
                legacyPublicationEnabled = configuration.LegacyOutcomePublicationEnabled,
                productionActivationConfigured = configuration.ProductionActivation.Enabled,
                productionActivationAuthority = "GameEngineProductionActivationAuthority",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/status", (HttpContext context, GameEngineStatusService statusService) =>
        {
            return Results.Ok(new
            {
                success = true,
                data = statusService.GetStatus(),
                authBoundary = "admin_placeholder",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/modules", (HttpContext context, GameModuleRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                modules = registry.GetRegisteredModules().Select(ToModuleDiagnostic),
                inactiveModules = registry.GetInactiveModules(),
                productionReadyModules = registry.GetProductionReadyModules(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/modules/{id}", (string id, HttpContext context, GameModuleRegistry registry) =>
        {
            var module = registry.GetModule(id);
            return module is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Game module not found.",
                    moduleId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    module,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/modules/{id}/versions", (string id, HttpContext context, GameModuleRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                moduleId = id,
                versions = registry.GetModuleVersions(id),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/game-bindings", (HttpContext context, GameModuleRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                gameBindings = registry.GetGameBindings(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/game-bindings/{id:guid}", (Guid id, HttpContext context, GameModuleRegistry registry) =>
        {
            var binding = registry.GetGameBinding(id);
            return binding is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Game binding not found.",
                    gameBindingId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    gameBinding = binding,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/registry-status", (HttpContext context, GameModuleRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                registryStatus = registry.GetRegistryStatus(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-authorities", (HttpContext context, DrawAuthorityRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                drawAuthorities = registry.GetRegisteredAuthorities(),
                providers = registry.GetProviders(),
                approvalWorkflow = "required_before_production_use",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-authorities/{id:guid}", (Guid id, HttpContext context, DrawAuthorityRegistry registry) =>
        {
            var authority = registry.GetAuthority(id);
            return authority is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Draw Authority not found.",
                    drawAuthorityId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    drawAuthority = authority,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/draw-authorities/{id:guid}/versions", (Guid id, HttpContext context, DrawAuthorityRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                drawAuthorityId = id,
                versions = registry.GetAuthorityVersions(id),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-authorities/{id:guid}/health", (Guid id, HttpContext context, DrawAuthorityRegistry registry) =>
        {
            var authority = registry.GetAuthority(id);
            return authority is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Draw Authority not found.",
                    drawAuthorityId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    drawAuthorityId = id,
                    providerHealth = authority.ProviderHealth,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/draw-authority-registry-status", (HttpContext context, DrawAuthorityRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                registryStatus = registry.GetRegistryStatus(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-result-submissions", (HttpContext context, DrawAuthorityRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                drawResultSubmissions = registry.GetResultSubmissions(),
                immutable = true,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/official-certified-results", (HttpContext context, DrawAuthorityRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                officialCertifiedResults = registry.GetOfficialCertifiedResults(),
                settlementIntegrationEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/randomness", (HttpContext context, RandomnessRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                randomness = registry.GetStatus(),
                productionRngImplemented = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/randomness/providers", (HttpContext context, RandomnessRegistry registry) =>
        {
            return Results.Ok(new
            {
                success = true,
                providers = registry.GetProviders(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/certification", (HttpContext context, CertificationSuite suite) =>
        {
            return Results.Ok(new
            {
                success = true,
                certification = suite.GetStatus(),
                archiveGenerationEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/certification/packages", (HttpContext context, CertificationSuite suite) =>
        {
            return Results.Ok(new
            {
                success = true,
                certificationPackages = suite.GetPackages(),
                reproducible = true,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/validation", (HttpContext context, ValidationSuite suite) =>
        {
            return Results.Ok(new
            {
                success = true,
                validation = suite.DiscoverValidators(),
                longRunningExecutionEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/statistics", (HttpContext context, ValidationSuite suite) =>
        {
            return Results.Ok(new
            {
                success = true,
                statistics = suite.GetStatisticsStatus(),
                algorithmStatus = "FRAMEWORK_ONLY",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evidence", (HttpContext context, CertificationSuite suite) =>
        {
            return Results.Ok(new
            {
                success = true,
                evidence = suite.GetPackages().SelectMany(package => package.Evidence),
                checksumAlgorithm = "SHA256",
                mutationPerformed = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-schedules", (HttpContext context, DrawSchedulerService scheduler) =>
        {
            return Results.Ok(new
            {
                success = true,
                drawSchedules = scheduler.GetSchedules(),
                productionActivationEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-schedules/{id:guid}", (Guid id, HttpContext context, DrawSchedulerService scheduler) =>
        {
            var schedule = scheduler.GetSchedule(id);
            return schedule is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Draw schedule not found.",
                    drawScheduleId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    drawSchedule = schedule,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/draw-lifecycle", (HttpContext context, DrawSchedulerService scheduler) =>
        {
            return Results.Ok(new
            {
                success = true,
                drawLifecycle = scheduler.GetLifecycle(),
                settlementIntegrationEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/draw-lifecycle/{drawId:guid}", (Guid drawId, HttpContext context, DrawSchedulerService scheduler) =>
        {
            var lifecycle = scheduler.GetLifecycle(drawId);
            return lifecycle is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Draw lifecycle record not found.",
                    drawId,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    drawLifecycle = lifecycle,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/scheduler-status", (HttpContext context, DrawSchedulerService scheduler) =>
        {
            return Results.Ok(new
            {
                success = true,
                schedulerStatus = scheduler.GetSchedulerStatus(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-runs", (HttpContext context, EvaluationOrchestrator orchestrator) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationRuns = orchestrator.GetRuns(),
                checkpointProcessing = "framework_only",
                settlementIntegrationEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-runs/{id:guid}", (Guid id, HttpContext context, EvaluationOrchestrator orchestrator) =>
        {
            var run = orchestrator.GetRun(id);
            return run is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Evaluation run not found.",
                    evaluationRunId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    evaluationRun = run,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/evaluation-runs/{id:guid}/batches", (Guid id, HttpContext context, EvaluationOrchestrator orchestrator) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationRunId = id,
                evaluationBatches = orchestrator.GetBatches(id),
                workItems = orchestrator.GetWorkItems(id),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-batches/{id:guid}", (Guid id, HttpContext context, EvaluationOrchestrator orchestrator) =>
        {
            var batch = orchestrator.GetBatch(id);
            return batch is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Evaluation batch not found.",
                    evaluationBatchId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    evaluationBatch = batch,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/evaluation-progress/{runId:guid}", (Guid runId, HttpContext context, EvaluationOrchestrator orchestrator) =>
        {
            try
            {
                return Results.Ok(new
                {
                    success = true,
                    evaluationProgress = orchestrator.GetProgress(runId),
                    checkpoints = orchestrator.GetCheckpoints(runId),
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException ex)
            {
                return Results.NotFound(new
                {
                    success = false,
                    message = ex.Message,
                    evaluationRunId = runId,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        group.MapGet("/evaluation-orchestrator-status", (HttpContext context, EvaluationOrchestrator orchestrator) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationOrchestratorStatus = orchestrator.GetStatus(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-queues", (HttpContext context, EvaluationRabbitMqDiagnostics diagnostics) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationQueues = diagnostics.GetQueues(),
                productionRabbitMqPublishingEnabled = false,
                externalBrokerMutationPerformed = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-workers", (HttpContext context, EvaluationRabbitMqDiagnostics diagnostics) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationWorkers = diagnostics.GetWorkers(),
                productionWorkerActivationEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-worker-heartbeats", (HttpContext context, EvaluationRabbitMqDiagnostics diagnostics) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationWorkerHeartbeats = diagnostics.GetWorkerHeartbeats(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-dead-letter", (HttpContext context, EvaluationRabbitMqDiagnostics diagnostics) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationDeadLetter = diagnostics.GetDeadLetter(),
                destructiveQueueOperationPerformed = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-processing-status", (HttpContext context, EvaluationRabbitMqDiagnostics diagnostics) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationProcessingStatus = diagnostics.GetProcessingStatus(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/module-execution", (HttpContext context, GameModuleExecutionService executionService) =>
        {
            return Results.Ok(new
            {
                success = true,
                moduleExecution = executionService.GetDiagnostics(),
                settlementIntegrationEnabled = false,
                financialPostingEnabled = false,
                ticketDatabaseReadsEnabled = true,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/module-execution/{runId:guid}", (Guid runId, HttpContext context, GameModuleExecutionService executionService) =>
        {
            var execution = executionService.GetExecution(runId);
            return execution is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Module execution run was not found.",
                    runId,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    moduleExecution = execution,
                    settlementIntegrationEnabled = false,
                    financialPostingEnabled = false,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/module-resolution", (HttpContext context, GameModuleExecutionService executionService) =>
        {
            return Results.Ok(new
            {
                success = true,
                moduleResolution = executionService.GetModuleResolution(),
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/ticket-readers", (HttpContext context, GameModuleExecutionService executionService) =>
        {
            return Results.Ok(new
            {
                success = true,
                ticketReaders = executionService.GetTicketReaders(),
                databaseTicketReaderEnabled = true,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-records", (HttpContext context, EvaluationPersistenceService persistence) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationRecords = persistence.GetAll(),
                diagnostics = persistence.GetDiagnostics(),
                settlementIntegrationEnabled = false,
                financialPostingEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-records/{id:guid}", (Guid id, HttpContext context, EvaluationPersistenceService persistence) =>
        {
            var record = persistence.FindById(id);
            return record is null
                ? Results.NotFound(new
                {
                    success = false,
                    message = "Evaluation record not found.",
                    evaluationRecordId = id,
                    correlationId = context.GetCorrelationId()
                })
                : Results.Ok(new
                {
                    success = true,
                    evaluationRecord = record,
                    settlementIntegrationEnabled = false,
                    financialPostingEnabled = false,
                    correlationId = context.GetCorrelationId()
                });
        });

        group.MapGet("/evaluation-runs/{id:guid}/records", (Guid id, HttpContext context, EvaluationPersistenceService persistence) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationRunId = id,
                evaluationRecords = persistence.GetByRun(id),
                replaySafePersistenceEnabled = true,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-checkpoints", (HttpContext context, EvaluationPersistenceService persistence) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationCheckpoints = persistence.GetCheckpoints(),
                diagnostics = persistence.GetDiagnostics(),
                persistentCheckpointingEnabled = true,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/evaluation-storage-status", (HttpContext context, EvaluationPersistenceService persistence) =>
        {
            return Results.Ok(new
            {
                success = true,
                evaluationStorageStatus = persistence.GetStorageStatus(),
                settlementIntegrationEnabled = false,
                financialPostingEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/settlement-readiness", (HttpContext context, SettlementConsumerActivationGate activationGate) =>
        {
            return Results.Ok(new
            {
                success = true,
                settlementReadiness = activationGate.GetStatus(),
                status = "BLOCKED",
                settlementIntegrationEnabled = false,
                financialPostingEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/settlement-evaluation-records", (HttpContext context, ISettlementEvaluationReadModel readModel) =>
        {
            return Results.Ok(new
            {
                success = true,
                settlementEvaluationRecords = readModel.ListSettlementReadyRecords(),
                settlementEvaluationBatches = readModel.ListBatches(),
                settlementEvaluationRuns = readModel.ListRunSummaries(),
                settlementIntegrationEnabled = false,
                financialPostingEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapGet("/settlement-consumer-status", (HttpContext context, SettlementConsumerActivationGate activationGate, ISettlementEvaluationReadModel readModel) =>
        {
            var readService = readModel as SettlementEvaluationReadService;
            return Results.Ok(new
            {
                success = true,
                settlementConsumerStatus = activationGate.GetStatus(),
                cursor = readService?.GetCursor(),
                settlementIntegrationEnabled = false,
                financialPostingEnabled = false,
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapPost("/module-execution/run", (HttpContext context, GameModuleExecutionService executionService) =>
        {
            try
            {
                return Results.Accepted(value: new
                {
                    success = true,
                    moduleExecution = executionService.ExecuteReferenceRun(Guid.NewGuid()),
                    inMemoryOnly = false,
                    persistentStorageEnabled = true,
                    settlementIntegrationTriggered = false,
                    financialMutationPerformed = false,
                    authBoundary = "admin_placeholder",
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(new
                {
                    success = false,
                    message = ex.Message,
                    settlementIntegrationTriggered = false,
                    financialMutationPerformed = false,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        group.MapPost("/evaluation-runs/{id:guid}/resume", (Guid id, HttpContext context, GameModuleExecutionService executionService) =>
        {
            try
            {
                return Results.Accepted(value: new
                {
                    success = true,
                    moduleExecution = executionService.ResumeRun(id, Guid.NewGuid()),
                    replaySafePersistenceEnabled = true,
                    settlementIntegrationTriggered = false,
                    financialMutationPerformed = false,
                    authBoundary = "admin_placeholder",
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException ex)
            {
                return Results.NotFound(new
                {
                    success = false,
                    message = ex.Message,
                    evaluationRunId = id,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        group.MapPost("/settlement-consumer/activate", (HttpContext context, SettlementConsumerActivationGate activationGate) =>
        {
            return Results.BadRequest(new
            {
                success = false,
                message = "Settlement consumer activation is disabled in Phase 22.6L.",
                settlementConsumerStatus = activationGate.GetStatus(),
                settlementIntegrationEnabled = false,
                financialPostingEnabled = false,
                authBoundary = "admin_placeholder",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapPost("/evaluation-runs/plan", (HttpContext context, EvaluationOrchestrator orchestrator, GameModuleRegistry moduleRegistry, DrawSchedulerService scheduler) =>
        {
            var binding = moduleRegistry.GetGameBindings().First();
            var module = moduleRegistry.GetRegisteredModules().First();
            var draw = scheduler.GetLifecycle().First(lifecycle => lifecycle.Status is GameEngine.Domain.Model.DrawLifecycleStatus.AwaitingResult or GameEngine.Domain.Model.DrawLifecycleStatus.ManualReviewRequired);
            var run = orchestrator.PlanRun(new GameEngine.Domain.Model.EvaluationPlanRequest(
                draw.DrawId,
                binding.Id,
                Guid.NewGuid(),
                EligibleTicketCount: 250,
                GameSpecificBatchSize: 50,
                module.ModuleId,
                module.ModuleVersion,
                "evaluation-v0-placeholder"));

            return Results.Accepted(value: new
            {
                success = true,
                evaluationRun = run,
                evaluationBatches = orchestrator.GetBatches(run.Id),
                financialMutationPerformed = false,
                authBoundary = "admin_placeholder",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapPost("/evaluation-runs/{id:guid}/start", (Guid id, HttpContext context, EvaluationOrchestrator orchestrator) =>
        {
            try
            {
                return Results.Accepted(value: new
                {
                    success = true,
                    evaluationRun = orchestrator.StartRun(id),
                    productionRabbitMqWiringEnabled = false,
                    settlementIntegrationTriggered = false,
                    authBoundary = "admin_placeholder",
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException ex)
            {
                return Results.NotFound(new
                {
                    success = false,
                    message = ex.Message,
                    evaluationRunId = id,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        group.MapPost("/evaluation-runs/{id:guid}/publish-batches", (Guid id, HttpContext context, EvaluationRabbitMqDiagnostics diagnostics) =>
        {
            try
            {
                var result = diagnostics.PublishBatches(id, Guid.NewGuid());
                var processing = diagnostics.ProcessFirstRequested();
                return Results.Accepted(value: new
                {
                    success = true,
                    publishResult = result,
                    placeholderProcessingResult = processing,
                    productionRabbitMqPublishingEnabled = result.PublishingEnabled,
                    externalBrokerMutationPerformed = false,
                    financialMutationPerformed = false,
                    settlementIntegrationTriggered = false,
                    authBoundary = "admin_placeholder",
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException ex)
            {
                return Results.NotFound(new
                {
                    success = false,
                    message = ex.Message,
                    evaluationRunId = id,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        group.MapPost("/evaluation-runs/{id:guid}/retry", (Guid id, HttpContext context, EvaluationOrchestrator orchestrator) =>
        {
            try
            {
                return Results.Accepted(value: new
                {
                    success = true,
                    evaluationRun = orchestrator.RetryRun(id),
                    mutationPerformed = false,
                    authBoundary = "admin_placeholder",
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException ex)
            {
                return Results.NotFound(new
                {
                    success = false,
                    message = ex.Message,
                    evaluationRunId = id,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        group.MapPost("/evaluation-batches/{id:guid}/retry", (Guid id, HttpContext context, EvaluationOrchestrator orchestrator) =>
        {
            try
            {
                return Results.Accepted(value: new
                {
                    success = true,
                    evaluationBatch = orchestrator.RetryBatch(id),
                    mutationPerformed = false,
                    authBoundary = "admin_placeholder",
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException ex)
            {
                return Results.NotFound(new
                {
                    success = false,
                    message = ex.Message,
                    evaluationBatchId = id,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        group.MapPost("/evaluation-batches/{id:guid}/requeue", (Guid id, HttpContext context, EvaluationRabbitMqDiagnostics diagnostics) =>
        {
            try
            {
                return Results.Accepted(value: new
                {
                    success = true,
                    requeueResult = diagnostics.RequeueBatch(id),
                    destructiveQueueOperationPerformed = false,
                    financialMutationPerformed = false,
                    settlementIntegrationTriggered = false,
                    authBoundary = "admin_placeholder",
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException ex)
            {
                return Results.NotFound(new
                {
                    success = false,
                    message = ex.Message,
                    evaluationBatchId = id,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        group.MapPost("/evaluation-dead-letter/{id:guid}/review", (Guid id, HttpContext context, EvaluationRabbitMqDiagnostics diagnostics) =>
        {
            return Results.Accepted(value: new
            {
                success = true,
                deadLetterReview = diagnostics.ReviewDeadLetter(id),
                destructiveQueueOperationPerformed = false,
                financialMutationPerformed = false,
                settlementIntegrationTriggered = false,
                authBoundary = "admin_placeholder",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapPost("/draw-authorities/{id:guid}/approve", (Guid id, HttpContext context) =>
        {
            return Results.Accepted(value: new
            {
                success = true,
                drawAuthorityId = id,
                action = "approval_placeholder",
                productionUseEnabled = false,
                authBoundary = "admin_placeholder",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapPost("/certification/build", (HttpContext context, CertificationSuite suite) =>
        {
            return Results.Accepted(value: new
            {
                success = true,
                action = "certification_package_build_placeholder",
                certificationPackage = suite.BuildPackage("ad-hoc-placeholder-profile"),
                archiveGenerated = false,
                authBoundary = "admin_placeholder",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapPost("/validation/run", (HttpContext context, ValidationSuite suite) =>
        {
            return Results.Accepted(value: new
            {
                success = true,
                action = "validation_run_placeholder",
                validationResults = suite.RunPlaceholderValidation(GameEngine.Domain.Model.ValidationSuiteCommand.ValidatePrng),
                longRunningExecutionStarted = false,
                authBoundary = "admin_placeholder",
                correlationId = context.GetCorrelationId()
            });
        });

        group.MapPost("/draw-schedules/{id:guid}/preview", (Guid id, HttpContext context, DrawSchedulerService scheduler) =>
        {
            try
            {
                return Results.Accepted(value: new
                {
                    success = true,
                    preview = scheduler.PreviewSchedule(id),
                    mutationPerformed = false,
                    authBoundary = "admin_placeholder",
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException ex)
            {
                return Results.NotFound(new
                {
                    success = false,
                    message = ex.Message,
                    drawScheduleId = id,
                    correlationId = context.GetCorrelationId()
                });
            }
        });

        group.MapPost("/draw-lifecycle/{drawId:guid}/mark-missed", (Guid drawId, HttpContext context, DrawSchedulerService scheduler) =>
        {
            try
            {
                return Results.Accepted(value: new
                {
                    success = true,
                    drawLifecycle = scheduler.MarkMissed(drawId),
                    productionMutationPerformed = false,
                    settlementIntegrationTriggered = false,
                    authBoundary = "admin_placeholder",
                    correlationId = context.GetCorrelationId()
                });
            }
            catch (InvalidOperationException ex)
            {
                return Results.NotFound(new
                {
                    success = false,
                    message = ex.Message,
                    drawId,
                    correlationId = context.GetCorrelationId()
                });
            }
        });
    }

    private static async Task<IResult> ReadinessResponse(
        HttpContext context,
        ServiceConfiguration configuration,
        InfrastructureReadinessChecks readinessChecks)
    {
        var rabbitMqReady = await readinessChecks.CheckRabbitMqAsync(context.RequestAborted);
        var redisReady = await readinessChecks.CheckRedisAsync(context.RequestAborted);
        var databaseReady = await readinessChecks.CheckDatabaseAsync(context.RequestAborted);
        var outcomeRuntimePersistenceReady = await readinessChecks.CheckOutcomeRuntimePersistenceAsync(context.RequestAborted);
        var outcomeRuntimeLockingReady = await readinessChecks.CheckOutcomeRuntimeLockingAsync(context.RequestAborted);
        var outcomeRuntimeRecoveryReady = await readinessChecks.CheckOutcomeRuntimeRecoveryAsync(context.RequestAborted);
        var mathEvaluationPersistenceReady = await readinessChecks.CheckMathEvaluationPersistenceAsync(context.RequestAborted);
        var mathEvaluationBatchPersistenceReady = await readinessChecks.CheckMathEvaluationBatchPersistenceAsync(context.RequestAborted);
        var settlementInputHandoffReady = await readinessChecks.CheckSettlementInputHandoffAsync(context.RequestAborted);
        var canonicalOutcomeProviderAuthorityReady =
            await readinessChecks.CheckCanonicalOutcomeProviderAuthorityAsync(context.RequestAborted);
        var internalCsprngProviderReady =
            await readinessChecks.CheckInternalCsprngProviderAsync(context.RequestAborted);
        var canonicalOutcomePipelineReady = await readinessChecks.CheckCanonicalOutcomePipelineAsync(context.RequestAborted);
        var provablyFairRuntimeReady = await readinessChecks.CheckProvablyFairRuntimeAsync(context.RequestAborted);
        var officialResultsProviderReady = await readinessChecks.CheckOfficialResultsProviderAsync(context.RequestAborted);
        var manualCertifiedProviderReady = await readinessChecks.CheckManualCertifiedProviderAsync(context.RequestAborted);
        var physicalDrawRuntimeReady = await readinessChecks.CheckPhysicalDrawRuntimeAsync(context.RequestAborted);
        var dependencies = new[]
        {
            rabbitMqReady,
            redisReady,
            databaseReady,
            outcomeRuntimePersistenceReady,
            outcomeRuntimeLockingReady,
            outcomeRuntimeRecoveryReady,
            mathEvaluationPersistenceReady,
            mathEvaluationBatchPersistenceReady,
            settlementInputHandoffReady,
            canonicalOutcomeProviderAuthorityReady,
            internalCsprngProviderReady,
            canonicalOutcomePipelineReady,
            provablyFairRuntimeReady,
            officialResultsProviderReady,
            manualCertifiedProviderReady,
            physicalDrawRuntimeReady
        };
        var ready = dependencies.All(dependency => dependency.Ready);

        var response = new
        {
            status = ready ? "ready" : "not_ready",
            service = configuration.ServiceName,
            schema = configuration.Schema.SchemaName,
            dependencies = dependencies.ToDictionary(
                dependency => dependency.Name,
                dependency => dependency.Ready ? "ready" : "not_ready"),
            dependencyDetails = dependencies
                .Where(dependency => !dependency.Ready)
                .Select(dependency => new
                {
                    dependency.Name,
                    dependency.Message
                }),
            timestamp = DateTimeOffset.UtcNow,
            correlationId = context.GetCorrelationId()
        };

        return ready ? Results.Ok(response) : Results.Json(response, statusCode: 503);
    }

    private static async Task<IResult> PublishCanonicalOutcomeAsync(
        CanonicalOutcomePublicationCommand command,
        HttpContext context,
        ServiceConfiguration configuration,
        CanonicalOutcomeAuthority outcomeAuthority,
        CanonicalOutcomeLifecycleAuthority lifecycleAuthority)
    {
        if (!configuration.CanonicalOutcomePipelineEnabled)
        {
            return Results.Json(new
            {
                success = false,
                message = "Canonical Outcome publication is disabled by configuration.",
                correlationId = context.GetCorrelationId()
            }, statusCode: 503);
        }

        try
        {
            var result = command.VersionKind switch
            {
                CanonicalOutcomeVersionKind.Published =>
                    await outcomeAuthority.PublishAsync(command, context.RequestAborted),
                CanonicalOutcomeVersionKind.Corrected =>
                    await lifecycleAuthority.CorrectAsync(command, context.RequestAborted),
                CanonicalOutcomeVersionKind.Cancelled =>
                    await lifecycleAuthority.CancelAsync(command, context.RequestAborted),
                _ => throw new ArgumentOutOfRangeException(nameof(command.VersionKind))
            };
            return Results.Ok(new
            {
                success = true,
                data = result,
                productionActivationGoverned = true,
                correlationId = context.GetCorrelationId()
            });
        }
        catch (ArgumentException error)
        {
            return Results.BadRequest(new
            {
                success = false,
                message = error.Message,
                correlationId = context.GetCorrelationId()
            });
        }
        catch (InvalidOperationException error)
        {
            return Results.Conflict(new
            {
                success = false,
                message = error.Message,
                correlationId = context.GetCorrelationId()
            });
        }
    }

    private static async Task<IResult> GetCurrentCanonicalOutcomeAsync(
        Guid drawId,
        HttpContext context,
        CanonicalOutcomeAuthority orchestrator)
    {
        var result = await orchestrator.FindCurrentAsync(drawId, context.RequestAborted);
        return result is null
            ? Results.NotFound(new
            {
                success = false,
                message = "Canonical outcome was not found.",
                drawId,
                correlationId = context.GetCorrelationId()
            })
            : Results.Ok(new
            {
                success = true,
                data = result,
                correlationId = context.GetCorrelationId()
            });
    }

    private static async Task<IResult> EmitOutcomeSettlementRequestAsync(
        OutcomeSettlementRequestCommand command,
        HttpContext context,
        ServiceConfiguration configuration,
        CanonicalOutcomeLifecycleAuthority lifecycleAuthority)
    {
        if (!configuration.CanonicalOutcomePipelineEnabled)
        {
            return Results.Json(new
            {
                success = false,
                message = "Canonical Outcome settlement-request emission is disabled by configuration.",
                correlationId = context.GetCorrelationId()
            }, statusCode: 503);
        }

        try
        {
            var result = await lifecycleAuthority.EmitSettlementImpactAsync(command, context.RequestAborted);
            return Results.Ok(new
            {
                success = true,
                data = result,
                transport = "shared_outbox",
                settlementAuthorityInvokedDirectly = false,
                correlationId = context.GetCorrelationId()
            });
        }
        catch (ArgumentException error)
        {
            return Results.BadRequest(new
            {
                success = false,
                message = error.Message,
                correlationId = context.GetCorrelationId()
            });
        }
        catch (InvalidOperationException error)
        {
            return Results.Conflict(new
            {
                success = false,
                message = error.Message,
                correlationId = context.GetCorrelationId()
            });
        }
    }

    private static async Task<IResult> RecoverCanonicalOutcomeRequestsAsync(
        HttpContext context,
        ServiceConfiguration configuration,
        CanonicalOutcomeLifecycleAuthority lifecycleAuthority,
        IOperationalSecurityAuthority operationalSecurityAuthority)
    {
        if (!configuration.CanonicalOutcomePipelineEnabled ||
            !configuration.CanonicalOutcomeRecoveryEnabled)
        {
            return Results.Json(new
            {
                success = false,
                message = "Canonical Outcome recovery is disabled by configuration.",
                correlationId = context.GetCorrelationId()
            }, statusCode: 503);
        }

        await operationalSecurityAuthority.ValidateAsync(
            context.Request.Headers["x-operational-command-id"].FirstOrDefault(),
            context.Request.Headers["x-privileged-session-id"].FirstOrDefault(),
            context.Request.Headers["x-operational-executor-id"].FirstOrDefault(),
            "OUTCOME_RECOVERY_EXECUTION",
            context.RequestAborted);

        var result = await lifecycleAuthority.RecoverAsync(
            new CanonicalOutcomeRecoveryCommand(
                25,
                "system:game-engine-api",
                "REQUESTED_INCOMPLETE_OPERATION_RECOVERY",
                context.GetCorrelationId(),
                "api:outcome-publications:recover"),
            context.RequestAborted);
        return Results.Ok(new
        {
            success = true,
            data = result,
            directSettlementCallsEnabled = false,
            productionActivationGoverned = true,
            correlationId = context.GetCorrelationId()
        });
    }

    private static async Task<IResult> ReplayCanonicalOutcomeAsync(
        Guid outcomeVersionId,
        CanonicalOutcomeReplayCommand command,
        HttpContext context,
        ServiceConfiguration configuration,
        CanonicalOutcomeLifecycleAuthority lifecycleAuthority)
    {
        if (!configuration.CanonicalOutcomePipelineEnabled)
        {
            return Results.Json(new
            {
                success = false,
                message = "Canonical Outcome replay is disabled by configuration.",
                correlationId = context.GetCorrelationId()
            }, statusCode: 503);
        }

        if (command.OutcomeVersionId != outcomeVersionId)
        {
            return Results.BadRequest(new
            {
                success = false,
                message = "Replay route and payload outcome version ids must match.",
                correlationId = context.GetCorrelationId()
            });
        }

        try
        {
            var result = await lifecycleAuthority.ReplayAsync(command, context.RequestAborted);
            return Results.Ok(new
            {
                success = true,
                data = result,
                authoritativeStateChanged = false,
                publicationTriggered = false,
                settlementTriggered = false,
                correlationId = context.GetCorrelationId()
            });
        }
        catch (ArgumentException error)
        {
            return Results.BadRequest(new
            {
                success = false,
                message = error.Message,
                correlationId = context.GetCorrelationId()
            });
        }
        catch (InvalidOperationException error)
        {
            return Results.Conflict(new
            {
                success = false,
                message = error.Message,
                correlationId = context.GetCorrelationId()
            });
        }
    }

    private static async Task<IResult> GetProductionActivationReadinessAsync(
        string providerId,
        string providerVersion,
        string configurationVersion,
        HttpContext context,
        GameEngineProductionActivationAuthority activationAuthority)
    {
        var readiness = await activationAuthority.CheckReadinessAsync(
            providerId,
            providerVersion,
            configurationVersion,
            context.RequestAborted);
        return Results.Ok(new
        {
            success = true,
            readiness,
            authority = "GameEngineProductionActivationAuthority",
            automaticActivationEnabled = false,
            correlationId = context.GetCorrelationId()
        });
    }

    private static async Task<IResult> AdvanceProductionActivationAsync(
        GameEngineProductionActivationCommand command,
        HttpContext context,
        GameEngineProductionActivationAuthority activationAuthority,
        IOperationalSecurityAuthority operationalSecurityAuthority)
    {
        try
        {
            await operationalSecurityAuthority.ValidateAsync(
                context.Request.Headers["x-operational-command-id"].FirstOrDefault(),
                context.Request.Headers["x-privileged-session-id"].FirstOrDefault(),
                context.Request.Headers["x-operational-executor-id"].FirstOrDefault(),
                "GAME_ENGINE_PRODUCTION_ACTIVATION",
                context.RequestAborted);
            var activationEvent = await activationAuthority.AdvanceAsync(
                command,
                context.RequestAborted);
            return Results.Ok(new
            {
                success = true,
                data = activationEvent,
                activationWasExplicit = true,
                authority = "GameEngineProductionActivationAuthority",
                correlationId = context.GetCorrelationId()
            });
        }
        catch (ArgumentException error)
        {
            return Results.BadRequest(new
            {
                success = false,
                message = error.Message,
                correlationId = context.GetCorrelationId()
            });
        }
        catch (InvalidOperationException error)
        {
            return Results.Conflict(new
            {
                success = false,
                message = error.Message,
                correlationId = context.GetCorrelationId()
            });
        }
    }

    private static object ToModuleDiagnostic(GameEngine.Domain.Model.GameModuleRegistryEntry entry)
    {
        return new
        {
            manifest = new
            {
                moduleId = entry.ModuleId,
                moduleName = entry.ModuleName,
                moduleVersion = entry.ModuleVersion,
                gameTypes = entry.SupportedGameTypes,
                supportedWagerTypes = entry.SupportedWagerTypes,
                supportedDrawAuthorityTypes = entry.SupportedDrawAuthorities,
                supportsInternalDrawGeneration = entry.DrawGenerationCapability,
                configurationSchemaVersion = entry.ConfigurationSchemaVersion,
                lifecycleStatus = entry.LifecycleStatus
            },
            healthStatus = entry.HealthStatus,
            approvalStatus = entry.ApprovalStatus,
            productionReady = entry.ProductionReady,
            loadedAssembly = entry.LoadedAssembly,
            loadTimestamp = entry.LoadTimestamp,
            registrationStatus = entry.RegistrationStatus,
            validation = entry.Validation,
            lifecycleGateBlockers = entry.LifecycleGateBlockers,
            lifecycleGateWarnings = entry.LifecycleGateWarnings
        };
    }
}
