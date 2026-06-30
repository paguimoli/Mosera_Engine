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

if (modules.Count != 2)
{
    throw new InvalidOperationException("Expected skeleton HotSpot and TestModule module statuses.");
}

if (modules.Any(module => module.Manifest.SupportedWagerTypes.Count == 0))
{
    throw new InvalidOperationException("Module status must expose supported wager types.");
}

var registryStatus = registry.GetRegistryStatus();
if (registryStatus.RegisteredModuleCount != 2)
{
    throw new InvalidOperationException("Expected two registered modules.");
}

if (registry.GetInactiveModules().Count != 2)
{
    throw new InvalidOperationException("Current placeholder modules must remain inactive.");
}

if (registry.GetProductionReadyModules().Count != 0)
{
    throw new InvalidOperationException("No module should be production-ready in this phase.");
}

var bindings = registry.GetGameBindings();
if (bindings.Count != 2)
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

Console.WriteLine("GameEngine.Application.Tests PASS");
