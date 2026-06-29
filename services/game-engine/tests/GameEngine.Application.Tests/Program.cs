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

Console.WriteLine("GameEngine.Application.Tests PASS");
