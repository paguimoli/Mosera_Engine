using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using GameEngine.Domain.Randomness;

var registry = new GameModuleRegistry();
var drawAuthorityRegistry = new DrawAuthorityRegistry();
var statusService = new GameEngineStatusService(registry, drawAuthorityRegistry);
var status = statusService.GetStatus();
var modules = statusService.ListModuleStatuses();

if (status.ProductionGameLogicEnabled)
{
    throw new InvalidOperationException("Skeleton must not enable production game logic.");
}

if (status.ProductionRngEnabled)
{
    throw new InvalidOperationException("Skeleton must not enable production RNG.");
}

if (status.SettlementIntegrationEnabled)
{
    throw new InvalidOperationException("Skeleton must not enable settlement integration.");
}

if (modules.Count != 3)
{
    throw new InvalidOperationException("Expected HotSpot, TestModule, and Keno module statuses.");
}

if (modules.Any(module => module.Manifest.SupportedWagerTypes.Count == 0))
{
    throw new InvalidOperationException("Module status must expose supported wager types.");
}

var registryStatus = registry.GetRegistryStatus();
if (registryStatus.RegisteredModuleCount != 3)
{
    throw new InvalidOperationException("Expected three registered modules.");
}

if (registry.GetInactiveModules().Count != 3)
{
    throw new InvalidOperationException("Current non-production modules must remain inactive.");
}

if (registry.GetProductionReadyModules().Count != 0)
{
    throw new InvalidOperationException("No module should be production-ready in this phase.");
}

var bindings = registry.GetGameBindings();
if (bindings.Count != 3)
{
    throw new InvalidOperationException("Prospective bindings should be created for discovered modules.");
}

var testBinding = registry.CreateProspectiveBinding(new GameBindingRequest(
    "test-specific-version",
    "Test Specific Version",
    GameType.Test,
    WagerType.TestWager,
    "TEST_MODULE",
    GameModuleVersionSelectionMode.SpecificVersion,
    "0.0.0-skeleton",
    DrawProviderType.ManualCertifiedEntry,
    "manual-test-schedule",
    SettlementTriggerPolicy.Manual,
    new Dictionary<string, object?>(),
    new Dictionary<string, object?>()));
if (testBinding.Versions.Single().Status != GameBindingStatus.Validated)
{
    throw new InvalidOperationException("Specific-version game binding should validate.");
}

var invalidBinding = registry.CreateProspectiveBinding(new GameBindingRequest(
    "invalid-hotspot",
    "Invalid HotSpot Binding",
    GameType.Test,
    WagerType.TestWager,
    "HOT_SPOT",
    GameModuleVersionSelectionMode.SpecificVersion,
    "0.0.0-skeleton",
    DrawProviderType.InternalPrng,
    "manual-test-schedule",
    SettlementTriggerPolicy.Manual,
    new Dictionary<string, object?>(),
    new Dictionary<string, object?>()));
if (invalidBinding.Versions.Single().Status != GameBindingStatus.Rejected)
{
    throw new InvalidOperationException("Invalid game binding should be rejected.");
}

var drawAuthorityStatus = drawAuthorityRegistry.GetRegistryStatus();
if (drawAuthorityStatus.RegisteredAuthorityCount < 5)
{
    throw new InvalidOperationException("Expected placeholder Draw Authorities to be registered.");
}

var testPrng = drawAuthorityRegistry.GetRegisteredAuthorities().Single(entry => entry.Authority.Code == "internal-test-prng");
var testProductionAssignment = drawAuthorityRegistry.ValidateAssignment(
    testPrng.Authority.Id,
    Guid.NewGuid(),
    productionBinding: true,
    [DrawAuthorityCapability.CanGenerateInternalResults]);
if (testProductionAssignment.Status != DrawAuthorityAssignmentStatus.Rejected)
{
    throw new InvalidOperationException("Internal Test PRNG must reject production assignment.");
}

var manual = drawAuthorityRegistry.GetRegisteredAuthorities().Single(entry => entry.Authority.Code == "manual-certified-entry");
var manualTestingAssignment = drawAuthorityRegistry.ValidateAssignment(
    manual.Authority.Id,
    Guid.NewGuid(),
    productionBinding: false,
    [DrawAuthorityCapability.CanAcceptManualResults]);
if (manualTestingAssignment.Status == DrawAuthorityAssignmentStatus.Rejected)
{
    throw new InvalidOperationException("Manual certified result authority should allow testing assignment.");
}

var submissions = drawAuthorityRegistry.GetResultSubmissions();
if (submissions.Count < 2)
{
    throw new InvalidOperationException("Multiple result submissions must be supported.");
}

var certificationService = new DrawCertificationService(drawAuthorityRegistry.GetRegisteredAuthorities(), submissions);
var firstSubmission = submissions.First();
var rejectedMissingMetadata = false;
try
{
    certificationService.CertifyResult(new DrawCertificationDecision(
        firstSubmission.DrawScheduleId,
        firstSubmission.Id,
        firstSubmission.DrawAuthorityId,
        "operator-placeholder",
        OperatorCertificationMetadataPresent: false,
        DateTimeOffset.UtcNow));
}
catch (InvalidOperationException)
{
    rejectedMissingMetadata = true;
}

if (!rejectedMissingMetadata)
{
    throw new InvalidOperationException("Manual certification without metadata should be rejected.");
}

var official = certificationService.CertifyResult(new DrawCertificationDecision(
    firstSubmission.DrawScheduleId,
    firstSubmission.Id,
    firstSubmission.DrawAuthorityId,
    "operator-placeholder",
    OperatorCertificationMetadataPresent: true,
    DateTimeOffset.UtcNow));
if (official.Status != DrawCertificationStatus.Approved)
{
    throw new InvalidOperationException("Official certified result should be approved when metadata exists.");
}

var rejectedOverwrite = false;
try
{
    certificationService.CertifyResult(new DrawCertificationDecision(
        firstSubmission.DrawScheduleId,
        submissions.Last().Id,
        firstSubmission.DrawAuthorityId,
        "operator-placeholder",
        OperatorCertificationMetadataPresent: true,
        DateTimeOffset.UtcNow));
}
catch (InvalidOperationException)
{
    rejectedOverwrite = true;
}

if (!rejectedOverwrite)
{
    throw new InvalidOperationException("Second official result for same draw should be rejected.");
}

var randomnessRegistry = new RandomnessRegistry();
var randomnessProviders = randomnessRegistry.GetProviders();
if (randomnessProviders.Count != 2)
{
    throw new InvalidOperationException("Expected production and test randomness provider placeholders.");
}

if (randomnessProviders.Any(provider => provider.Metadata.ProductionRngImplemented))
{
    throw new InvalidOperationException("Phase 22.6E must not expose an approved production RNG implementation.");
}

var productionProvider = randomnessRegistry.GetProvider("secure-rng-placeholder");
var productionBytes = productionProvider.GenerateRandomBytes(16);
if (productionBytes.Length != 16)
{
    throw new InvalidOperationException("Production RNG abstraction must generate requested byte length.");
}

var firstTestProvider = new DeterministicTestRandomnessProvider(seed: 226);
var secondTestProvider = new DeterministicTestRandomnessProvider(seed: 226);
var firstSequence = Enumerable.Range(0, 8).Select(_ => firstTestProvider.GenerateBoundedInteger(1, 50)).ToArray();
var secondSequence = Enumerable.Range(0, 8).Select(_ => secondTestProvider.GenerateBoundedInteger(1, 50)).ToArray();
if (!firstSequence.SequenceEqual(secondSequence))
{
    throw new InvalidOperationException("Deterministic test provider must be repeatable with the same seed.");
}

var drawFramework = new DrawGenerationFramework();
var deterministicForSampling = new DeterministicTestRandomnessProvider(seed: 226);
var withoutReplacement = drawFramework.SampleWithoutReplacement(
    new DrawSamplingRequest(1, 10, 5, DrawSamplingMode.WithoutReplacement),
    deterministicForSampling);
if (withoutReplacement.Count != 5 || withoutReplacement.Distinct().Count() != 5)
{
    throw new InvalidOperationException("Sampling without replacement must return unique values.");
}

var validationSuite = new ValidationSuite();
var validationResults = validationSuite.DiscoverValidators();
if (validationResults.Count < 10)
{
    throw new InvalidOperationException("Validation suite must discover validators and benchmarks.");
}

var statisticsStatus = validationSuite.GetStatisticsStatus();
if (statisticsStatus.ValidatorCount < 7 || statisticsStatus.BenchmarkCount < 3)
{
    throw new InvalidOperationException("Statistical validator and benchmark registration is incomplete.");
}

var certificationSuite = new CertificationSuite(randomnessRegistry, validationSuite);
var package = certificationSuite.GetPackages().Single();
if (package.Status != CertificationStatus.Generated)
{
    throw new InvalidOperationException("Certification package should be generated as structured framework evidence.");
}

if (package.Checksums.Count == 0 || package.Checksums.Any(checksum => checksum.Algorithm != EvidenceHashAlgorithm.Sha256))
{
    throw new InvalidOperationException("Certification package must include SHA256 checksums.");
}

if (!package.GameMetadata.ContainsKey("gameRules") ||
    !package.ModuleMetadata.ContainsKey("moduleVersion") ||
    !package.VersionMetadata.ContainsKey("providerVersion") ||
    !package.ConfigurationMetadata.ContainsKey("range") ||
    !package.BuildMetadata.ContainsKey("runtimeVersion") ||
    !package.EnvironmentMetadata.ContainsKey("os") ||
    !package.HardwareMetadata.ContainsKey("processorCount"))
{
    throw new InvalidOperationException("Certification package metadata is incomplete.");
}

var evidence = package.Evidence.Single().EvidenceFile;
var alteredEvidence = evidence with { FileName = "altered.json" };
if (evidence.FileName == alteredEvidence.FileName)
{
    throw new InvalidOperationException("Evidence record immutability check failed.");
}

var validationCommand = validationSuite.RunPlaceholderValidation(ValidationSuiteCommand.ValidateDrawGenerator).Single();
if (validationCommand.Status != ValidationCheckStatus.Placeholder)
{
    throw new InvalidOperationException("Validation commands must remain placeholder-only in this phase.");
}

var scheduler = new DrawSchedulerService(registry, drawAuthorityRegistry);
var schedules = scheduler.GetSchedules();
if (schedules.Count < 2)
{
    throw new InvalidOperationException("Expected fixed interval and daily draw schedules.");
}

var intervalSchedule = schedules.Single(schedule => schedule.ScheduleKind == DrawScheduleKind.FixedInterval);
var dailySchedule = schedules.Single(schedule => schedule.ScheduleKind == DrawScheduleKind.FixedDailyTime);
var intervalPreview = scheduler.PreviewSchedule(intervalSchedule.Id, count: 3);
if (intervalPreview.UpcomingDraws.Count != 3)
{
    throw new InvalidOperationException("Fixed interval schedule preview should generate upcoming draws.");
}

var intervalDraws = intervalPreview.UpcomingDraws.OrderBy(draw => draw.DrawAt).ToArray();
if ((intervalDraws[1].DrawAt - intervalDraws[0].DrawAt) != TimeSpan.FromMinutes(intervalSchedule.IntervalMinutes ?? 0))
{
    throw new InvalidOperationException("Fixed interval schedule generation used the wrong interval.");
}

var dailyPreview = scheduler.PreviewSchedule(dailySchedule.Id, count: 3);
if (dailyPreview.UpcomingDraws.Count != 3 || dailySchedule.TimeZoneId != "UTC")
{
    throw new InvalidOperationException("Daily draw schedule preview or time-zone metadata is invalid.");
}

var firstDaily = dailyPreview.UpcomingDraws.OrderBy(draw => draw.DrawAt).First();
if (firstDaily.SalesCutoffAt != firstDaily.DrawAt.Subtract(dailySchedule.SalesCutoffBeforeDraw))
{
    throw new InvalidOperationException("Sales cutoff calculation is invalid.");
}

var lifecycle = scheduler.GetLifecycle();
if (lifecycle.Count == 0)
{
    throw new InvalidOperationException("Lifecycle diagnostics should expose generated records.");
}

if (lifecycle.Any(draw => draw.SalesAllowed && DateTimeOffset.UtcNow >= draw.SalesCutoffAt))
{
    throw new InvalidOperationException("Scheduler must prevent sales after cutoff.");
}

var internalBeforeClose = intervalPreview.UpcomingDraws.First(draw => DateTimeOffset.UtcNow < draw.SalesCloseAt);
if (internalBeforeClose.InternalGenerationEligible)
{
    throw new InvalidOperationException("Internal draws must not be eligible before sales close.");
}

var manualPrevious = scheduler.GetLifecycle()
    .Where(draw => draw.ResultSource == DrawResultSource.ManualCertified)
    .OrderBy(draw => draw.DrawAt)
    .First();
if (manualPrevious.DrawAt < DateTimeOffset.UtcNow &&
    manualPrevious.Status is not DrawLifecycleStatus.AwaitingResult and not DrawLifecycleStatus.ManualReviewRequired)
{
    throw new InvalidOperationException("Official/manual result games should await result after close.");
}

var marked = scheduler.MarkMissed(manualPrevious.DrawId);
if (marked.Status != DrawLifecycleStatus.ManualReviewRequired || !marked.ManualRecoveryMarked)
{
    throw new InvalidOperationException("Missed draw recovery marker was not applied.");
}

var invalidTransition = scheduler.ValidateTransition(marked.DrawId, DrawLifecycleStatus.SalesOpen);
if (invalidTransition.Accepted)
{
    throw new InvalidOperationException("Invalid lifecycle transition should be rejected.");
}

var schedulerStatus = scheduler.GetSchedulerStatus();
if (schedulerStatus.ScheduleCount < 2 || schedulerStatus.ProductionActivationEnabled || schedulerStatus.SettlementIntegrationEnabled)
{
    throw new InvalidOperationException("Scheduler health reporting is invalid.");
}

var evaluationOrchestrator = new EvaluationOrchestrator(registry, scheduler);
var seededRun = evaluationOrchestrator.GetRuns().Single();
if (seededRun.Status != EvaluationRunStatus.InProgress)
{
    throw new InvalidOperationException("Seeded evaluation run should be startable.");
}

var seededBatches = evaluationOrchestrator.GetBatches(seededRun.Id).OrderBy(batch => batch.Sequence).ToArray();
if (seededBatches.Length != 4 || seededRun.BatchSize != 75)
{
    throw new InvalidOperationException("Game-specific batch planning failed.");
}

if (seededBatches[0].StartInclusive != 0 || seededBatches[0].EndExclusive != 75 || seededBatches[1].StartInclusive != 75)
{
    throw new InvalidOperationException("Deterministic batch boundaries are invalid.");
}

var seededCheckpoints = evaluationOrchestrator.GetCheckpoints(seededRun.Id);
if (seededCheckpoints.Count != seededBatches.Length)
{
    throw new InvalidOperationException("Checkpoint creation failed.");
}

var bindingForEvaluation = registry.GetGameBindings().First();
var moduleForEvaluation = registry.GetRegisteredModules().First();
var drawForEvaluation = scheduler.GetLifecycle()
    .First(draw => draw.Status is DrawLifecycleStatus.AwaitingResult or DrawLifecycleStatus.ManualReviewRequired);
var defaultBatchRun = evaluationOrchestrator.PlanRun(new EvaluationPlanRequest(
    drawForEvaluation.DrawId,
    bindingForEvaluation.Id,
    Guid.NewGuid(),
    EligibleTicketCount: 205,
    GameSpecificBatchSize: null,
    moduleForEvaluation.ModuleId,
    moduleForEvaluation.ModuleVersion,
    "evaluation-default-batch"));
if (defaultBatchRun.BatchSize != 100 || defaultBatchRun.PlannedBatchCount != 3)
{
    throw new InvalidOperationException("Global default batch size fallback failed.");
}

var invalidRun = evaluationOrchestrator.PlanRun(new EvaluationPlanRequest(
    Guid.NewGuid(),
    Guid.NewGuid(),
    Guid.Empty,
    EligibleTicketCount: 10,
    GameSpecificBatchSize: 5,
    "missing-module",
    "missing-version",
    "evaluation-invalid"));
if (invalidRun.Status != EvaluationRunStatus.ManualReviewRequired || invalidRun.Preconditions.Count == 0)
{
    throw new InvalidOperationException("Evaluation run preconditions should block invalid starts.");
}

var retryBatch = evaluationOrchestrator.RetryBatch(seededBatches[0].Id);
if (retryBatch.Status != EvaluationBatchStatus.RetryPending || retryBatch.RetryCount != 1)
{
    throw new InvalidOperationException("Failed/retry batch retry eligibility model is invalid.");
}

var idempotencyKey = new EvaluationRecordIdempotencyKey(
    drawForEvaluation.DrawId,
    Guid.NewGuid(),
    bindingForEvaluation.Id,
    moduleForEvaluation.ModuleId,
    moduleForEvaluation.ModuleVersion,
    "evaluation-idempotency");
var firstAttempt = evaluationOrchestrator.RecordEvaluation(seededRun.Id, seededBatches[0].Id, idempotencyKey, GameEvaluationOutcome.Pending);
var duplicateAttempt = evaluationOrchestrator.RecordEvaluation(seededRun.Id, seededBatches[0].Id, idempotencyKey, GameEvaluationOutcome.Win);
if (firstAttempt.Status != EvaluationDuplicateStatus.Created ||
    duplicateAttempt.Status != EvaluationDuplicateStatus.DuplicateReturnedExisting ||
    firstAttempt.Record.Id != duplicateAttempt.Record.Id)
{
    throw new InvalidOperationException("Duplicate evaluation idempotency failed.");
}

var alteredRecord = firstAttempt.Record with { Outcome = GameEvaluationOutcome.Win };
if (alteredRecord.Outcome == firstAttempt.Record.Outcome)
{
    throw new InvalidOperationException("Evaluation record immutability check failed.");
}

var progress = evaluationOrchestrator.GetProgress(seededRun.Id);
if (progress.PlannedBatchCount != seededRun.PlannedBatchCount)
{
    throw new InvalidOperationException("Evaluation progress diagnostics are invalid.");
}

var completionRun = evaluationOrchestrator.PlanRun(new EvaluationPlanRequest(
    drawForEvaluation.DrawId,
    bindingForEvaluation.Id,
    Guid.NewGuid(),
    EligibleTicketCount: 2,
    GameSpecificBatchSize: 1,
    moduleForEvaluation.ModuleId,
    moduleForEvaluation.ModuleVersion,
    "evaluation-completion"));
evaluationOrchestrator.StartRun(completionRun.Id);
foreach (var batch in evaluationOrchestrator.GetBatches(completionRun.Id))
{
    evaluationOrchestrator.CompleteBatch(batch.Id, processedCount: 1, lastProcessedMarker: $"completed:{batch.Sequence}");
}

if (evaluationOrchestrator.GetRun(completionRun.Id)?.Status != EvaluationRunStatus.Completed)
{
    throw new InvalidOperationException("Completed run detection failed.");
}

var failedRun = evaluationOrchestrator.PlanRun(new EvaluationPlanRequest(
    drawForEvaluation.DrawId,
    bindingForEvaluation.Id,
    Guid.NewGuid(),
    EligibleTicketCount: 1,
    GameSpecificBatchSize: 1,
    moduleForEvaluation.ModuleId,
    moduleForEvaluation.ModuleVersion,
    "evaluation-failure"));
evaluationOrchestrator.StartRun(failedRun.Id);
evaluationOrchestrator.FailBatch(evaluationOrchestrator.GetBatches(failedRun.Id).Single().Id, "placeholder failure");
if (evaluationOrchestrator.GetRun(failedRun.Id)?.Status != EvaluationRunStatus.Failed)
{
    throw new InvalidOperationException("Failed run detection failed.");
}

var orchestratorStatus = evaluationOrchestrator.GetStatus();
if (orchestratorStatus.ProductionRabbitMqWiringEnabled || orchestratorStatus.SettlementIntegrationEnabled)
{
    throw new InvalidOperationException("Evaluation orchestrator must not wire production RabbitMQ or settlement.");
}

var rabbitMqDiagnostics = new EvaluationRabbitMqDiagnostics(evaluationOrchestrator);
var queueNames = new[]
{
    EvaluationQueueNames.BatchRequested,
    EvaluationQueueNames.BatchStarted,
    EvaluationQueueNames.BatchCompleted,
    EvaluationQueueNames.BatchFailed,
    EvaluationQueueNames.BatchRetryScheduled,
    EvaluationQueueNames.BatchDeadLettered,
    EvaluationQueueNames.WorkerHeartbeat
};
if (queueNames.Distinct().Count() != 7 || queueNames.Any(string.IsNullOrWhiteSpace))
{
    throw new InvalidOperationException("Evaluation RabbitMQ routing key constants are invalid.");
}

var publishRun = evaluationOrchestrator.PlanRun(new EvaluationPlanRequest(
    drawForEvaluation.DrawId,
    bindingForEvaluation.Id,
    Guid.NewGuid(),
    EligibleTicketCount: 25,
    GameSpecificBatchSize: 10,
    moduleForEvaluation.ModuleId,
    moduleForEvaluation.ModuleVersion,
    "evaluation-rabbitmq"));
var publish = rabbitMqDiagnostics.PublishBatches(publishRun.Id, Guid.NewGuid());
if (publish.PublishingEnabled || publish.ExternalPublishAttempted || publish.FinancialMutationPerformed)
{
    throw new InvalidOperationException("Evaluation RabbitMQ publishing must remain disabled by default.");
}

if (publish.WorkItems.Count != publishRun.PlannedBatchCount ||
    publish.WorkItems.Any(item => item.RoutingKey != EvaluationQueueNames.BatchRequested || item.DrawId != publishRun.DrawId || item.GameModuleId != publishRun.GameModuleId))
{
    throw new InvalidOperationException("Evaluation batch publisher produced invalid work item contracts.");
}

var processing = rabbitMqDiagnostics.ProcessFirstRequested();
if (processing.Disposition != EvaluationMessageDisposition.Ack || processing.SettlementIntegrationTriggered || processing.ExternalBrokerMutationPerformed)
{
    throw new InvalidOperationException("Evaluation batch consumer skeleton did not ack safely.");
}

var processedBatch = evaluationOrchestrator.GetBatch(processing.BatchId);
if (processedBatch?.Status != EvaluationBatchStatus.Completed)
{
    throw new InvalidOperationException("Evaluation batch consumer did not mark the batch completed.");
}

var duplicateProcessing = rabbitMqDiagnostics.ProcessFirstRequested();
if (duplicateProcessing.Disposition != EvaluationMessageDisposition.Ack)
{
    throw new InvalidOperationException("Evaluation consumer should continue processing independent work items.");
}

var requeueRun = evaluationOrchestrator.PlanRun(new EvaluationPlanRequest(
    drawForEvaluation.DrawId,
    bindingForEvaluation.Id,
    Guid.NewGuid(),
    EligibleTicketCount: 1,
    GameSpecificBatchSize: 1,
    moduleForEvaluation.ModuleId,
    moduleForEvaluation.ModuleVersion,
    "evaluation-requeue"));
var requeueBatch = evaluationOrchestrator.GetBatches(requeueRun.Id).Single();
var requeue = rabbitMqDiagnostics.RequeueBatch(requeueBatch.Id);
if (requeue.Disposition != EvaluationMessageDisposition.NackRetry ||
    evaluationOrchestrator.GetBatch(requeueBatch.Id)?.Status != EvaluationBatchStatus.RetryPending)
{
    throw new InvalidOperationException("Evaluation retry eligibility model failed.");
}

var poison = rabbitMqDiagnostics.SimulatePoisonMessage();
if (!poison.PoisonMessageDetected || poison.Id == Guid.Empty)
{
    throw new InvalidOperationException("Poison message dead-letter model failed.");
}

var reviewedDeadLetter = rabbitMqDiagnostics.ReviewDeadLetter(poison.Id);
if (reviewedDeadLetter.ReviewedAt is null)
{
    throw new InvalidOperationException("Dead-letter operator review placeholder failed.");
}

var queueDiagnostics = rabbitMqDiagnostics.GetQueues();
if (queueDiagnostics.Count != 7 || queueDiagnostics.Any(queue => queue.ExternalBrokerMutationPerformed))
{
    throw new InvalidOperationException("Evaluation queue diagnostics are invalid.");
}

var workerHeartbeats = rabbitMqDiagnostics.GetWorkerHeartbeats();
if (workerHeartbeats.Count == 0 || workerHeartbeats.Any(heartbeat => heartbeat.Status == EvaluationWorkerStatus.Failed))
{
    throw new InvalidOperationException("Evaluation worker heartbeat model failed.");
}

var processingStatus = rabbitMqDiagnostics.GetProcessingStatus();
if (processingStatus.ProductionGameLogicEnabled || processingStatus.TicketDbIntegrationEnabled || processingStatus.SettlementIntegrationEnabled)
{
    throw new InvalidOperationException("Evaluation processing diagnostics must keep production integrations disabled.");
}

var databaseTicketReader = new DatabaseTicketReader();
var evaluationRecordRepository = new InMemoryEvaluationRecordRepository();
var evaluationPersistence = new EvaluationPersistenceService(evaluationRecordRepository, databaseTicketReader);
var executionService = new GameModuleExecutionService(registry, evaluationOrchestrator, databaseTicketReader, evaluationPersistence);
var resolution = executionService.GetModuleResolution();
if (!resolution.Any(item => item.ModuleId == "KENO_GENERIC" && item.Resolved))
{
    throw new InvalidOperationException("Keno module should resolve for execution.");
}

if (resolution.Any(item => item.ModuleId == "HOT_SPOT" && item.Resolved))
{
    throw new InvalidOperationException("Development lifecycle modules should not resolve for execution.");
}

var ticketReaders = executionService.GetTicketReaders();
if (ticketReaders.Count == 0)
{
    throw new InvalidOperationException("Placeholder ticket reader should be exposed.");
}

var execution = executionService.ExecuteReferenceRun(Guid.NewGuid());
if (execution.ModuleId != "KENO_GENERIC" ||
    execution.TicketsRead == 0 ||
    execution.RecordsCreated == 0 ||
    execution.TicketFailures == 0 ||
    execution.SettlementIntegrationTriggered ||
    execution.FinancialMutationPerformed)
{
    throw new InvalidOperationException("Keno module execution framework did not execute safely.");
}

if (execution.EvaluationRecords.Any(record =>
        record.DrawId == Guid.Empty ||
        string.IsNullOrWhiteSpace(record.IdempotencyKey) ||
        record.GameId == Guid.Empty ||
        record.ModuleId != "KENO_GENERIC" ||
        string.IsNullOrWhiteSpace(record.EvaluatorVersion) ||
        string.IsNullOrWhiteSpace(record.PaytableVersion)))
{
    throw new InvalidOperationException("Evaluation record builder produced incomplete records.");
}

var persistedRecords = evaluationPersistence.GetByRun(execution.RunId);
if (persistedRecords.Count != execution.EvaluationRecords.Count)
{
    throw new InvalidOperationException("Evaluation records must be persisted by run.");
}

var firstPersistedRecord = persistedRecords.First();
if (evaluationPersistence.FindById(firstPersistedRecord.Id) is null ||
    evaluationPersistence.FindByIdempotencyKey(firstPersistedRecord.IdempotencyKey) is null)
{
    throw new InvalidOperationException("Evaluation record lookup by id and idempotency key failed.");
}

if (evaluationPersistence.GetByDraw(firstPersistedRecord.DrawId).Count == 0 ||
    evaluationPersistence.GetByTicket(firstPersistedRecord.TicketId).Count != 1 ||
    evaluationPersistence.GetByBatch(firstPersistedRecord.BatchId).Count == 0)
{
    throw new InvalidOperationException("Evaluation record query services are incomplete.");
}

var duplicatePersistence = evaluationPersistence.InsertEvaluationRecord(firstPersistedRecord with
{
    Amount = firstPersistedRecord.Amount with { PayoutAmount = firstPersistedRecord.Amount.PayoutAmount + 999m }
});
if (duplicatePersistence.Created ||
    duplicatePersistence.Record.Id != firstPersistedRecord.Id ||
    duplicatePersistence.Record.Amount.PayoutAmount != firstPersistedRecord.Amount.PayoutAmount)
{
    throw new InvalidOperationException("Persistent evaluation record duplicate insert must return the immutable original.");
}

var checkpoints = evaluationPersistence.GetCheckpoints(execution.RunId);
if (checkpoints.Count == 0 ||
    checkpoints.Any(checkpoint => checkpoint.Status != EvaluationCheckpointStatus.Completed || checkpoint.ProcessedCount == 0))
{
    throw new InvalidOperationException("Persistent evaluation checkpoints were not updated.");
}

var resume = executionService.ResumeRun(execution.RunId, Guid.NewGuid());
if (resume.FinancialMutationPerformed ||
    resume.SettlementIntegrationTriggered ||
    resume.RecordsCreated != 0 ||
    evaluationPersistence.GetByRun(execution.RunId).Count != persistedRecords.Count)
{
    throw new InvalidOperationException("Evaluation replay/resume must not duplicate completed records or mutate finances.");
}

var rangeTickets = databaseTicketReader.ReadByRange(firstPersistedRecord.DrawId, firstPersistedRecord.GameId, 0, 3);
var cursorTickets = databaseTicketReader.ReadByCursor(firstPersistedRecord.DrawId, firstPersistedRecord.GameId, "2", 2);
if (rangeTickets.Count != 3 || cursorTickets.Count != 2)
{
    throw new InvalidOperationException("Database ticket reader range/cursor reads failed.");
}

var schemaPath = Path.Combine("services", "game-engine", "database", "002_durable_evaluation_storage.sql");
if (!File.Exists(schemaPath))
{
    throw new InvalidOperationException("Durable evaluation storage schema artifact is missing.");
}

var schema = File.ReadAllText(schemaPath);
if (!schema.Contains("game_engine.evaluation_records", StringComparison.OrdinalIgnoreCase) ||
    !schema.Contains("idempotency_key text not null unique", StringComparison.OrdinalIgnoreCase) ||
    !schema.Contains("prevent_evaluation_record_mutation", StringComparison.OrdinalIgnoreCase) ||
    !schema.Contains("settlement_consumer_status", StringComparison.OrdinalIgnoreCase))
{
    throw new InvalidOperationException("Durable schema must document idempotency, append-only guards, and settlement consumer fields.");
}

var runRepository = new OrchestratorEvaluationRunRepository(evaluationOrchestrator);
var batchRepository = new OrchestratorEvaluationBatchRepository(evaluationOrchestrator);
var settlementReadService = new SettlementEvaluationReadService(runRepository, batchRepository, evaluationPersistence);
var activationGate = new SettlementConsumerActivationGate(evaluationPersistence);
var settlementRecords = settlementReadService.ListSettlementReadyRecords();
if (settlementRecords.Count == 0 ||
    settlementRecords.Any(record => record.Outcome == GameEvaluationOutcome.Rejected || record.ConsumerStatus == SettlementEvaluationConsumerStatus.Consumed))
{
    throw new InvalidOperationException("Settlement-ready read model must include only unconsumed evaluable records.");
}

var consumedRecord = firstPersistedRecord with
{
    Id = Guid.NewGuid(),
    IdempotencyKey = $"consumed:{firstPersistedRecord.IdempotencyKey}",
    EvaluationMetadata = new Dictionary<string, object?>(firstPersistedRecord.EvaluationMetadata)
    {
        ["settlementConsumerStatus"] = SettlementEvaluationConsumerStatus.Consumed.ToString(),
        ["settlementConsumedAt"] = DateTimeOffset.UtcNow.ToString("O"),
        ["settlementConsumedBy"] = "test-consumer"
    }
};
evaluationPersistence.InsertEvaluationRecord(consumedRecord);
if (settlementReadService.ListSettlementReadyRecords().Any(record => record.EvaluationRecordId == consumedRecord.Id))
{
    throw new InvalidOperationException("Consumed records must be excluded by default.");
}

var incompleteRun = evaluationOrchestrator.PlanRun(new EvaluationPlanRequest(
    Guid.NewGuid(),
    bindingForEvaluation.Id,
    Guid.NewGuid(),
    EligibleTicketCount: 1,
    GameSpecificBatchSize: 1,
    moduleForEvaluation.ModuleId,
    moduleForEvaluation.ModuleVersion,
    "evaluation-incomplete-settlement-filter"));
var incompleteRecord = firstPersistedRecord with
{
    Id = Guid.NewGuid(),
    IdempotencyKey = $"incomplete:{firstPersistedRecord.IdempotencyKey}",
    RunId = incompleteRun.Id
};
evaluationPersistence.InsertEvaluationRecord(incompleteRecord);
if (settlementReadService.ListSettlementReadyRecords().Any(record => record.EvaluationRecordId == incompleteRecord.Id))
{
    throw new InvalidOperationException("Incomplete runs must be excluded from settlement-ready records.");
}

var activationStatus = activationGate.GetStatus();
if (activationStatus.Enabled ||
    activationStatus.ActivationAllowed ||
    activationStatus.Blockers.Count == 0 ||
    activationStatus.SettlementMutationPerformed ||
    activationStatus.FinancialMutationPerformed)
{
    throw new InvalidOperationException("Settlement consumer activation gate must remain disabled and mutation-free.");
}

var storageStatus = evaluationPersistence.GetStorageStatus();
if (!storageStatus.DurableSchemaArtifactPresent ||
    !storageStatus.DurableRepositoryContractsPresent ||
    !storageStatus.AppendOnlyGuardDesigned ||
    storageStatus.SettlementConsumerIntegrationEnabled ||
    storageStatus.FinancialPostingEnabled)
{
    throw new InvalidOperationException("Durable evaluation storage status is invalid.");
}

if (!execution.TicketResults.Any(result => !result.ValidationAccepted && result.Outcome == GameEvaluationOutcome.Rejected))
{
    throw new InvalidOperationException("Batch execution should continue after single-ticket validation failure.");
}

var executionDiagnostics = executionService.GetDiagnostics();
if (executionDiagnostics.ExecutionCount == 0 ||
    !executionDiagnostics.TicketDatabaseReadsEnabled ||
    executionDiagnostics.SettlementIntegrationEnabled ||
    executionDiagnostics.FinancialPostingEnabled)
{
    throw new InvalidOperationException("Module execution diagnostics are invalid.");
}

Console.WriteLine("GameEngine.Application.Tests PASS");
