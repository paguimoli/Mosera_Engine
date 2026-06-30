using GameEngine.Api.Configuration;
using GameEngine.Application.Services;

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
                timestamp = DateTimeOffset.UtcNow,
                correlationId = context.GetCorrelationId()
            });
        });

        app.MapGet("/ready", (HttpContext context, ServiceConfiguration configuration) =>
        {
            return Results.Ok(new
            {
                status = "ready",
                service = configuration.ServiceName,
                schema = configuration.Schema.SchemaName,
                messaging = "not_wired",
                database = "schema_draft_only",
                timestamp = DateTimeOffset.UtcNow,
                correlationId = context.GetCorrelationId()
            });
        });

        var group = app.MapGroup("/api/game-engine");

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

        group.MapPost("/manual-results", (HttpContext context) =>
        {
            return Results.Accepted(value: new
            {
                success = true,
                action = "manual_result_submission_placeholder",
                officialCertifiedResultCreated = false,
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
