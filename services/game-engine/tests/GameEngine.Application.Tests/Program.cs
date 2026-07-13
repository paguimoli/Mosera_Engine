using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using GameEngine.Domain.Randomness;
using GameEngine.Infrastructure.Persistence;
using System.Security.Cryptography;
using System.Text;

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

static OutcomeProviderDefinitionV1 RuntimeProvider(
    string providerId,
    string providerVersion,
    OutcomeProviderType providerType,
    OutcomeProviderLifecycleState lifecycleState = OutcomeProviderLifecycleState.Active,
    bool productionEligible = true,
    bool supportsReceipt = false,
    IReadOnlyCollection<OutcomePrimitiveType>? primitives = null)
{
    return new OutcomeProviderDefinitionV1(
        Guid.NewGuid(),
        providerId,
        providerVersion,
        providerType,
        lifecycleState,
        productionEligible,
        primitives ?? [OutcomePrimitiveType.UniqueNumberSet],
        new Dictionary<string, object?> { ["runtimeEvidence"] = true },
        ["runtime-shell-ready"],
        providerType == OutcomeProviderType.ProvablyFair
            ? OutcomeProviderIdempotencyModel.PerWager
            : OutcomeProviderIdempotencyModel.PerDraw,
        [OutcomeProviderCustodyState.Requested, OutcomeProviderCustodyState.Generated],
        new Dictionary<string, object?> { ["signatureRequired"] = true },
        ReplayabilitySupport: true,
        OutcomeProviderFailureMode.FailClosed,
        new OutcomeProviderCapabilityMarkers(
            GeneratesOutcomes: providerType is OutcomeProviderType.CertifiedCsprng or OutcomeProviderType.ProvablyFair or OutcomeProviderType.SimulationTest,
            IngestsExternalOutcomes: providerType is OutcomeProviderType.ExternalOfficialResult or OutcomeProviderType.PhysicalDrawResult,
            SupportsPlayerVerificationReceipt: supportsReceipt,
            SupportsDeterministicReplay: true,
            SupportsProviderHealthEvidence: true,
            SupportsDisputeHandling: true,
            SupportsExternalSourceEvidence: providerType == OutcomeProviderType.ExternalOfficialResult,
            SupportsPhysicalDrawEvidence: providerType == OutcomeProviderType.PhysicalDrawResult),
        $"sha256:runtime-provider:{providerId}:{providerVersion}",
        CertificationBinding: null);
}

static OutcomeProviderRuntimeRequest RuntimeRequest(
    string idempotencyKey,
    string scope,
    string providerId,
    string providerVersion,
    OutcomeProviderType expectedType,
    OutcomeRuntimeExecutionMode mode = OutcomeRuntimeExecutionMode.DryRun,
    string canonicalHash = "sha256:runtime-request")
{
    return new OutcomeProviderRuntimeRequest(
        Guid.NewGuid(),
        idempotencyKey,
        scope,
        "game-manifest:runtime-test",
        "1.0.0",
        new OutcomeProviderManifestBinding(
            providerId,
            providerVersion,
            [OutcomePrimitiveType.UniqueNumberSet],
            new Dictionary<string, object?> { ["runtimeEvidence"] = true },
            PlayerVerificationReceiptRequired: expectedType == OutcomeProviderType.ProvablyFair,
            new Dictionary<string, object?> { ["failClosed"] = true },
            CertificationRequired: false),
        expectedType,
        mode,
        [OutcomePrimitiveType.UniqueNumberSet],
        canonicalHash);
}

var runtimeResolver = new OutcomeProviderResolver();
var runtimeProvider = RuntimeProvider(
    "outcome-provider:runtime:certified-csprng",
    "1.0.0",
    OutcomeProviderType.CertifiedCsprng);
var runtimeRequest = RuntimeRequest(
    "runtime-idempotency-1",
    "draw:runtime-1",
    runtimeProvider.ProviderId,
    runtimeProvider.ProviderVersion,
    OutcomeProviderType.CertifiedCsprng);
var resolvedRuntimeProvider = await runtimeResolver.ResolveAsync(runtimeRequest, [runtimeProvider], CancellationToken.None);
if (resolvedRuntimeProvider.ProviderId != runtimeProvider.ProviderId)
{
    throw new InvalidOperationException("Outcome Provider runtime resolver must select the exact manifest-bound provider.");
}

var autoEntropy = new AutoOsEntropyProvider();
var entropyReadiness = autoEntropy.CheckReadiness();
if (!entropyReadiness.Ready)
{
    throw new InvalidOperationException("Supported OS entropy provider must be ready for CSPRNG runtime tests.");
}

var entropyProbe = new byte[32];
autoEntropy.Fill(entropyProbe);
if (entropyProbe.All(value => value == 0))
{
    throw new InvalidOperationException("OS entropy provider returned an all-zero probe.");
}

CryptographicOperations.ZeroMemory(entropyProbe);

var drbgRuntime = new HmacDrbgRuntime();
var drbgReadiness = drbgRuntime.RunHealthChecks();
if (!drbgReadiness.IsReady ||
    drbgReadiness.KnownAnswerResults.Count != 3 ||
    drbgReadiness.KnownAnswerResults.Any(result => !result.Passed))
{
    throw new InvalidOperationException("HMAC-DRBG startup, KAT, and continuous health checks must pass.");
}

foreach (var hashAlgorithm in Enum.GetValues<CertifiedCsprngHashAlgorithm>())
{
    var entropy = Enumerable.Range(0, 48).Select(index => (byte)(index + 1)).ToArray();
    var nonce = Enumerable.Range(0, 16).Select(index => (byte)(0x80 + index)).ToArray();
    var personalization = Encoding.UTF8.GetBytes($"application-test-{hashAlgorithm}");
    HmacDrbgSession? firstSession = null;
    HmacDrbgSession? secondSession = null;
    byte[]? firstOutput = null;
    byte[]? secondOutput = null;
    try
    {
        firstSession = drbgRuntime.Instantiate(hashAlgorithm, entropy, nonce, personalization, 256);
        secondSession = drbgRuntime.Instantiate(hashAlgorithm, entropy, nonce, personalization, 256);
        firstOutput = drbgRuntime.Generate(firstSession, 96);
        secondOutput = drbgRuntime.Generate(secondSession, 96);
        if (!CryptographicOperations.FixedTimeEquals(firstOutput, secondOutput))
        {
            throw new InvalidOperationException($"{hashAlgorithm} deterministic test vector must be reproducible.");
        }

        drbgRuntime.Reseed(firstSession, entropy, Encoding.UTF8.GetBytes("reseed"));
        var reseeded = drbgRuntime.Generate(firstSession, 32);
        if (CryptographicOperations.FixedTimeEquals(firstOutput.AsSpan(0, 32), reseeded))
        {
            throw new InvalidOperationException($"{hashAlgorithm} reseed should change generated output.");
        }

        CryptographicOperations.ZeroMemory(reseeded);
        drbgRuntime.Destroy(firstSession);
        var destroyedFailed = false;
        try
        {
            drbgRuntime.Generate(firstSession, 16);
        }
        catch (ObjectDisposedException)
        {
            destroyedFailed = true;
        }

        if (!destroyedFailed)
        {
            throw new InvalidOperationException("Destroyed HMAC-DRBG session must fail closed.");
        }
    }
    finally
    {
        if (firstSession is not null)
        {
            drbgRuntime.Destroy(firstSession);
        }

        if (secondSession is not null)
        {
            drbgRuntime.Destroy(secondSession);
        }

        CryptographicOperations.ZeroMemory(entropy);
        CryptographicOperations.ZeroMemory(nonce);
        CryptographicOperations.ZeroMemory(personalization);
        if (firstOutput is not null)
        {
            CryptographicOperations.ZeroMemory(firstOutput);
        }

        if (secondOutput is not null)
        {
            CryptographicOperations.ZeroMemory(secondOutput);
        }
    }
}

var samplerEntropy = Enumerable.Range(0, 48).Select(index => (byte)(index + 3)).ToArray();
var samplerNonce = Enumerable.Range(0, 16).Select(index => (byte)(0x40 + index)).ToArray();
var samplerPersonalization = Encoding.UTF8.GetBytes("sampler-test");
var sampler = new CertifiedCsprngSampler(drbgRuntime);
HmacDrbgSession? samplerSession = null;
try
{
    samplerSession = drbgRuntime.Instantiate(CertifiedCsprngHashAlgorithm.Sha256, samplerEntropy, samplerNonce, samplerPersonalization, 256);
    var bounded = sampler.NextInt32(samplerSession, 7, 13);
    if (bounded is < 7 or > 13)
    {
        throw new InvalidOperationException("Rejection-sampled bounded integer must stay within range.");
    }

    var shuffled = sampler.FisherYatesShuffle(samplerSession, [1, 2, 3, 4, 5]);
    if (shuffled.Order().SequenceEqual([1, 2, 3, 4, 5]) is false)
    {
        throw new InvalidOperationException("Fisher-Yates shuffle must preserve the original set.");
    }

    var unique = sampler.UniqueNumbers(samplerSession, 1, 40, 6);
    if (unique.Count != 6 || unique.Distinct().Count() != 6 || unique.Any(value => value is < 1 or > 40))
    {
        throw new InvalidOperationException("Unique-number selection must return unique values inside the configured range.");
    }

    var weighted = sampler.WeightedSelection(samplerSession, new Dictionary<string, long>
    {
        ["A"] = 1,
        ["B"] = 2,
        ["C"] = 3
    });
    if (weighted is not ("A" or "B" or "C"))
    {
        throw new InvalidOperationException("Integer/rational weighted selection must return a configured key.");
    }
}
finally
{
    if (samplerSession is not null)
    {
        drbgRuntime.Destroy(samplerSession);
    }

    CryptographicOperations.ZeroMemory(samplerEntropy);
    CryptographicOperations.ZeroMemory(samplerNonce);
    CryptographicOperations.ZeroMemory(samplerPersonalization);
}

var missingProviderFailed = false;
try
{
    await runtimeResolver.ResolveAsync(runtimeRequest, [], CancellationToken.None);
}
catch (InvalidOperationException)
{
    missingProviderFailed = true;
}

if (!missingProviderFailed)
{
    throw new InvalidOperationException("Missing Outcome Provider must fail closed.");
}

var typeMismatchFailed = false;
try
{
    await runtimeResolver.ResolveAsync(
        runtimeRequest,
        [runtimeProvider with { ProviderType = OutcomeProviderType.ProvablyFair }],
        CancellationToken.None);
}
catch (InvalidOperationException)
{
    typeMismatchFailed = true;
}

if (!typeMismatchFailed)
{
    throw new InvalidOperationException("Outcome Provider type mismatch must fail closed.");
}

var inactiveProviderFailed = false;
try
{
    await runtimeResolver.ResolveAsync(
        runtimeRequest,
        [runtimeProvider with { LifecycleState = OutcomeProviderLifecycleState.Suspended }],
        CancellationToken.None);
}
catch (InvalidOperationException)
{
    inactiveProviderFailed = true;
}

if (!inactiveProviderFailed)
{
    throw new InvalidOperationException("Inactive Outcome Provider must fail closed.");
}

var fallbackFailed = false;
try
{
    await runtimeResolver.ResolveAsync(
        runtimeRequest with { SilentFallbackConfigured = true },
        [runtimeProvider],
        CancellationToken.None);
}
catch (InvalidOperationException)
{
    fallbackFailed = true;
}

if (!fallbackFailed)
{
    throw new InvalidOperationException("Silent fallback Outcome Provider must fail closed.");
}

var simulationProductionFailed = false;
try
{
    var simulationProvider = RuntimeProvider(
        "outcome-provider:runtime:simulation",
        "1.0.0",
        OutcomeProviderType.SimulationTest);
    await runtimeResolver.ResolveAsync(
        RuntimeRequest(
            "runtime-idempotency-simulation",
            "draw:runtime-simulation",
            simulationProvider.ProviderId,
            simulationProvider.ProviderVersion,
            OutcomeProviderType.SimulationTest,
            OutcomeRuntimeExecutionMode.Production),
        [simulationProvider],
        CancellationToken.None);
}
catch (InvalidOperationException)
{
    simulationProductionFailed = true;
}

if (!simulationProductionFailed)
{
    throw new InvalidOperationException("Simulation/test provider must be rejected for production mode.");
}

var runtimeRepository = new InMemoryOutcomeRuntimeRequestRepository();
var runtimeLockManager = new InMemoryOutcomeRuntimeLockManager();
var runtimeProvenanceRepository = new InMemoryOutcomeRuntimeProvenanceRepository();
var runtimeRecoveryService = new OutcomeRuntimeRecoveryService(
    runtimeProvenanceRepository,
    new EnvironmentOutcomeRuntimeCrashInjector());
await runtimeRecoveryService.RecordBootAsync(CancellationToken.None);
var runtimeOrchestrator = new OutcomeProviderOrchestrationService(
    runtimeResolver,
    runtimeRepository,
    runtimeLockManager,
    [
        new CertifiedCsprngOutcomeProviderRuntime(),
        new ProvablyFairOutcomeProviderRuntime(),
        new ExternalOfficialResultOutcomeProviderRuntime(),
        new PhysicalDrawResultOutcomeProviderRuntime(),
        new SimulationTestOutcomeProviderRuntime()
    ],
    runtimeRecoveryService);
var runtimeResult = await runtimeOrchestrator.ExecuteAsync(runtimeRequest, [runtimeProvider], CancellationToken.None);
if (runtimeResult.Status != OutcomeRuntimeStatus.Accepted ||
    runtimeResult.FailureCode != OutcomeRuntimeFailureCode.None ||
    runtimeResult.EvidenceReference is null ||
    runtimeResult.ResultReference is not null)
{
    throw new InvalidOperationException("Certified CSPRNG dry-run runtime must persist evidence without creating production outcome references.");
}

if (runtimeRepository.Requests.Count != 1 || runtimeRepository.Attempts.Count != 1)
{
    throw new InvalidOperationException("Outcome Provider runtime attempt evidence must persist in the repository boundary.");
}

if (runtimeProvenanceRepository.Boots.Count != 1 ||
    runtimeProvenanceRepository.Evidence.All(evidence => evidence.EventType != OutcomeRuntimeRecoveryEventType.Boot))
{
    throw new InvalidOperationException("Outcome runtime recovery service must persist immutable boot evidence.");
}

var duplicateRuntimeResult = await runtimeOrchestrator.ExecuteAsync(runtimeRequest, [runtimeProvider], CancellationToken.None);
if (duplicateRuntimeResult.Status != OutcomeRuntimeStatus.DuplicateReturned ||
    duplicateRuntimeResult.RuntimeRequestId != runtimeResult.RuntimeRequestId)
{
    throw new InvalidOperationException("Duplicate runtime idempotency request must return existing deterministic state.");
}

if (runtimeProvenanceRepository.Evidence.All(evidence => evidence.ReasonCode != "IDEMPOTENT_REPLAY"))
{
    throw new InvalidOperationException("Duplicate runtime replay must append recovery evidence without regenerating.");
}

var conflictFailed = false;
try
{
    await runtimeOrchestrator.ExecuteAsync(
        runtimeRequest with
        {
            RuntimeRequestId = Guid.NewGuid(),
            CanonicalRequestHash = "sha256:conflicting-runtime-request"
        },
        [runtimeProvider],
        CancellationToken.None);
}
catch (InvalidOperationException)
{
    conflictFailed = true;
}

if (!conflictFailed)
{
    throw new InvalidOperationException("Conflicting duplicate runtime idempotency payload must be rejected.");
}

var lockedRepository = new InMemoryOutcomeRuntimeRequestRepository();
var lockedLockManager = new InMemoryOutcomeRuntimeLockManager();
var lockedRequest = RuntimeRequest(
    "runtime-idempotency-lock",
    "draw:runtime-lock",
    runtimeProvider.ProviderId,
    runtimeProvider.ProviderVersion,
    OutcomeProviderType.CertifiedCsprng,
    canonicalHash: "sha256:runtime-lock");
lockedLockManager.Hold(OutcomeProviderOrchestrationService.BuildLockScope(lockedRequest));
var lockedOrchestrator = new OutcomeProviderOrchestrationService(
    runtimeResolver,
    lockedRepository,
    lockedLockManager,
    [new CertifiedCsprngOutcomeProviderRuntime()]);
var lockedResult = await lockedOrchestrator.ExecuteAsync(lockedRequest, [runtimeProvider], CancellationToken.None);
if (lockedResult.Status != OutcomeRuntimeStatus.FailedClosed ||
    lockedResult.FailureCode != OutcomeRuntimeFailureCode.LockUnavailable)
{
    throw new InvalidOperationException("Concurrent same-scope requests must fail closed when the advisory lock is unavailable.");
}

var inMemoryRuntimeReadiness = await runtimeRepository.CheckReadinessAsync(CancellationToken.None);
if (inMemoryRuntimeReadiness.DurablePersistenceConfigured ||
    inMemoryRuntimeReadiness.ProductionGenerationDisabled is false ||
    inMemoryRuntimeReadiness.Blockers.Count == 0)
{
    throw new InvalidOperationException("In-memory runtime persistence must remain explicit non-production fallback.");
}

var inMemoryLockingReadiness = await runtimeLockManager.CheckReadinessAsync(CancellationToken.None);
if (inMemoryLockingReadiness.AdvisoryLockingConfigured ||
    !inMemoryLockingReadiness.RedisLockDependencyAbsent ||
    inMemoryLockingReadiness.Blockers.Count == 0)
{
    throw new InvalidOperationException("In-memory runtime locking must remain explicit non-production fallback.");
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

var inMemoryModuleRepository = new InMemoryGameModuleRepository();
var inMemoryModuleVersionRepository = new InMemoryGameModuleVersionRepository();
var inMemoryDefinitionRepository = new InMemoryGameDefinitionRepository();
var inMemoryDefinitionVersionRepository = new InMemoryGameDefinitionVersionRepository();
var persistedRegistry = new GameModuleRegistry(
    inMemoryModuleRepository,
    inMemoryModuleVersionRepository,
    inMemoryDefinitionRepository,
    inMemoryDefinitionVersionRepository);
var persistedModules = await inMemoryModuleRepository.ListAsync(CancellationToken.None);
var persistedDefinitions = await inMemoryDefinitionRepository.ListAsync(CancellationToken.None);
if (persistedRegistry.GetRegisteredModules().Count != 3 ||
    persistedModules.Count != 3 ||
    persistedDefinitions.Count != 3)
{
    throw new InvalidOperationException("In-memory catalog repositories should mirror discovered modules and prospective definitions.");
}

var firstPersistedModule = persistedModules.First();
var firstPersistedModuleVersions = await inMemoryModuleVersionRepository.ListAsync(firstPersistedModule.Id, CancellationToken.None);
if (firstPersistedModuleVersions.Count == 0)
{
    throw new InvalidOperationException("In-memory module version persistence failed.");
}

var firstPersistedDefinition = persistedDefinitions.First();
var firstPersistedDefinitionVersions = await inMemoryDefinitionVersionRepository.ListAsync(firstPersistedDefinition.Id, CancellationToken.None);
if (firstPersistedDefinitionVersions.Count == 0)
{
    throw new InvalidOperationException("In-memory game definition version persistence failed.");
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

var inMemoryAuthorityRepository = new InMemoryDrawAuthorityRepository();
var inMemoryAuthorityVersionRepository = new InMemoryDrawAuthorityVersionRepository();
var inMemoryAuthorityAssignmentRepository = new InMemoryDrawAuthorityAssignmentRepository();
var persistedAuthorityRegistry = new DrawAuthorityRegistry(inMemoryAuthorityRepository, inMemoryAuthorityVersionRepository);
var persistedAuthorities = await inMemoryAuthorityRepository.ListAsync(CancellationToken.None);
if (persistedAuthorityRegistry.GetRegisteredAuthorities().Count < 5 ||
    persistedAuthorities.Count < 5)
{
    throw new InvalidOperationException("In-memory draw authority repositories should mirror registered authorities.");
}

var firstPersistedAuthority = persistedAuthorities.First();
var firstPersistedAuthorityVersions = await inMemoryAuthorityVersionRepository.ListAsync(firstPersistedAuthority.Id, CancellationToken.None);
if (firstPersistedAuthorityVersions.Count == 0)
{
    throw new InvalidOperationException("In-memory draw authority version persistence failed.");
}

var inMemoryAssignment = new DrawAuthorityAssignment(
    Guid.NewGuid(),
    Guid.NewGuid(),
    firstPersistedAuthority.Id,
    firstPersistedAuthority.ActiveVersionId,
    SettlementTriggerPolicy.Manual,
    DateTimeOffset.UtcNow,
    EffectiveTo: null);
await inMemoryAuthorityAssignmentRepository.UpsertAsync(inMemoryAssignment, CancellationToken.None);
if ((await inMemoryAuthorityAssignmentRepository.ListAsync(inMemoryAssignment.GameDefinitionId, CancellationToken.None)).All(assignment => assignment.Id != inMemoryAssignment.Id))
{
    throw new InvalidOperationException("In-memory draw authority assignment persistence failed.");
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

var inMemoryDrawScheduleRepository = new InMemoryDrawScheduleRepository();
var persistentScheduler = new DrawSchedulerService(registry, drawAuthorityRegistry, inMemoryDrawScheduleRepository);
var persistentLifecycle = persistentScheduler.GetLifecycle();
var persistedSchedules = await inMemoryDrawScheduleRepository.ListAsync(CancellationToken.None);
if (persistedSchedules.Count == 0 ||
    persistedSchedules.Any(schedule => persistentLifecycle.All(draw => draw.DrawId != schedule.Id)))
{
    throw new InvalidOperationException("In-memory draw schedule repository fallback did not persist lifecycle rows.");
}

var persistentMissedDraw = persistentLifecycle
    .Where(draw => draw.ResultSource == DrawResultSource.ManualCertified)
    .OrderBy(draw => draw.DrawAt)
    .First();
var persistentMarked = persistentScheduler.MarkMissed(persistentMissedDraw.DrawId);
var persistedMarked = await inMemoryDrawScheduleRepository.GetAsync(persistentMarked.DrawId, CancellationToken.None);
if (persistedMarked?.Status != DrawLifecycleStatus.ManualReviewRequired)
{
    throw new InvalidOperationException("In-memory mark-missed lifecycle persistence failed.");
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
var evaluationCheckpointRepository = new InMemoryEvaluationCheckpointRepository();
var evaluationPersistence = new EvaluationPersistenceService(evaluationRecordRepository, evaluationCheckpointRepository, databaseTicketReader);
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

if (evaluationPersistence.GetStorageStatus().DurableRepositoryWiringEnabled)
{
    throw new InvalidOperationException("Evaluation persistence must use in-memory fallback when DATABASE_URL is absent from test setup.");
}

var databaseUrl = Environment.GetEnvironmentVariable("DATABASE_URL");
if (!string.IsNullOrWhiteSpace(databaseUrl))
{
    var postgresModuleRepository = new PostgresGameModuleRepository(databaseUrl);
    var postgresModuleVersionRepository = new PostgresGameModuleVersionRepository(databaseUrl);
    var postgresDefinitionRepository = new PostgresGameDefinitionRepository(databaseUrl);
    var postgresDefinitionVersionRepository = new PostgresGameDefinitionVersionRepository(databaseUrl);
    var postgresAuthorityRepository = new PostgresDrawAuthorityRepository(databaseUrl);
    var postgresAuthorityVersionRepository = new PostgresDrawAuthorityVersionRepository(databaseUrl);
    var postgresAuthorityAssignmentRepository = new PostgresDrawAuthorityAssignmentRepository(databaseUrl);
    var postgresDrawScheduleRepository = new PostgresDrawScheduleRepository(databaseUrl);
    var postgresRunRepository = new PostgresEvaluationRunRepository(databaseUrl);
    var postgresBatchRepository = new PostgresEvaluationBatchRepository(databaseUrl);
    var postgresRecordRepository = new PostgresEvaluationRecordRepository(databaseUrl);
    var postgresCheckpointRepository = new PostgresEvaluationCheckpointRepository(databaseUrl);
    var catalogModuleId = Guid.NewGuid();
    var catalogModuleVersionId = Guid.NewGuid();
    var catalogDefinitionId = Guid.NewGuid();
    var catalogDefinitionVersionId = Guid.NewGuid();
    var catalogModule = new GameModule(
        catalogModuleId,
        $"phase-24-2c-module-{catalogModuleId:N}",
        "Phase 24.2C Module",
        GameModuleLifecycleStatus.Approved,
        catalogModuleVersionId);
    var persistedCatalogModule = await postgresModuleRepository.UpsertAsync(catalogModule, CancellationToken.None);
    if (persistedCatalogModule.Id != catalogModuleId ||
        persistedCatalogModule.ActiveVersionId != catalogModuleVersionId ||
        (await postgresModuleRepository.GetAsync(catalogModuleId, CancellationToken.None)) is null)
    {
        throw new InvalidOperationException("Postgres game module persistence failed.");
    }

    var catalogModuleVersion = new GameModuleVersion(
        catalogModuleVersionId,
        catalogModuleId,
        "24.2C-test",
        "sdk-test",
        $"manifest-{catalogModuleVersionId:N}",
        GameModuleLifecycleStatus.Approved,
        DateTimeOffset.UtcNow);
    var persistedCatalogModuleVersion = await postgresModuleVersionRepository.UpsertAsync(catalogModuleVersion, CancellationToken.None);
    if (persistedCatalogModuleVersion.Id != catalogModuleVersionId ||
        (await postgresModuleVersionRepository.ListAsync(catalogModuleId, CancellationToken.None)).All(version => version.Id != catalogModuleVersionId))
    {
        throw new InvalidOperationException("Postgres game module version persistence failed.");
    }

    var catalogDefinition = new GameDefinition(
        catalogDefinitionId,
        $"phase-24-2c-definition-{catalogDefinitionId:N}",
        "Phase 24.2C Definition",
        catalogDefinitionVersionId,
        catalogModuleId,
        DateTimeOffset.UtcNow);
    var persistedCatalogDefinition = await postgresDefinitionRepository.UpsertAsync(catalogDefinition, CancellationToken.None);
    if (persistedCatalogDefinition.Id != catalogDefinitionId ||
        persistedCatalogDefinition.GameModuleId != catalogModuleId ||
        (await postgresDefinitionRepository.GetAsync(catalogDefinitionId, CancellationToken.None)) is null)
    {
        throw new InvalidOperationException("Postgres game definition persistence failed.");
    }

    var catalogDefinitionVersion = new GameDefinitionVersion(
        catalogDefinitionVersionId,
        catalogDefinitionId,
        VersionNumber: 1,
        $"definition-{catalogDefinitionVersionId:N}",
        "paytable-test",
        "evaluator-test",
        "draw-generator-test",
        DateTimeOffset.UtcNow,
        EffectiveTo: null);
    var persistedCatalogDefinitionVersion = await postgresDefinitionVersionRepository.UpsertAsync(catalogDefinitionVersion, CancellationToken.None);
    if (persistedCatalogDefinitionVersion.Id != catalogDefinitionVersionId ||
        (await postgresDefinitionVersionRepository.ListAsync(catalogDefinitionId, CancellationToken.None)).All(version => version.Id != catalogDefinitionVersionId))
    {
        throw new InvalidOperationException("Postgres game definition version persistence failed.");
    }

    var authorityId = Guid.NewGuid();
    var authorityVersionId = Guid.NewGuid();
    var authority = new DrawAuthority(
        authorityId,
        $"phase-24-2d-authority-{authorityId:N}",
        "Phase 24.2D Authority",
        DrawProviderType.ManualCertifiedEntry,
        DrawAuthorityStatus.Testing,
        authorityVersionId);
    var persistedAuthority = await postgresAuthorityRepository.UpsertAsync(authority, CancellationToken.None);
    if (persistedAuthority.Id != authorityId ||
        persistedAuthority.ActiveVersionId != authorityVersionId ||
        (await postgresAuthorityRepository.GetAsync(authorityId, CancellationToken.None)) is null)
    {
        throw new InvalidOperationException("Postgres draw authority persistence failed.");
    }

    var authorityVersion = new DrawAuthorityVersion(
        authorityVersionId,
        authorityId,
        "24.2D-test",
        "provider-test",
        $"configuration-{authorityVersionId:N}",
        DrawAuthorityStatus.Testing,
        DateTimeOffset.UtcNow);
    var persistedAuthorityVersion = await postgresAuthorityVersionRepository.UpsertAsync(authorityVersion, CancellationToken.None);
    if (persistedAuthorityVersion.Id != authorityVersionId ||
        (await postgresAuthorityVersionRepository.ListAsync(authorityId, CancellationToken.None)).All(version => version.Id != authorityVersionId))
    {
        throw new InvalidOperationException("Postgres draw authority version persistence failed.");
    }

    var authorityAssignment = new DrawAuthorityAssignment(
        Guid.NewGuid(),
        catalogDefinitionId,
        authorityId,
        authorityVersionId,
        SettlementTriggerPolicy.Manual,
        DateTimeOffset.UtcNow,
        EffectiveTo: null);
    var persistedAuthorityAssignment = await postgresAuthorityAssignmentRepository.UpsertAsync(authorityAssignment, CancellationToken.None);
    if (persistedAuthorityAssignment.Id != authorityAssignment.Id ||
        (await postgresAuthorityAssignmentRepository.ListAsync(catalogDefinitionId, CancellationToken.None)).All(assignment => assignment.Id != authorityAssignment.Id))
    {
        throw new InvalidOperationException("Postgres draw authority assignment persistence failed.");
    }

    var drawScheduleId = Guid.NewGuid();
    var postgresDrawSchedule = new DrawSchedule(
        drawScheduleId,
        catalogDefinitionId,
        authorityAssignment.Id,
        DateTimeOffset.UtcNow.AddMinutes(-10),
        DateTimeOffset.UtcNow.AddMinutes(-1),
        DateTimeOffset.UtcNow,
        DrawLifecycleStatus.AwaitingResult);
    var persistedDrawSchedule = await postgresDrawScheduleRepository.UpsertAsync(postgresDrawSchedule, CancellationToken.None);
    if (persistedDrawSchedule.Id != drawScheduleId ||
        persistedDrawSchedule.Status != DrawLifecycleStatus.AwaitingResult ||
        (await postgresDrawScheduleRepository.GetAsync(drawScheduleId, CancellationToken.None)) is null)
    {
        throw new InvalidOperationException("Postgres draw schedule persistence failed.");
    }

    var missedDrawSchedule = await postgresDrawScheduleRepository.UpsertAsync(
        postgresDrawSchedule with { Status = DrawLifecycleStatus.ManualReviewRequired },
        CancellationToken.None);
    if (missedDrawSchedule.Status != DrawLifecycleStatus.ManualReviewRequired ||
        (await postgresDrawScheduleRepository.ListAsync(CancellationToken.None)).All(schedule => schedule.Id != drawScheduleId))
    {
        throw new InvalidOperationException("Postgres draw schedule lifecycle update did not persist.");
    }

    var postgresCatalogRegistry = new GameModuleRegistry(
        postgresModuleRepository,
        postgresModuleVersionRepository,
        postgresDefinitionRepository,
        postgresDefinitionVersionRepository);
    if (postgresCatalogRegistry.GetRegisteredModules().Count != 3 ||
        postgresCatalogRegistry.GetGameBindings().Count != 3)
    {
        throw new InvalidOperationException("Postgres-backed catalog registry must preserve existing API-facing behavior.");
    }

    var postgresScheduler = new DrawSchedulerService(registry, drawAuthorityRegistry, postgresDrawScheduleRepository);
    var postgresLifecycle = postgresScheduler.GetLifecycle();
    var postgresLifecycleDraw = postgresLifecycle
        .Where(draw => draw.ResultSource == DrawResultSource.ManualCertified)
        .OrderBy(draw => draw.DrawAt)
        .First();
    if (await postgresDrawScheduleRepository.GetAsync(postgresLifecycleDraw.DrawId, CancellationToken.None) is null)
    {
        throw new InvalidOperationException("Postgres-backed scheduler did not persist lifecycle records.");
    }

    var postgresMarked = postgresScheduler.MarkMissed(postgresLifecycleDraw.DrawId);
    var postgresMarkedSchedule = await postgresDrawScheduleRepository.GetAsync(postgresMarked.DrawId, CancellationToken.None);
    if (postgresMarkedSchedule?.Status != DrawLifecycleStatus.ManualReviewRequired)
    {
        throw new InvalidOperationException("Postgres-backed scheduler mark-missed did not persist.");
    }

    var postgresRunId = Guid.NewGuid();
    var postgresBatchId = Guid.NewGuid();
    var postgresDrawId = Guid.NewGuid();
    var postgresGameId = Guid.NewGuid();
    var postgresRun = new EvaluationRunDefinition(
        postgresRunId,
        postgresDrawId,
        postgresGameId,
        Guid.NewGuid(),
        "KENO_GENERIC",
        "1.0.0",
        "postgres-evaluator-test",
        EvaluationRunStatus.Planned,
        BatchSize: 5,
        EligibleTicketCount: 5,
        PlannedBatchCount: 1,
        DateTimeOffset.UtcNow,
        StartedAt: null,
        CompletedAt: null,
        Array.Empty<string>());
    var persistedRun = postgresRunRepository.UpsertRun(postgresRun);
    if (persistedRun.Id != postgresRunId ||
        persistedRun.Status != EvaluationRunStatus.Planned ||
        postgresRunRepository.GetRuns().All(run => run.Id != postgresRunId))
    {
        throw new InvalidOperationException("Postgres evaluation run create/read did not persist.");
    }

    var startedRun = postgresRunRepository.UpsertRun(postgresRun with
    {
        Status = EvaluationRunStatus.InProgress,
        StartedAt = DateTimeOffset.UtcNow
    });
    if (startedRun.Status != EvaluationRunStatus.InProgress ||
        startedRun.StartedAt is null ||
        postgresRunRepository.GetRun(postgresRunId)?.Status != EvaluationRunStatus.InProgress)
    {
        throw new InvalidOperationException("Postgres evaluation run status update did not persist.");
    }

    var postgresBatch = new EvaluationBatchDefinition(
        postgresBatchId,
        postgresRunId,
        Sequence: 0,
        StartInclusive: 0,
        EndExclusive: 5,
        EvaluationBatchStatus.Pending,
        CheckpointCursor: "0",
        RetryCount: 0,
        DateTimeOffset.UtcNow,
        ClaimedAt: null,
        CompletedAt: null);
    var persistedBatch = postgresBatchRepository.UpsertBatch(startedRun, postgresBatch);
    if (persistedBatch.Id != postgresBatchId ||
        persistedBatch.Status != EvaluationBatchStatus.Pending ||
        postgresBatchRepository.GetBatches(postgresRunId).Count != 1)
    {
        throw new InvalidOperationException("Postgres evaluation batch create/read did not persist.");
    }

    var completedBatch = postgresBatchRepository.UpsertBatch(
        startedRun,
        postgresBatch with
        {
            Status = EvaluationBatchStatus.Completed,
            CheckpointCursor = "5",
            CompletedAt = DateTimeOffset.UtcNow
        });
    var completedRun = postgresRunRepository.UpsertRun(startedRun with
    {
        Status = EvaluationRunStatus.Completed,
        CompletedAt = DateTimeOffset.UtcNow
    });
    if (completedBatch.Status != EvaluationBatchStatus.Completed ||
        completedBatch.CompletedAt is null ||
        completedBatch.CheckpointCursor != "5" ||
        completedRun.Status != EvaluationRunStatus.Completed ||
        completedRun.CompletedAt is null)
    {
        throw new InvalidOperationException("Postgres run/batch progress updates did not persist.");
    }

    var postgresRecord = new ImmutableEvaluationRecord(
        Guid.NewGuid(),
        $"phase-24-2a:{Guid.NewGuid():N}",
        postgresRunId,
        postgresBatchId,
        Guid.NewGuid(),
        postgresDrawId,
        postgresGameId,
        "KENO_GENERIC",
        "1.0.0",
        "postgres-evaluator-test",
        "postgres-paytable-test",
        GameEvaluationOutcome.Win,
        GameEvaluationReason.KenoSpotMatch,
        new GameEvaluationAmount("USD", 10m, 20m, 10m),
        new Dictionary<string, object?> { ["source"] = "postgres-repository-test" },
        DateTimeOffset.UtcNow);

    var postgresInsert = postgresRecordRepository.InsertEvaluationRecord(postgresRecord);
    if (!postgresInsert.Created || postgresInsert.Record.Id != postgresRecord.Id)
    {
        throw new InvalidOperationException("Postgres evaluation record insert did not persist the new record.");
    }

    var postgresDuplicate = postgresRecordRepository.InsertEvaluationRecord(postgresRecord with
    {
        Id = Guid.NewGuid(),
        Amount = postgresRecord.Amount with { PayoutAmount = 999m }
    });
    if (postgresDuplicate.Created ||
        postgresDuplicate.Record.Id != postgresRecord.Id ||
        postgresDuplicate.Record.Amount.PayoutAmount != postgresRecord.Amount.PayoutAmount)
    {
        throw new InvalidOperationException("Postgres duplicate idempotency key must return the existing immutable record.");
    }

    if (postgresRecordRepository.GetByRun(postgresRunId).All(record => record.Id != postgresRecord.Id) ||
        postgresRecordRepository.GetByBatch(postgresBatchId).All(record => record.Id != postgresRecord.Id))
    {
        throw new InvalidOperationException("Postgres evaluation record lookup by run/batch failed.");
    }

    var postgresCheckpoint = postgresCheckpointRepository.UpsertCheckpoint(
        completedRun,
        completedBatch,
        processedCount: 5,
        failedCount: 1,
        EvaluationCheckpointStatus.Completed);
    if (postgresCheckpoint.RunId != postgresRunId ||
        postgresCheckpoint.BatchId != postgresBatchId ||
        postgresCheckpoint.ProcessedCount != 5 ||
        postgresCheckpoint.FailedCount != 1)
    {
        throw new InvalidOperationException("Postgres checkpoint upsert did not persist the checkpoint.");
    }

    var postgresCheckpointUpdate = postgresCheckpointRepository.UpsertCheckpoint(
        completedRun,
        completedBatch with { RetryCount = 1, CheckpointCursor = "5" },
        processedCount: 6,
        failedCount: 0,
        EvaluationCheckpointStatus.RetryPending);
    if (postgresCheckpointUpdate.RetryCount != 1 ||
        postgresCheckpointUpdate.Cursor != "5" ||
        postgresCheckpointUpdate.ProcessedCount != 6 ||
        postgresCheckpointRepository.GetCheckpoints(postgresRunId).Count != 1)
    {
        throw new InvalidOperationException("Postgres checkpoint upsert must update the existing run/batch checkpoint deterministically.");
    }
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

var runRepository = new InMemoryEvaluationRunRepository();
var batchRepository = new InMemoryEvaluationBatchRepository();
foreach (var runForReadModel in evaluationOrchestrator.GetRuns())
{
    runRepository.UpsertRun(runForReadModel);
    foreach (var batchForReadModel in evaluationOrchestrator.GetBatches(runForReadModel.Id))
    {
        batchRepository.UpsertBatch(runForReadModel, batchForReadModel);
    }
}

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

var outcomePipeline = new OutcomeDryRunPipeline();
var outcomeStrategy = new OutcomeStrategyDefinitionV1(
    Guid.NewGuid(),
    "outcome-strategy:dry-run",
    "1.0.0",
    [
        new OutcomeDslPrimitive(
            "numbers",
            OutcomePrimitiveType.UniqueNumberSet,
            [],
            1,
            20,
            5,
            [],
            [],
            [],
            new Dictionary<string, object?>()),
        new OutcomeDslPrimitive(
            "bonus",
            OutcomePrimitiveType.WeightedSelection,
            ["numbers"],
            null,
            null,
            null,
            [],
            [],
            [new WeightedOutcomeOption("RED", 1m), new WeightedOutcomeOption("BLUE", 2m)],
            new Dictionary<string, object?>()),
        new OutcomeDslPrimitive(
            "composite",
            OutcomePrimitiveType.CompositeOutcomeGraph,
            ["numbers", "bonus"],
            null,
            null,
            null,
            [],
            [],
            [],
            new Dictionary<string, object?>())
    ],
    new Dictionary<string, object?> { ["drawId"] = "uuid" },
    new Dictionary<string, object?> { ["resultType"] = "dry-run" },
    new Dictionary<string, object?>(),
    [],
    OutcomeStrategyLifecycleState.GovernanceApproved,
    "sha256:dry-run-strategy",
    null,
    null);

var dryRunProvider = new RngProviderDefinitionV1(
    Guid.NewGuid(),
    "rng-provider:deterministic-test",
    "1.0.0",
    RngProviderType.TestDeterministic,
    ProductionEligible: false,
    RngProviderCertificationState.InternalVerified,
    ["deterministic-test-v1"],
    new Dictionary<string, object?> { ["seedPolicy"] = "idempotency-derived" },
    ["deterministic-health-check"],
    RngProviderFailureMode.FailClosed,
    "sha256:dry-run-provider",
    null);

var dryRunEvidence = new RngProviderEvidence(
    Guid.NewGuid(),
    dryRunProvider.ProviderId,
    dryRunProvider.ProviderVersion,
    "entropy-source:deterministic-test",
    RngHealthTestResult.Passed,
    RngHealthTestResult.NotApplicable,
    RngHealthTestResult.Passed,
    DateTimeOffset.UtcNow,
    "sha256:dry-run-evidence",
    null);

var outcomeRequest = new OutcomeAuthorityRequest(
    Guid.NewGuid(),
    Guid.NewGuid(),
    "game-manifest:dry-run:1.0.0",
    outcomeStrategy.StrategyId,
    outcomeStrategy.StrategyVersion,
    dryRunProvider.ProviderId,
    dryRunProvider.ProviderVersion,
    dryRunEvidence.CanonicalEvidenceHash,
    "outcome-dry-run-idempotency",
    OutcomeAuthorityMode.DryRun);

var firstOutcome = outcomePipeline.Execute(outcomeRequest, outcomeStrategy, dryRunProvider, dryRunEvidence);
var duplicateOutcome = outcomePipeline.Execute(outcomeRequest, outcomeStrategy, dryRunProvider, dryRunEvidence);
if (firstOutcome.OutcomeId != duplicateOutcome.OutcomeId ||
    firstOutcome.Certificate.CertificateId != duplicateOutcome.Certificate.CertificateId ||
    firstOutcome.CanonicalOutcomeHash != duplicateOutcome.CanonicalOutcomeHash)
{
    throw new InvalidOperationException("Outcome dry-run pipeline must return deterministic idempotent responses.");
}

if (firstOutcome.Certificate.CustodyState != OutcomeCustodyState.Generated ||
    firstOutcome.Certificate.EvidenceHashReference != dryRunEvidence.CanonicalEvidenceHash)
{
    throw new InvalidOperationException("Outcome dry-run pipeline must create a generated outcome certificate with evidence reference.");
}

var productionDisabledRequest = outcomeRequest with
{
    IdempotencyKey = "outcome-production-disabled",
    Mode = OutcomeAuthorityMode.ProductionDisabled
};
AssertThrows(
    () => outcomePipeline.Execute(productionDisabledRequest, outcomeStrategy, dryRunProvider, dryRunEvidence),
    "ProductionDisabled outcome mode must be rejected.");

var productionEligibleProvider = dryRunProvider with
{
    ProviderType = RngProviderType.OsCsprng,
    ProductionEligible = true
};
AssertThrows(
    () => outcomePipeline.Execute(outcomeRequest with { IdempotencyKey = "outcome-production-provider" }, outcomeStrategy, productionEligibleProvider, dryRunEvidence),
    "Dry-run outcome pipeline must reject production-eligible RNG providers.");

var invalidProviderReference = dryRunProvider with { ProviderId = "rng-provider:other" };
AssertThrows(
    () => outcomePipeline.Execute(outcomeRequest with { IdempotencyKey = "outcome-invalid-provider" }, outcomeStrategy, invalidProviderReference, dryRunEvidence),
    "Outcome pipeline must reject invalid provider references.");

var outcomeAuthorityGuardrails = new OutcomeAuthorityActivationGuardrailService();
var readyMarkers = new OutcomeAuthorityReadinessMarkers(
    GameManifestSchemaReady: true,
    AuthorityCertificateChainReady: true,
    OutcomeDslReady: true,
    MathRtpGovernanceReady: true,
    RngProviderGovernanceReady: true,
    OutcomeDryRunPipelineReady: true,
    MathEvaluationDryRunReady: true,
    CertificationPackReady: true,
    CertificateSigningFrameworkReady: true,
    StatisticalValidationReady: true,
    OperationalControlsReady: true);

var missingProviderBinding = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    HasExactOutcomeProviderBinding: false));

if (missingProviderBinding.Allowed ||
    !missingProviderBinding.Blockers.Contains("Game Manifest must bind exactly one Outcome Provider version."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed when manifest provider binding is missing.");
}

var providerCapabilityMismatch = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    OutcomeProviderCapabilitiesSatisfied: false));

if (providerCapabilityMismatch.Allowed ||
    !providerCapabilityMismatch.Blockers.Contains("Outcome Provider capabilities must satisfy the Game Manifest requirements."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed on provider capability mismatch.");
}

var silentFallbackProvider = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    SilentFallbackConfigured: true));

if (silentFallbackProvider.Allowed ||
    !silentFallbackProvider.Blockers.Contains("Silent fallback Outcome Providers are not allowed."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed on silent fallback providers.");
}

var missingCertifiedCsprngRequirements = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    CertifiedCsprngProviderRequirementsSatisfied: false));

if (missingCertifiedCsprngRequirements.Allowed ||
    !missingCertifiedCsprngRequirements.Blockers.Contains("Certified CSPRNG provider requirements must be satisfied."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed when Certified CSPRNG requirements are missing.");
}

var missingEntropyEligibility = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    EntropyProviderProductionEligible: false));

if (missingEntropyEligibility.Allowed ||
    !missingEntropyEligibility.Blockers.Contains("Entropy provider must be production eligible."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed when entropy provider eligibility is missing.");
}

var missingDrbgEvidence = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    DrbgHealthEvidenceSatisfied: false));

if (missingDrbgEvidence.Allowed ||
    !missingDrbgEvidence.Blockers.Contains("Certified CSPRNG startup, KAT, and continuous health evidence must be present."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed when DRBG health evidence is missing.");
}

var missingSamplingCapabilities = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    UnbiasedSamplingCapabilitiesSatisfied: false));

if (missingSamplingCapabilities.Allowed ||
    !missingSamplingCapabilities.Blockers.Contains("Certified CSPRNG provider requires unbiased sampling capabilities."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed when unbiased sampling capabilities are missing.");
}

var rawSecretMaterialPersisted = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    NoRawSecretMaterialPersisted: false));

if (rawSecretMaterialPersisted.Allowed ||
    !rawSecretMaterialPersisted.Blockers.Contains("Raw entropy, seed material, and DRBG state must never be persisted."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed when raw secret material is persisted.");
}

var missingProvablyFairRequirements = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    ProvablyFairProviderRequirementsSatisfied: false));

if (missingProvablyFairRequirements.Allowed ||
    !missingProvablyFairRequirements.Blockers.Contains("Provably Fair provider requirements must be satisfied."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed when Provably Fair requirements are missing.");
}

var missingProvablyFairReceiptSupport = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    ProvablyFairReceiptSupportAvailable: false));

if (missingProvablyFairReceiptSupport.Allowed ||
    !missingProvablyFairReceiptSupport.Blockers.Contains("Provably Fair receipt support must be available."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed when Provably Fair receipt support is missing.");
}

var invalidProvablyFairNoncePolicy = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    ProvablyFairNoncePolicyValid: false));

if (invalidProvablyFairNoncePolicy.Allowed ||
    !invalidProvablyFairNoncePolicy.Blockers.Contains("Provably Fair nonce policy must be valid."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed when Provably Fair nonce policy is invalid.");
}

var provablyFairSeedLeakage = outcomeAuthorityGuardrails.Evaluate(new OutcomeAuthorityActivationRequest(
    readyMarkers,
    ProductionOutcomeAuthorityEnabled: true,
    ProductionRngProviderEligible: true,
    SigningProviderProductionEligible: true,
    CertificationPackReady: true,
    UsesSimulationOrTestProvider: false,
    JurisdictionOmitted: true,
    ManifestRequiresCertification: false,
    CertificationOmitted: true,
    HasFailedOrInconclusiveStatisticalValidation: false,
    HasActiveEmergencyDisable: false,
    ProvablyFairNoSeedLeakage: false));

if (provablyFairSeedLeakage.Allowed ||
    !provablyFairSeedLeakage.Blockers.Contains("Provably Fair governance must not leak server seed material."))
{
    throw new InvalidOperationException("Outcome Authority guardrails must fail closed when Provably Fair seed material leaks.");
}

var clientSeedService = new ProvablyFairClientSeedService();
var canonicalClientSeed = clientSeedService.Canonicalize(
    "  PLAYER-SEED-001  ",
    new ProvablyFairClientSeedPolicy(
        Required: true,
        MaximumLength: 32,
        ProvablyFairEncoding.Utf8,
        ["non-empty"],
        ["trim"]));
if (canonicalClientSeed != "PLAYER-SEED-001")
{
    throw new InvalidOperationException("Provably Fair client seed canonicalization must be deterministic.");
}

AssertThrows(
    () => clientSeedService.Canonicalize(
        string.Empty,
        new ProvablyFairClientSeedPolicy(true, 32, ProvablyFairEncoding.Utf8, ["non-empty"], ["trim"])),
    "Provably Fair client seed policy must reject missing required seeds.");

var fixedSeedMaterial = Enumerable.Range(1, 32).Select(value => (byte)value).ToArray();
var fixedSeedCustody = new InMemoryProvablyFairSeedCustodyRepository(new FixedEntropyProvider(fixedSeedMaterial));
var committedSeed = await fixedSeedCustody.GetOrCreateActiveSeedAsync(
    "provably-fair:test",
    "1.0.0",
    "wager:commitment",
    ProvablyFairHashAlgorithm.Sha256,
    CancellationToken.None);
var repeatedCommittedSeed = await fixedSeedCustody.GetOrCreateActiveSeedAsync(
    "provably-fair:test",
    "1.0.0",
    "wager:commitment",
    ProvablyFairHashAlgorithm.Sha256,
    CancellationToken.None);
if (committedSeed.CommitmentHash != repeatedCommittedSeed.CommitmentHash)
{
    throw new InvalidOperationException("Provably Fair commitment must be deterministic for an existing seed scope.");
}

var differentSeed = await new InMemoryProvablyFairSeedCustodyRepository(new FixedEntropyProvider([.. fixedSeedMaterial.Select(value => (byte)(value + 1))]))
    .GetOrCreateActiveSeedAsync(
        "provably-fair:test",
        "1.0.0",
        "wager:commitment",
        ProvablyFairHashAlgorithm.Sha256,
        CancellationToken.None);
if (differentSeed.CommitmentHash == committedSeed.CommitmentHash)
{
    throw new InvalidOperationException("Different Provably Fair server seeds must produce different commitments.");
}

var nonceAllocator = new InMemoryProvablyFairNonceAllocator();
var firstNonce = await nonceAllocator.AllocateAsync(
    "provably-fair:test",
    "1.0.0",
    "wager:nonce",
    ProvablyFairNonceScopeType.Wager,
    "provider-wager",
    CancellationToken.None);
var secondNonce = await nonceAllocator.AllocateAsync(
    "provably-fair:test",
    "1.0.0",
    "wager:nonce",
    ProvablyFairNonceScopeType.Wager,
    "provider-wager",
    CancellationToken.None);
if (firstNonce.Nonce != 1 || secondNonce.Nonce != 2)
{
    throw new InvalidOperationException("Provably Fair nonce allocation must be monotonic per scope.");
}

var provablyFairEvidence = new InMemoryProvablyFairRuntimeEvidenceRepository();
var provablyFairRuntimeService = new ProvablyFairRuntimeService(
    fixedSeedCustody,
    nonceAllocator,
    provablyFairEvidence,
    clientSeedService);
var provablyFairProvider = RuntimeProvider(
    "provably-fair:test",
    "1.0.0",
    OutcomeProviderType.ProvablyFair,
    supportsReceipt: true);
var provablyFairRequest = RuntimeRequest(
    "provably-fair-runtime-idempotency",
    "wager:runtime",
    provablyFairProvider.ProviderId,
    provablyFairProvider.ProviderVersion,
    OutcomeProviderType.ProvablyFair,
    canonicalHash: "sha256:provably-fair-runtime-request");
var provablyFairContext = new OutcomeProviderRuntimeContext(provablyFairRequest, provablyFairProvider);
var provablyFairGenerated = await provablyFairRuntimeService.GenerateAsync(provablyFairContext, CancellationToken.None);
if (provablyFairGenerated.Receipt.ReceiptHash.Contains("serverseed", StringComparison.OrdinalIgnoreCase) ||
    provablyFairGenerated.Receipt.CanonicalVerificationPayload.Contains("serverSeed", StringComparison.OrdinalIgnoreCase))
{
    throw new InvalidOperationException("Provably Fair receipt must not expose unrevealed server seed material.");
}

var revealVerification = await provablyFairRuntimeService.VerifyRevealedReceiptAsync(
    provablyFairGenerated.Receipt,
    committedSeed.ProtectedSeedMaterial,
    CancellationToken.None);
if (revealVerification.Status != ProvablyFairRuntimeRevealStatus.Verified)
{
    throw new InvalidOperationException("Provably Fair post-reveal verification must recompute the commitment successfully.");
}

var tamperedSeed = Enumerable.Range(50, 32).Select(value => (byte)value).ToArray();
var tamperedVerification = await provablyFairRuntimeService.VerifyRevealedReceiptAsync(
    provablyFairGenerated.Receipt,
    tamperedSeed,
    CancellationToken.None);
if (tamperedVerification.Status != ProvablyFairRuntimeRevealStatus.Failed)
{
    throw new InvalidOperationException("Provably Fair verification must fail for tampered reveal material.");
}

var provablyFairRuntime = new ProvablyFairOutcomeProviderRuntime(provablyFairRuntimeService);
var productionProvablyFair = await provablyFairRuntime.CreateOutcomeAsync(
    new OutcomeProviderRuntimeContext(
        RuntimeRequest(
            "provably-fair-production-disabled",
            "wager:production-disabled",
            provablyFairProvider.ProviderId,
            provablyFairProvider.ProviderVersion,
            OutcomeProviderType.ProvablyFair,
            OutcomeRuntimeExecutionMode.Production,
            "sha256:provably-fair-production-disabled"),
        provablyFairProvider),
    CancellationToken.None);
if (productionProvablyFair.Status != OutcomeRuntimeStatus.ProductionDisabled)
{
    throw new InvalidOperationException("Provably Fair runtime must reject production mode.");
}

var provablyFairRepository = new InMemoryOutcomeRuntimeRequestRepository();
var provablyFairOrchestration = new OutcomeProviderOrchestrationService(
    runtimeResolver,
    provablyFairRepository,
    new InMemoryOutcomeRuntimeLockManager(),
    [provablyFairRuntime]);
var orchestratedProvablyFair = await provablyFairOrchestration.ExecuteAsync(
    provablyFairRequest,
    [provablyFairProvider],
    CancellationToken.None);
if (orchestratedProvablyFair.Status != OutcomeRuntimeStatus.Accepted ||
    orchestratedProvablyFair.EvidenceReference is null ||
    !orchestratedProvablyFair.EvidenceReference.StartsWith("placeholder:provably-fair-receipt:", StringComparison.Ordinal))
{
    throw new InvalidOperationException("Provably Fair runtime must generate an internal dry-run receipt reference.");
}

var duplicateProvablyFair = await provablyFairOrchestration.ExecuteAsync(
    provablyFairRequest,
    [provablyFairProvider],
    CancellationToken.None);
if (duplicateProvablyFair.Status != OutcomeRuntimeStatus.DuplicateReturned ||
    duplicateProvablyFair.EvidenceReference != orchestratedProvablyFair.EvidenceReference)
{
    throw new InvalidOperationException("Provably Fair duplicate idempotent request must return the same receipt reference.");
}

AssertThrows(
    () => provablyFairOrchestration.ExecuteAsync(
        provablyFairRequest with { CanonicalRequestHash = "sha256:provably-fair-conflict" },
        [provablyFairProvider],
        CancellationToken.None).GetAwaiter().GetResult(),
    "Provably Fair conflicting duplicate request must fail closed.");

var externalSource = new ExternalResultSourceDefinition(
    Guid.NewGuid(),
    "official-source:test",
    "1.0.0",
    "Official Source Test",
    ExternalResultSourceType.SignedFileFeed,
    new Dictionary<string, object?> { ["endpointReference"] = "qa-offline-feed" },
    ExternalResultAuthenticationMethod.DetachedSignature,
    ExternalResultSignatureRequirement.DetachedRequired,
    ExternalResultTransportSecurityRequirement.OfflineSignedFile,
    ["LOTTO-EXT"],
    [ExternalResultSchemaType.UniqueNumberSet],
    "UTC",
    new ExternalResultPublicationDelayPolicy(TimeSpan.FromMinutes(5), TimeSpan.FromDays(1), FutureTimestampsRejected: true),
    ReplayRetrievalCapability: true,
    ProductionEligible: false,
    ExternalResultSourceLifecycleState.Active,
    ExternalResultFailureMode.FailClosed,
    ExternalOfficialResultRuntimeService.HashCanonical("official-source:test|1.0.0"),
    CertificationBinding: null,
    VerificationKeyId: "test-key-1",
    VerificationAlgorithmVersion: "TEST_SHA256_DETACHED_V1",
    VerificationKeyRevokedAt: null,
    SupersedesSourceVersion: null);
if (!ExternalOfficialResultValidator.ValidateSource(externalSource).IsValid)
{
    throw new InvalidOperationException("Valid External Official Result source must pass validation.");
}

var externalProvider = RuntimeProvider(
    "external-official:test",
    "1.0.0",
    OutcomeProviderType.ExternalOfficialResult);
var externalEnvelope = new ExternalOfficialResultEnvelope(
    Guid.NewGuid(),
    "external-result-idempotency",
    externalSource.SourceId,
    externalSource.SourceVersion,
    externalProvider.ProviderId,
    externalProvider.ProviderVersion,
    "manifest-external",
    "1.0.0",
    "LOTTO-EXT",
    "draw-external-001",
    "external-draw-001",
    DateTimeOffset.UtcNow.AddMinutes(-2),
    DateTimeOffset.UtcNow.AddMinutes(-2),
    DateTimeOffset.UtcNow,
    ExternalOfficialResultRuntimeService.HashCanonical("source-payload-001"),
    SourceSignature: null,
    externalSource.VerificationAlgorithmVersion!,
    "official-numbers-v1",
    ExternalResultSchemaType.UniqueNumberSet,
    new Dictionary<string, object?> { ["numbers"] = new[] { 9, 1, 5, 2, 7 } },
    "transport-evidence:test",
    "source-metadata:test");
externalEnvelope = externalEnvelope with
{
    SourceSignature = ExternalOfficialResultRuntimeService.CreateTestSignature(externalSource, externalEnvelope)
};
var externalRequest = RuntimeRequest(
    "external-result-idempotency",
    "draw-external-001",
    externalProvider.ProviderId,
    externalProvider.ProviderVersion,
    OutcomeProviderType.ExternalOfficialResult,
    canonicalHash: ExternalOfficialResultRuntimeService.HashCanonical("external-result-request-001")) with
{
    GameManifestId = "manifest-external",
    GameManifestVersion = "1.0.0",
    ExternalOfficialResult = externalEnvelope
};
var externalSourceRepository = new InMemoryExternalResultSourceRepository();
externalSourceRepository.Add(externalSource);
var externalEvidenceRepository = new InMemoryExternalResultEvidenceRepository();
var externalRuntimeService = new ExternalOfficialResultRuntimeService(externalSourceRepository, externalEvidenceRepository);
var normalizedExternal = ExternalOfficialResultRuntimeService.Normalize(externalEnvelope);
var normalizedAgain = ExternalOfficialResultRuntimeService.Normalize(externalEnvelope with
{
    ResultPayload = new Dictionary<string, object?> { ["numbers"] = new[] { 7, 2, 5, 1, 9 } }
});
if (normalizedExternal.CanonicalPayloadHash != normalizedAgain.CanonicalPayloadHash)
{
    throw new InvalidOperationException("External official unique number set normalization must be deterministic.");
}

var externalContext = new OutcomeProviderRuntimeContext(externalRequest, externalProvider);
var ingestedExternal = await externalRuntimeService.IngestAsync(externalContext, CancellationToken.None);
if (ingestedExternal.Evidence.Status != ExternalResultVerificationStatus.Verified ||
    ingestedExternal.OutcomeCertificate.CanonicalOutcomeHash != normalizedExternal.CanonicalPayloadHash)
{
    throw new InvalidOperationException("External Official Result runtime must verify, normalize, and certify dry-run evidence.");
}

AssertThrows(
    () => externalRuntimeService.IngestAsync(
        new OutcomeProviderRuntimeContext(
            externalRequest with { ExternalOfficialResult = externalEnvelope with { SourceSignature = "sha256:invalid" } },
            externalProvider),
        CancellationToken.None).GetAwaiter().GetResult(),
    "Invalid External Official Result signature must fail closed.");

var externalRuntime = new ExternalOfficialResultOutcomeProviderRuntime(externalRuntimeService);
var externalOrchestrator = new OutcomeProviderOrchestrationService(
    runtimeResolver,
    new InMemoryOutcomeRuntimeRequestRepository(),
    new InMemoryOutcomeRuntimeLockManager(),
    [externalRuntime]);
var orchestratedExternal = await externalOrchestrator.ExecuteAsync(
    externalRequest,
    [externalProvider],
    CancellationToken.None);
if (orchestratedExternal.Status != OutcomeRuntimeStatus.Accepted ||
    orchestratedExternal.EvidenceReference is null ||
    !orchestratedExternal.EvidenceReference.StartsWith("placeholder:external-official-result:", StringComparison.Ordinal))
{
    throw new InvalidOperationException("External Official Result runtime must accept signed dry-run ingestion and return an evidence reference.");
}

var duplicateExternal = await externalOrchestrator.ExecuteAsync(
    externalRequest,
    [externalProvider],
    CancellationToken.None);
if (duplicateExternal.Status != OutcomeRuntimeStatus.DuplicateReturned ||
    duplicateExternal.EvidenceReference != orchestratedExternal.EvidenceReference)
{
    throw new InvalidOperationException("External Official Result duplicate idempotent request must return the same evidence reference.");
}

var conflictingEnvelope = externalEnvelope with
{
    IngestionRequestId = Guid.NewGuid(),
    IdempotencyKey = "external-result-idempotency-conflict",
    SourcePayloadHash = ExternalOfficialResultRuntimeService.HashCanonical("source-payload-conflict"),
    ResultPayload = new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 10 } }
};
conflictingEnvelope = conflictingEnvelope with
{
    SourceSignature = ExternalOfficialResultRuntimeService.CreateTestSignature(externalSource, conflictingEnvelope)
};
var conflictResult = await externalRuntime.CreateOutcomeAsync(
    new OutcomeProviderRuntimeContext(
        externalRequest with
        {
            RuntimeRequestId = Guid.NewGuid(),
            IdempotencyKey = "external-result-idempotency-conflict",
            CanonicalRequestHash = ExternalOfficialResultRuntimeService.HashCanonical("external-result-conflict"),
            ExternalOfficialResult = conflictingEnvelope
        },
        externalProvider),
    CancellationToken.None);
if (conflictResult.Status != OutcomeRuntimeStatus.FailedClosed ||
    conflictResult.FailureCode != OutcomeRuntimeFailureCode.ExternalResultConflict)
{
    throw new InvalidOperationException("Conflicting External Official Result must fail closed and require supersession.");
}

var productionExternal = await externalRuntime.CreateOutcomeAsync(
    new OutcomeProviderRuntimeContext(
        externalRequest with { Mode = OutcomeRuntimeExecutionMode.Production },
        externalProvider),
    CancellationToken.None);
if (productionExternal.Status != OutcomeRuntimeStatus.ProductionDisabled)
{
    throw new InvalidOperationException("External Official Result runtime must reject production mode.");
}

var physicalAuthority = new PhysicalDrawAuthorityDefinition(
    Guid.NewGuid(),
    "physical-authority:test",
    "1.0.0",
    "QA Physical Draw Authority",
    PhysicalDrawAuthorityType.GovernmentLottery,
    "CR",
    Jurisdiction: null,
    "QA Operator",
    "QA Draw Studio",
    "machine-alpha",
    "ball-set-alpha",
    "procedures-v1",
    ["LOTTO-PHYS"],
    [PhysicalDrawResultSchemaType.UniqueNumberSet],
    new PhysicalDrawWitnessPolicy(
        OperatorRequired: true,
        PrimaryWitnessRequired: true,
        SecondaryWitnessRequired: false,
        RegulatorWitnessRequired: false,
        MinimumWitnessCount: 2),
    new PhysicalDrawTimestampPolicy(TimeSpan.FromMinutes(5), TimeSpan.FromDays(1), FutureTimestampsRejected: true),
    ProductionEligible: false,
    PhysicalDrawAuthorityLifecycleState.Active,
    PhysicalDrawFailureMode.FailClosed,
    PhysicalDrawResultRuntimeService.HashCanonical("physical-authority:test|1.0.0"),
    CertificationBinding: null);
if (!PhysicalDrawResultValidator.ValidateAuthority(physicalAuthority).IsValid)
{
    throw new InvalidOperationException("Valid Physical Draw authority must pass validation.");
}

var physicalProvider = RuntimeProvider(
    "physical-draw:test",
    "1.0.0",
    OutcomeProviderType.PhysicalDrawResult);
var physicalEnvelope = new PhysicalDrawResultEnvelope(
    Guid.NewGuid(),
    "physical-draw-idempotency",
    "physical-draw-001",
    physicalProvider.ProviderId,
    physicalProvider.ProviderVersion,
    physicalAuthority.AuthorityId,
    physicalAuthority.AuthorityVersion,
    "manifest-physical",
    "1.0.0",
    "LOTTO-PHYS",
    DateTimeOffset.UtcNow.AddMinutes(-3),
    DateTimeOffset.UtcNow.AddMinutes(-5),
    DateTimeOffset.UtcNow,
    PhysicalDrawResultSchemaType.UniqueNumberSet,
    new Dictionary<string, object?> { ["numbers"] = new[] { 19, 3, 11, 7, 5 } },
    "machine-alpha",
    "ball-set-alpha",
    "operator-qa",
    new PhysicalDrawWitnessEvidence(
        "operator-qa",
        "primary-witness-qa",
        SecondaryWitness: null,
        RegulatorWitness: null,
        DigitalApprovalReferences: ["approval:qa"],
        ManualCertificationReferences: ["manual-cert:qa"]),
    [
        new PhysicalDrawEquipmentReference(
            "machine-alpha",
            "DRAW_MACHINE",
            "machine-v1",
            PhysicalDrawEquipmentLifecycleState.Active,
            "inspection:qa",
            "maintenance:qa",
            "calibration:qa",
            "seal:qa",
            Approved: true),
        new PhysicalDrawEquipmentReference(
            "ball-set-alpha",
            "BALL_SET",
            "balls-v1",
            PhysicalDrawEquipmentLifecycleState.Active,
            "inspection:balls",
            "maintenance:balls",
            "calibration:balls",
            "seal:balls",
            Approved: true)
    ],
    ["media:qa"],
    VideoHash: PhysicalDrawResultRuntimeService.HashCanonical("video:qa"),
    ImageHash: PhysicalDrawResultRuntimeService.HashCanonical("image:qa"),
    "official-report:qa",
    PhysicalDrawResultRuntimeService.HashCanonical("procedure:qa"),
    PhysicalDrawResultRuntimeService.HashCanonical("event:qa"));
var physicalRequest = RuntimeRequest(
    "physical-draw-idempotency",
    "physical-draw-001",
    physicalProvider.ProviderId,
    physicalProvider.ProviderVersion,
    OutcomeProviderType.PhysicalDrawResult,
    canonicalHash: PhysicalDrawResultRuntimeService.HashCanonical("physical-draw-request-001")) with
{
    GameManifestId = "manifest-physical",
    GameManifestVersion = "1.0.0",
    PhysicalDrawResult = physicalEnvelope
};
var physicalAuthorityRepository = new InMemoryPhysicalDrawAuthorityRepository();
physicalAuthorityRepository.Add(physicalAuthority);
var physicalEvidenceRepository = new InMemoryPhysicalDrawEvidenceRepository();
var physicalRuntimeService = new PhysicalDrawResultRuntimeService(physicalAuthorityRepository, physicalEvidenceRepository);
var normalizedPhysical = PhysicalDrawResultRuntimeService.Normalize(physicalEnvelope);
var normalizedPhysicalAgain = PhysicalDrawResultRuntimeService.Normalize(physicalEnvelope with
{
    ResultPayload = new Dictionary<string, object?> { ["numbers"] = new[] { 5, 7, 11, 3, 19 } }
});
if (normalizedPhysical.CanonicalPayloadHash != normalizedPhysicalAgain.CanonicalPayloadHash)
{
    throw new InvalidOperationException("Physical Draw unique number set normalization must be deterministic.");
}

var physicalContext = new OutcomeProviderRuntimeContext(physicalRequest, physicalProvider);
var ingestedPhysical = await physicalRuntimeService.IngestAsync(physicalContext, CancellationToken.None);
if (ingestedPhysical.Evidence.Status != PhysicalDrawVerificationStatus.Verified ||
    ingestedPhysical.OutcomeCertificate.CanonicalOutcomeHash != normalizedPhysical.CanonicalPayloadHash)
{
    throw new InvalidOperationException("Physical Draw runtime must verify, normalize, and certify dry-run evidence.");
}

AssertThrows(
    () => physicalRuntimeService.IngestAsync(
        new OutcomeProviderRuntimeContext(
            physicalRequest with
            {
                RuntimeRequestId = Guid.NewGuid(),
                IdempotencyKey = "physical-draw-missing-witness",
                PhysicalDrawResult = physicalEnvelope with
                {
                    DrawEventId = Guid.NewGuid(),
                    IdempotencyKey = "physical-draw-missing-witness",
                    WitnessEvidence = physicalEnvelope.WitnessEvidence with { PrimaryWitness = null }
                }
            },
            physicalProvider),
        CancellationToken.None).GetAwaiter().GetResult(),
    "Physical Draw missing required witness must fail closed.");

AssertThrows(
    () => physicalRuntimeService.IngestAsync(
        new OutcomeProviderRuntimeContext(
            physicalRequest with
            {
                RuntimeRequestId = Guid.NewGuid(),
                IdempotencyKey = "physical-draw-retired-equipment",
                PhysicalDrawResult = physicalEnvelope with
                {
                    DrawEventId = Guid.NewGuid(),
                    IdempotencyKey = "physical-draw-retired-equipment",
                    EquipmentReferences =
                    [
                        physicalEnvelope.EquipmentReferences.First() with
                        {
                            LifecycleState = PhysicalDrawEquipmentLifecycleState.Retired
                        }
                    ]
                }
            },
            physicalProvider),
        CancellationToken.None).GetAwaiter().GetResult(),
    "Physical Draw retired equipment must fail closed.");

var physicalRuntime = new PhysicalDrawResultOutcomeProviderRuntime(physicalRuntimeService);
var physicalOrchestrator = new OutcomeProviderOrchestrationService(
    runtimeResolver,
    new InMemoryOutcomeRuntimeRequestRepository(),
    new InMemoryOutcomeRuntimeLockManager(),
    [physicalRuntime]);
var orchestratedPhysical = await physicalOrchestrator.ExecuteAsync(
    physicalRequest,
    [physicalProvider],
    CancellationToken.None);
if (orchestratedPhysical.Status != OutcomeRuntimeStatus.Accepted ||
    orchestratedPhysical.EvidenceReference is null ||
    !orchestratedPhysical.EvidenceReference.StartsWith("placeholder:physical-draw-result:", StringComparison.Ordinal))
{
    throw new InvalidOperationException("Physical Draw runtime must accept dry-run ingestion and return an evidence reference.");
}

var duplicatePhysical = await physicalOrchestrator.ExecuteAsync(
    physicalRequest,
    [physicalProvider],
    CancellationToken.None);
if (duplicatePhysical.Status != OutcomeRuntimeStatus.DuplicateReturned ||
    duplicatePhysical.EvidenceReference != orchestratedPhysical.EvidenceReference)
{
    throw new InvalidOperationException("Physical Draw duplicate idempotent request must return the same evidence reference.");
}

var conflictPhysical = await physicalRuntime.CreateOutcomeAsync(
    new OutcomeProviderRuntimeContext(
        physicalRequest with
        {
            RuntimeRequestId = Guid.NewGuid(),
            IdempotencyKey = "physical-draw-conflict",
            CanonicalRequestHash = PhysicalDrawResultRuntimeService.HashCanonical("physical-draw-conflict"),
            PhysicalDrawResult = physicalEnvelope with
            {
                DrawEventId = Guid.NewGuid(),
                IdempotencyKey = "physical-draw-conflict",
                ContentHash = PhysicalDrawResultRuntimeService.HashCanonical("event:qa:conflict"),
                ResultPayload = new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } }
            }
        },
        physicalProvider),
    CancellationToken.None);
if (conflictPhysical.Status != OutcomeRuntimeStatus.FailedClosed ||
    conflictPhysical.FailureCode != OutcomeRuntimeFailureCode.PhysicalDrawConflict)
{
    throw new InvalidOperationException("Conflicting Physical Draw result must fail closed and require supersession.");
}

var productionPhysical = await physicalRuntime.CreateOutcomeAsync(
    new OutcomeProviderRuntimeContext(
        physicalRequest with { Mode = OutcomeRuntimeExecutionMode.Production },
        physicalProvider),
    CancellationToken.None);
if (productionPhysical.Status != OutcomeRuntimeStatus.ProductionDisabled)
{
    throw new InvalidOperationException("Physical Draw runtime must reject production mode.");
}

var outcomeValidationService = new OutcomeValidationFrameworkService();
var validationProvenance = new ValidationSupplyChainProvenance(
    "qa-git-sha",
    "0.0.0-qa",
    "qa-build",
    "sha256:qa-image",
    Environment.Version.ToString(),
    "sha256:qa-implementation",
    "sha256:qa-configuration");
var conformanceReport = outcomeValidationService.EvaluateCryptographicConformance(
    CryptographicConformanceSubjectType.CertifiedCsprng,
    "certified-csprng:qa",
    "1.0.0",
    "sha256:qa-csprng",
    Enum.GetValues<CryptographicConformanceCheckType>(),
    new Dictionary<string, object?> { ["kat"] = "passed" },
    new Dictionary<string, object?>
    {
        ["healthTestsPassed"] = true,
        ["knownAnswerTestsPassed"] = true,
        ["continuousTestsPassed"] = true,
        ["algorithmVersionCompatible"] = true
    },
    validationProvenance);
if (conformanceReport.Status != ValidationEvaluationStatus.Pass ||
    !conformanceReport.CanonicalReportHash.StartsWith("sha256:", StringComparison.Ordinal))
{
    throw new InvalidOperationException("Cryptographic conformance report must pass with complete CSPRNG checks.");
}

var failedConformanceReport = outcomeValidationService.EvaluateCryptographicConformance(
    CryptographicConformanceSubjectType.CertifiedCsprng,
    "certified-csprng:qa:failed",
    "1.0.0",
    "sha256:qa-csprng-failed",
    [CryptographicConformanceCheckType.KnownAnswerTests],
    new Dictionary<string, object?> { ["kat"] = "missing lifecycle checks" },
    new Dictionary<string, object?> { ["knownAnswerTestsPassed"] = false },
    validationProvenance);
if (failedConformanceReport.Status != ValidationEvaluationStatus.Fail ||
    failedConformanceReport.Blockers.Count == 0)
{
    throw new InvalidOperationException("Incomplete cryptographic conformance must fail with blockers.");
}

var statisticalReport = outcomeValidationService.EvaluateFrequency(
    ProviderValidationSubjectType.OutcomeProvider,
    "outcome-provider:qa",
    "1.0.0",
    "sha256:qa-outcome-provider",
    "manifest:qa",
    "1.0.0",
    "internal-suite-v1",
    new Dictionary<string, long> { ["A"] = 5000, ["B"] = 5000 },
    new Dictionary<string, decimal> { ["A"] = 0.5m, ["B"] = 0.5m },
    10000,
    validationProvenance);
if (statisticalReport.Status != ValidationEvaluationStatus.Pass ||
    statisticalReport.SuiteType != StatisticalValidationSuiteType.Frequency)
{
    throw new InvalidOperationException("Frequency statistical validation must pass for balanced samples.");
}

var registryEntry = outcomeValidationService.CreateRegistryEntry(
    ProviderValidationSubjectType.OutcomeProvider,
    "outcome-provider:qa",
    "1.0.0",
    "validation-v1",
    "sha256:qa-implementation",
    "sha256:qa-configuration",
    ValidationEvaluationStatus.Pass,
    "qa-operator",
    [conformanceReport.CanonicalReportHash, statisticalReport.CanonicalReportHash]);
if (registryEntry.EvidenceHashes.Count != 2 ||
    !registryEntry.CanonicalRegistryHash.StartsWith("sha256:", StringComparison.Ordinal))
{
    throw new InvalidOperationException("Provider validation registry entry must preserve evidence hashes.");
}

var readiness = outcomeValidationService.EvaluateReadiness(
    ProviderValidationSubjectType.OutcomeProvider,
    "outcome-provider:qa",
    "1.0.0",
    providerApproved: true,
    guardrailsPassed: true,
    cryptographicConformancePassed: true,
    statisticalValidationPassed: true,
    requiredEvidenceComplete: true,
    providerHealthPassed: true,
    runtimeReadinessPassed: true,
    outcomeAuthorityDisabled: true,
    [conformanceReport.CanonicalReportHash, statisticalReport.CanonicalReportHash, registryEntry.CanonicalRegistryHash],
    validationProvenance);
if (readiness.Status != CertificationReadinessStatus.ProductionEligible ||
    readiness.Blockers.Count > 0)
{
    throw new InvalidOperationException("Full synthetic readiness should produce production eligibility evidence without activation.");
}

var notReady = outcomeValidationService.EvaluateReadiness(
    ProviderValidationSubjectType.OutcomeProvider,
    "outcome-provider:qa:not-ready",
    "1.0.0",
    providerApproved: true,
    guardrailsPassed: true,
    cryptographicConformancePassed: false,
    statisticalValidationPassed: true,
    requiredEvidenceComplete: true,
    providerHealthPassed: true,
    runtimeReadinessPassed: true,
    outcomeAuthorityDisabled: true,
    [statisticalReport.CanonicalReportHash],
    validationProvenance);
if (notReady.Status == CertificationReadinessStatus.ProductionEligible ||
    !notReady.Blockers.Contains("Cryptographic conformance must pass."))
{
    throw new InvalidOperationException("Production eligibility must require independent cryptographic conformance.");
}

var hardeningService = new OutcomeAuthorityHardeningService();
var vectorSuite = hardeningService.RunHmacDrbgConformanceVectors("application-tests-build");
if (!vectorSuite.Passed ||
    vectorSuite.VectorResults.Count != 3 ||
    !vectorSuite.CanonicalResultHash.StartsWith("sha256:", StringComparison.Ordinal))
{
    throw new InvalidOperationException("Official HMAC-DRBG conformance vectors must pass for SHA-256, SHA-384, and SHA-512.");
}

var tamperedVector = OutcomeAuthorityHardeningService.OfficialHmacDrbgConformanceVectors()
    .Select(vector => vector.HashAlgorithm == CertifiedCsprngHashAlgorithm.Sha256
        ? vector with { ExpectedFirstGenerateHex = vector.ExpectedFirstGenerateHex.Replace('8', '9') }
        : vector)
    .ToArray();
var tamperedSuite = hardeningService.RunHmacDrbgConformanceVectors("application-tests-build", tamperedVector);
if (tamperedSuite.Passed ||
    tamperedSuite.VectorResults.Single(result => result.HashAlgorithm == CertifiedCsprngHashAlgorithm.Sha256).Passed)
{
    throw new InvalidOperationException("Modified HMAC-DRBG vector must fail conformance.");
}

var entropyConfig = new EntropyProviderDeploymentConfiguration(
    "entropy:qa",
    "1.0.0",
    EntropyProviderType.OsCsprng,
    OsEntropyPlatform.Linux,
    Approved: true,
    ProductionEligible: true,
    CertifiedCsprngFailureMode.FailClosed,
    "sha256:entropy-config");
var entropyReady = hardeningService.ValidateEntropyProviderConfiguration(
    [entropyConfig],
    new ConfiguredEntropyProvider(OsEntropyPlatform.Linux));
if (!entropyReady.Ready)
{
    throw new InvalidOperationException("Exactly one matching approved entropy provider should be ready.");
}

var entropyMismatch = hardeningService.ValidateEntropyProviderConfiguration(
    [entropyConfig],
    new ConfiguredEntropyProvider(OsEntropyPlatform.MacOS));
if (entropyMismatch.Ready ||
    !entropyMismatch.Blockers.Any(blocker => blocker.Contains("does not match", StringComparison.OrdinalIgnoreCase)))
{
    throw new InvalidOperationException("Entropy provider OS mismatch must fail closed.");
}

var legacyIsolation = hardeningService.EvaluateLegacyRandomnessIsolation(
    [
        new LegacyRandomnessIsolationEvidence(
            "services/game-engine/src/GameEngine.Application/Services/OutcomeDryRunPipeline.cs",
            LegacyRandomnessUsageMode.DryRunOnly,
            ProductionEligible: true,
            RegisteredForCertifiedCsprngRuntime: true,
            [])
    ]).Single();
if (legacyIsolation.ProductionEligible ||
    legacyIsolation.RegisteredForCertifiedCsprngRuntime ||
    legacyIsolation.Blockers.Count != 2)
{
    throw new InvalidOperationException("Legacy/test randomness must be isolated from production CSPRNG ownership.");
}

var readinessReport = hardeningService.CreateReadinessReport(
    [
        ReadySection("provider readiness"),
        ReadySection("entropy readiness"),
        ReadySection("DRBG conformance"),
        ReadySection("statistical validation"),
        ReadySection("runtime persistence"),
        ReadySection("advisory locking"),
        ReadySection("recovery/provenance"),
        new OutcomeAuthorityReadinessSection(
            "seed custody status",
            OutcomeAuthorityReadinessSectionStatus.Blocked,
            ["placeholder:seed-custody-abstraction"],
            ["Production seed custody remains unavailable."]),
        new OutcomeAuthorityReadinessSection(
            "signing custody status",
            OutcomeAuthorityReadinessSectionStatus.Blocked,
            ["placeholder:signing-custody-abstraction"],
            ["Production signing custody remains unavailable."]),
        ReadySection("external suite evidence status"),
        ReadySection("production activation status")
    ],
    productionAuthorityEnabled: false);
if (readinessReport.Blockers.Count != 2 ||
    readinessReport.ProductionAuthorityEnabled ||
    !readinessReport.ProductionEligibleEvidenceOnly)
{
    throw new InvalidOperationException("Unified readiness report must derive custody blockers without enabling authority.");
}

var missingReadiness = hardeningService.CreateReadinessReport([ReadySection("provider readiness")], productionAuthorityEnabled: false);
if (!missingReadiness.Blockers.Any(blocker => blocker.Contains("Missing readiness evidence", StringComparison.Ordinal)))
{
    throw new InvalidOperationException("Missing readiness evidence must fail closed.");
}

var lockScopeA = hardeningService.DeriveAdvisoryLockScope(
    "request",
    "CertifiedCsprng:provider:1.0.0",
    "draw:100",
    TimeSpan.FromSeconds(5));
var lockScopeB = hardeningService.DeriveAdvisoryLockScope(
    "certificate",
    "CertifiedCsprng:provider:1.0.0",
    "draw:100",
    TimeSpan.FromSeconds(5));
var lockScopeARepeat = hardeningService.DeriveAdvisoryLockScope(
    "request",
    "CertifiedCsprng:provider:1.0.0",
    "draw:100",
    TimeSpan.FromSeconds(5));
if (lockScopeA.DerivedLockScope != lockScopeARepeat.DerivedLockScope ||
    lockScopeA.DerivedLockScope == lockScopeB.DerivedLockScope ||
    !lockScopeA.RedisDependencyAbsent)
{
    throw new InvalidOperationException("Advisory lock derivation must be deterministic and namespace-separated without Redis.");
}

var previousWatermark = new OutcomeRuntimeRollbackWatermark(
    Guid.NewGuid(),
    "outcome-runtime",
    10,
    "sha256:previous",
    "sha256:chain-a",
    Guid.NewGuid(),
    null,
    ["sha256:evidence-a"],
    DateTimeOffset.UtcNow);
var acceptedWatermark = new OutcomeRuntimeRollbackWatermark(
    Guid.NewGuid(),
    "outcome-runtime",
    11,
    previousWatermark.ChainRootHash,
    "sha256:chain-b",
    Guid.NewGuid(),
    null,
    ["sha256:evidence-b"],
    DateTimeOffset.UtcNow);
if (hardeningService.EvaluateRollbackWatermark(previousWatermark, acceptedWatermark).Status != OutcomeAuthorityRollbackWatermarkStatus.Accepted)
{
    throw new InvalidOperationException("Monotonic rollback watermark should be accepted.");
}

var regressedWatermark = acceptedWatermark with { SequenceNumber = 9 };
if (hardeningService.EvaluateRollbackWatermark(previousWatermark, regressedWatermark).Status != OutcomeAuthorityRollbackWatermarkStatus.RegressionDetected)
{
    throw new InvalidOperationException("Rollback watermark sequence regression must fail closed.");
}

var externalStatisticalEvidence = hardeningService.ImportExternalStatisticalEvidence(
    new ExternalStatisticalEvidenceImportRequest(
        StatisticalValidationSuiteType.ExternalImported,
        ProviderValidationSubjectType.CertifiedCsprng,
        "certified-csprng:qa",
        "1.0.0",
        "sha256:qa-csprng",
        "NIST SP 800-22",
        "external-report-v1",
        "application-tests-build",
        new Dictionary<string, object?> { ["suiteProfile"] = "qa-import" },
        100000,
        "sha256:external-report",
        ValidationEvaluationStatus.Pass,
        "qa-operator",
        [],
        validationProvenance));
if (externalStatisticalEvidence.Status != ValidationEvaluationStatus.Pass ||
    externalStatisticalEvidence.SuiteType != StatisticalValidationSuiteType.ExternalImported ||
    externalStatisticalEvidence.Configuration["runtimeSuiteBundled"] is not false)
{
    throw new InvalidOperationException("External statistical evidence import must be immutable metadata, not runtime suite execution.");
}

var restartHarnessPlan = hardeningService.CreateProcessRestartRecoveryHarnessPlan();
if (!restartHarnessPlan.RequiresContainerKillApproval ||
    !restartHarnessPlan.ProductionAuthorityDisabled ||
    !restartHarnessPlan.SupportedCheckpoints.Contains(OutcomeRuntimeCrashInjectionStage.LockAcquisition))
{
    throw new InvalidOperationException("Process restart harness plan must cover lock/idempotency recovery without enabling production authority.");
}

RunMathEvaluatorContractTests();
RunKenoMathEvaluatorTests();
RunMathCertificateEvaluationTests();
await RunDurableMathEvaluationTests();
await RunMathEvaluationBatchTests();
await RunSettlementInputAdapterTests();

Console.WriteLine("GameEngine.Application.Tests PASS");

static void RunMathEvaluatorContractTests()
{
    var registry = new MathEvaluatorRegistry([new KenoMathEvaluator()]);
    var evaluator = registry.Resolve(nameof(GameType.Keno), nameof(WagerType.KenoSpot));
    if (evaluator.GameFamily != nameof(GameType.Keno) ||
        !evaluator.SupportedWagerSchemas.Contains(nameof(WagerType.KenoBullseye)))
    {
        throw new InvalidOperationException("Math evaluator registry must resolve the Keno evaluator deterministically.");
    }

    AssertThrows(
        () => registry.Resolve(nameof(GameType.HotSpot), nameof(WagerType.Straight)),
        "Hot Spot must fail explicitly instead of using a fabricated deterministic loss.");

    AssertThrows(
        () => registry.Resolve(nameof(GameType.Keno), nameof(WagerType.Straight)),
        "Math evaluator registry must not provide a silent fallback evaluator.");
}

static void RunKenoMathEvaluatorTests()
{
    var evaluator = new KenoMathEvaluator();
    var manifest = MathEvalManifest();
    var mathModel = MathEvalModel();
    var paytable = MathEvalPaytable(mathModel);
    var outcomePayload = MathEvalOutcomePayload([1, 2, 3, 4, 5, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39], bullseye: 1);
    var outcome = MathEvalOutcomeCertificate(outcomePayload);

    AssertKenoPrize(
        evaluator,
        manifest,
        mathModel,
        paytable,
        outcome,
        outcomePayload,
        nameof(WagerType.KenoSpot),
        new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } },
        "KENO_SPOT_5",
        5);

    AssertKenoPrize(
        evaluator,
        manifest,
        mathModel,
        paytable,
        outcome,
        outcomePayload,
        nameof(WagerType.KenoBullseye),
        new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3 }, ["bullseye"] = 1 },
        "KENO_BULLSEYE",
        3);

    AssertKenoPrize(
        evaluator,
        manifest,
        mathModel,
        paytable,
        outcome,
        outcomePayload,
        nameof(WagerType.KenoBigSmall),
        new Dictionary<string, object?> { ["numbers"] = new[] { 1 }, ["selection"] = "SMALL" },
        "KENO_BIG_SMALL",
        1);

    AssertKenoPrize(
        evaluator,
        manifest,
        mathModel,
        paytable,
        outcome,
        outcomePayload,
        nameof(WagerType.KenoOddEven),
        new Dictionary<string, object?> { ["numbers"] = new[] { 1 }, ["selection"] = "ODD" },
        "KENO_ODD_EVEN",
        1);

    AssertKenoPrize(
        evaluator,
        manifest,
        mathModel,
        paytable,
        outcome,
        outcomePayload,
        nameof(WagerType.KenoUpDown),
        new Dictionary<string, object?> { ["numbers"] = new[] { 1 }, ["selection"] = "DOWN" },
        "KENO_UP_DOWN",
        1);

    AssertKenoPrize(
        evaluator,
        manifest,
        mathModel,
        paytable,
        outcome,
        outcomePayload,
        nameof(WagerType.KenoDragonTiger),
        new Dictionary<string, object?> { ["numbers"] = new[] { 1 }, ["selection"] = "TIGER" },
        "KENO_DRAGON_TIGER",
        1);

    AssertKenoPrize(
        evaluator,
        manifest,
        mathModel,
        paytable,
        outcome,
        outcomePayload,
        nameof(WagerType.KenoSumOverUnder),
        new Dictionary<string, object?> { ["numbers"] = new[] { 1 }, ["selection"] = "UNDER" },
        "KENO_SUM_OVER_UNDER",
        1);

    AssertKenoPrize(
        evaluator,
        manifest,
        mathModel,
        paytable,
        outcome,
        outcomePayload,
        nameof(WagerType.KenoElement),
        new Dictionary<string, object?> { ["numbers"] = new[] { 1 }, ["selection"] = "EARTH" },
        "KENO_ELEMENT",
        1);

    var first = evaluator.Evaluate(new MathEvaluatorRequest(
        manifest,
        outcome,
        mathModel,
        paytable,
        "ticket:deterministic",
        nameof(WagerType.KenoSpot),
        new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } },
        outcomePayload));
    var second = evaluator.Evaluate(new MathEvaluatorRequest(
        manifest,
        outcome,
        mathModel,
        paytable,
        "ticket:deterministic",
        nameof(WagerType.KenoSpot),
        new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } },
        outcomePayload));
    if (first.CanonicalPrizeFactsHash != second.CanonicalPrizeFactsHash ||
        first.CanonicalPrizeFactsJson != second.CanonicalPrizeFactsJson)
    {
        throw new InvalidOperationException("Repeated Keno math evaluation must produce deterministic PrizeFacts and hash.");
    }

    var mismatchedModel = mathModel with { Version = "2.0.0" };
    if (evaluator.ValidateCompatibility(new MathEvaluatorCompatibility(manifest, mismatchedModel, paytable, nameof(WagerType.KenoSpot))).IsValid)
    {
        throw new InvalidOperationException("Keno evaluator must reject mismatched Math Model / Paytable versions.");
    }
}

static void RunMathCertificateEvaluationTests()
{
    var registry = new MathEvaluatorRegistry([new KenoMathEvaluator()]);
    var service = new MathCertificateEvaluationService(registry);
    var manifest = MathEvalManifest();
    var mathModel = MathEvalModel();
    var paytable = MathEvalPaytable(mathModel);
    var outcomePayload = MathEvalOutcomePayload([1, 2, 3, 4, 5, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39], bullseye: 1);
    var outcome = MathEvalOutcomeCertificate(outcomePayload);
    var request = new MathCertificateEvaluationRequest(
        Guid.NewGuid(),
        "math-certificate-evaluation:keno:1",
        MathEvaluationMode.DryRun,
        manifest,
        outcome,
        mathModel,
        paytable,
        "ticket:math-certificate:1",
        nameof(WagerType.KenoSpot),
        new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } },
        outcomePayload);

    var first = service.Evaluate(request);
    var second = service.Evaluate(request);
    if (first.CanonicalPrizeFactsHash != second.CanonicalPrizeFactsHash ||
        first.Certificate.EvaluatorVersion != "keno-math-evaluator-1" ||
        first.Certificate.GameManifestHash != manifest.ContentHash ||
        first.PrizeFacts.Outcome != PrizeOutcome.Win ||
        first.PrizeFacts.OutcomeDerivedFacts.ContainsKey("ledgerEntryId") ||
        first.PrizeFacts.OutcomeDerivedFacts.ContainsKey("walletTransactionId") ||
        first.PrizeFacts.OutcomeDerivedFacts.ContainsKey("commission") ||
        first.PrizeFacts.OutcomeDerivedFacts.ContainsKey("tax") ||
        first.PrizeFacts.OutcomeDerivedFacts.ContainsKey("cashierReference"))
    {
        throw new InvalidOperationException("Math Certificate evaluation must produce deterministic certificate-ready PrizeFacts without financial side effects.");
    }

    var mismatchedOutcome = outcome with { CanonicalOutcomeHash = "sha256:mismatched" };
    AssertThrows(
        () => service.Evaluate(request with { OutcomeCertificate = mismatchedOutcome, IdempotencyKey = "math-certificate-evaluation:mismatch" }),
        "Math Certificate evaluation must reject mismatched Outcome Certificate hashes.");

    var badManifest = manifest with { MathModelReferences = ["math-model:other:1.0.0"] };
    AssertThrows(
        () => service.Evaluate(request with { Manifest = badManifest, IdempotencyKey = "math-certificate-evaluation:manifest-mismatch" }),
        "Math Certificate evaluation must reject stale or mismatched manifest Math Model references.");

    AssertThrows(
        () => service.Evaluate(request with { Mode = MathEvaluationMode.ProductionDisabled, IdempotencyKey = "math-certificate-evaluation:production-disabled" }),
        "Production Math Authority mode must remain disabled.");
}

static async Task RunDurableMathEvaluationTests()
{
    var repository = new InMemoryMathEvaluationDurableRepository();
    var registry = new MathEvaluatorRegistry([new KenoMathEvaluator()]);
    var service = new DurableMathEvaluationService(
        registry,
        new MathCertificateEvaluationService(registry),
        repository);
    var request = DurableMathEvalRequest(
        "math-evaluation-durable:1",
        "ticket:durable:1",
        new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } });

    var first = await service.EvaluateAsync(request, CancellationToken.None);
    if (first.PrizeFacts.Outcome != PrizeOutcome.Win ||
        first.Certificate.CertificateId == Guid.Empty ||
        repository.Requests.Single().Status != DurableMathEvaluationStatus.Completed)
    {
        throw new InvalidOperationException("First durable Math Evaluation must persist a completed request and certificate.");
    }

    var attemptsAfterFirst = repository.Attempts.Count;
    var duplicate = await service.EvaluateAsync(request with { RequestId = Guid.NewGuid() }, CancellationToken.None);
    if (duplicate.Certificate.CertificateId != first.Certificate.CertificateId ||
        duplicate.MathEvaluationId != first.MathEvaluationId ||
        repository.Attempts.Count != attemptsAfterFirst)
    {
        throw new InvalidOperationException("Duplicate Math Evaluation payload must return existing certificate without recomputation.");
    }

    AssertThrows(
        () => service.EvaluateAsync(
            request with
            {
                RequestId = Guid.NewGuid(),
                WagerPayload = new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4 } }
            },
            CancellationToken.None).GetAwaiter().GetResult(),
        "Conflicting duplicate Math Evaluation payload must fail closed.");

    AssertThrows(
        () => service.EvaluateAsync(
            DurableMathEvalRequest(
                "math-evaluation-durable:evaluator-mismatch",
                "ticket:durable:evaluator-mismatch",
                new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3 } },
                wagerSchema: nameof(WagerType.Straight)),
            CancellationToken.None).GetAwaiter().GetResult(),
        "Unsupported evaluator/wager mismatch must be rejected.");

    var badOutcome = request.OutcomeCertificate with { CanonicalOutcomeHash = "sha256:mismatch" };
    AssertThrows(
        () => service.EvaluateAsync(
            request with
            {
                RequestId = Guid.NewGuid(),
                IdempotencyKey = "math-evaluation-durable:outcome-mismatch",
                OutcomeCertificate = badOutcome
            },
            CancellationToken.None).GetAwaiter().GetResult(),
        "Outcome Certificate hash mismatch must be rejected.");

    var retryRepository = new InMemoryMathEvaluationDurableRepository();
    var retryService = new DurableMathEvaluationService(
        registry,
        new MathCertificateEvaluationService(registry),
        retryRepository);
    var retryRequest = DurableMathEvalRequest(
        "math-evaluation-durable:retry",
        "ticket:durable:retry",
        new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } });
    var evaluator = registry.Resolve(retryRequest.Manifest.GameFamily, retryRequest.WagerSchema);
    var preclaimed = DurableMathEvaluationService.BuildDurableRequest(retryRequest, evaluator);
    await retryRepository.ClaimRequestAsync(preclaimed, CancellationToken.None);
    await retryRepository.AppendAttemptAsync(
        preclaimed.EvaluationRequestId,
        MathEvaluationAttemptStatus.Started,
        null,
        null,
        DurableMathEvaluationService.HashCanonical("incomplete-attempt"),
        DateTimeOffset.UtcNow,
        null,
        CancellationToken.None);
    var retried = await retryService.EvaluateAsync(retryRequest, CancellationToken.None);
    if (retried.Certificate.CertificateId == Guid.Empty ||
        retryRepository.Attempts.Count(attempt => attempt.EvaluationRequestId == preclaimed.EvaluationRequestId) != 3)
    {
        throw new InvalidOperationException("Incomplete Math Evaluation attempts must retry as new append-only attempts.");
    }

    var replay = await service.ReplayAsync(request, CancellationToken.None);
    if (!replay.Verified ||
        replay.OriginalPrizeFactsHash != first.CanonicalPrizeFactsHash ||
        repository.Attempts.Last().Status != MathEvaluationAttemptStatus.ReplayVerified)
    {
        throw new InvalidOperationException("Math Evaluation replay must reproduce the original PrizeFacts hash.");
    }

    var mutatedPaytable = MathEvalPaytable(MathEvalModel()) with
    {
        PrizeMatrixRows =
        [
            new PrizeMatrixRow(
                "keno-spot-5",
                nameof(WagerType.KenoSpot),
                "KENO_SPOT_5",
                0m,
                49m,
                10000m,
                new Dictionary<string, object?> { ["spotCount"] = 5, ["hitCount"] = 5 })
        ]
    };
    AssertThrows(
        () => service.ReplayAsync(request with { Paytable = mutatedPaytable }, CancellationToken.None).GetAwaiter().GetResult(),
        "Replay mismatch must fail closed and record mismatch evidence.");

    if (repository.Attempts.Last().Status != MathEvaluationAttemptStatus.ReplayMismatch)
    {
        throw new InvalidOperationException("Replay mismatch must append replay mismatch evidence.");
    }

    var ticketMatches = await repository.FindByTicketReferenceAsync("ticket:durable:1", CancellationToken.None);
    var outcomeMatches = await repository.FindByOutcomeCertificateAsync(
        first.Certificate.OutcomeCertificateId,
        first.Certificate.OutcomeCertificateHash,
        CancellationToken.None);
    var certificateMatch = await repository.FindByCertificateHashAsync(first.CanonicalPrizeFactsHash, CancellationToken.None);
    if (ticketMatches.Count != 1 ||
        outcomeMatches.Count != 1 ||
        certificateMatch?.CertificateId != first.Certificate.CertificateId)
    {
        throw new InvalidOperationException("Durable Math Evaluation lookup indexes must support ticket, outcome certificate, and certificate hash lookups.");
    }

    if (first.CanonicalPrizeFactsJson.Contains("ledger", StringComparison.OrdinalIgnoreCase) ||
        first.CanonicalPrizeFactsJson.Contains("wallet", StringComparison.OrdinalIgnoreCase) ||
        first.CanonicalPrizeFactsJson.Contains("tax", StringComparison.OrdinalIgnoreCase) ||
        first.CanonicalPrizeFactsJson.Contains("commission", StringComparison.OrdinalIgnoreCase) ||
        first.CanonicalPrizeFactsJson.Contains("cashier", StringComparison.OrdinalIgnoreCase) ||
        first.CanonicalPrizeFactsJson.Contains("rng", StringComparison.OrdinalIgnoreCase) ||
        first.CanonicalPrizeFactsJson.Contains("entropy", StringComparison.OrdinalIgnoreCase))
    {
        throw new InvalidOperationException("Math Evaluation PrizeFacts must not contain financial or randomness side effects.");
    }

    var readiness = await repository.CheckReadinessAsync(CancellationToken.None);
    if (!readiness.IdempotencyConfigured ||
        !readiness.ReplayVerificationReady ||
        !readiness.ProductionActivationDisabled ||
        readiness.DurableRepositoryConfigured)
    {
        throw new InvalidOperationException("In-memory Math Evaluation repository readiness must remain explicit non-production fallback.");
    }
}

static async Task RunMathEvaluationBatchTests()
{
    var registry = new MathEvaluatorRegistry([new KenoMathEvaluator()]);
    var durableRepository = new InMemoryMathEvaluationDurableRepository();
    var durableService = new DurableMathEvaluationService(
        registry,
        new MathCertificateEvaluationService(registry),
        durableRepository);
    var batchRepository = new InMemoryMathEvaluationBatchRepository();
    var batchService = new MathEvaluationBatchService(registry, durableService, batchRepository);
    var batchRequest = DurableMathEvalBatchRequest(
        "math-evaluation-batch:1",
        [
            ("ticket:batch:1", "math-evaluation-batch:item:1", new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } }),
            ("ticket:batch:2", "math-evaluation-batch:item:2", new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3 } }),
            ("ticket:batch:3", "math-evaluation-batch:item:3", new Dictionary<string, object?> { ["numbers"] = new[] { 11, 13, 15 } })
        ],
        maxDegreeOfParallelism: 2);

    var result = await batchService.ExecuteAsync(batchRequest, CancellationToken.None);
    if (result.Batch.Status != MathEvaluationBatchStatus.Completed ||
        result.Items.Count != 3 ||
        result.Items.Any(item => item.EvaluationStatus != MathEvaluationBatchItemStatus.Completed) ||
        result.Items.Select(item => item.CertificateId).Distinct().Count() != 3)
    {
        throw new InvalidOperationException("Valid Math Evaluation batch must complete multiple Keno items with one certificate per item.");
    }

    var sharedScopeInvalid = result.Items.Any(item =>
        item.CertificateHash is null ||
        item.EvaluationRequestId is null ||
        batchRepository.Batches.Single().OutcomeCertificateId != batchRequest.OutcomeCertificate.CertificateId ||
        batchRepository.Batches.Single().MathModelVersion != batchRequest.MathModel.Version ||
        batchRepository.Batches.Single().PaytableVersion != batchRequest.Paytable.Version);
    if (sharedScopeInvalid)
    {
        throw new InvalidOperationException("Math Evaluation batch items must use one Outcome Certificate and immutable version set.");
    }

    var attemptsAfterFirst = batchRepository.Attempts.Count;
    var duplicate = await batchService.ExecuteAsync(batchRequest with { BatchId = Guid.NewGuid() }, CancellationToken.None);
    if (duplicate.Batch.BatchId != result.Batch.BatchId ||
        batchRepository.Attempts.Count != attemptsAfterFirst)
    {
        throw new InvalidOperationException("Duplicate completed Math Evaluation batch must return existing state without recomputing items.");
    }

    AssertThrows(
        () => batchService.ExecuteAsync(
            batchRequest with
            {
                BatchId = Guid.NewGuid(),
                OutcomeCertificate = batchRequest.OutcomeCertificate with { CanonicalOutcomeHash = "sha256:mixed-outcome" }
            },
            CancellationToken.None).GetAwaiter().GetResult(),
        "Mixed Outcome Certificate for the same Math Evaluation batch idempotency key must fail closed.");

    AssertThrows(
        () => batchService.ExecuteAsync(
            batchRequest with
            {
                BatchId = Guid.NewGuid(),
                MathModel = batchRequest.MathModel with { Version = "2.0.0" }
            },
            CancellationToken.None).GetAwaiter().GetResult(),
        "Mixed Math Model version for the same Math Evaluation batch idempotency key must fail closed.");

    var itemConflictRequest = DurableMathEvalBatchRequest(
        "math-evaluation-batch:conflicting-item",
        [("ticket:batch:1", "math-evaluation-batch:item:1", new Dictionary<string, object?> { ["numbers"] = new[] { 1 } })]);
    AssertThrows(
        () => batchService.ExecuteAsync(itemConflictRequest, CancellationToken.None).GetAwaiter().GetResult(),
        "Conflicting duplicate Math Evaluation batch item payload must fail closed.");

    var partialRepository = new InMemoryMathEvaluationBatchRepository();
    var partialService = new MathEvaluationBatchService(
        registry,
        new DurableMathEvaluationService(registry, new MathCertificateEvaluationService(registry), new InMemoryMathEvaluationDurableRepository()),
        partialRepository);
    var partialRequest = DurableMathEvalBatchRequest(
        "math-evaluation-batch:partial",
        [
            ("ticket:batch:partial:1", "math-evaluation-batch:partial:item:1", new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } }),
            ("ticket:batch:partial:bad", "math-evaluation-batch:partial:item:bad", new Dictionary<string, object?> { ["numbers"] = new[] { 1, 1, 2 } })
        ]);
    var partial = await partialService.ExecuteAsync(partialRequest, CancellationToken.None);
    if (partial.Batch.Status != MathEvaluationBatchStatus.PartiallyCompleted ||
        partial.Items.Count(item => item.EvaluationStatus == MathEvaluationBatchItemStatus.Completed) != 1 ||
        partial.Items.Count(item => item.EvaluationStatus == MathEvaluationBatchItemStatus.Failed) != 1)
    {
        throw new InvalidOperationException("Math Evaluation batch must derive partially completed status from mixed item states.");
    }

    var failedAttemptsBeforeRecovery = partialRepository.Attempts.Count;
    var recoveryRequest = partialRequest with
    {
        Items =
        [
            partialRequest.Items.First(),
            partialRequest.Items.Last() with { WagerPayload = new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3 } } }
        ]
    };
    var recovered = await partialService.RecoverAsync(partialRequest.BatchIdempotencyKey, recoveryRequest, retryFailedItems: true, CancellationToken.None);
    if (recovered.Batch.Status != MathEvaluationBatchStatus.Completed ||
        partialRepository.Attempts.Count <= failedAttemptsBeforeRecovery)
    {
        throw new InvalidOperationException("Math Evaluation batch recovery must retry failed/incomplete items as new governed attempts.");
    }

    var cancelRepository = new InMemoryMathEvaluationBatchRepository();
    var cancelService = new MathEvaluationBatchService(
        registry,
        new DurableMathEvaluationService(registry, new MathCertificateEvaluationService(registry), new InMemoryMathEvaluationDurableRepository()),
        cancelRepository);
    var cancelRequest = DurableMathEvalBatchRequest(
        "math-evaluation-batch:cancel",
        [
            ("ticket:batch:cancel:1", "math-evaluation-batch:cancel:item:1", new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } }),
            ("ticket:batch:cancel:bad", "math-evaluation-batch:cancel:item:bad", new Dictionary<string, object?> { ["numbers"] = new[] { 1, 1, 2 } })
        ]);
    await cancelService.ExecuteAsync(cancelRequest, CancellationToken.None);
    var cancelled = await cancelService.CancelAsync(cancelRequest.BatchIdempotencyKey, "QA_CANCEL", "QA governed cancellation", CancellationToken.None);
    if (cancelled.Batch.Status != MathEvaluationBatchStatus.Cancelled ||
        cancelled.Items.Count(item => item.EvaluationStatus == MathEvaluationBatchItemStatus.Completed) != 1)
    {
        throw new InvalidOperationException("Math Evaluation batch cancellation must preserve completed immutable items.");
    }

    var ordered = DurableMathEvalBatchRequest(
        "math-evaluation-batch:ordered",
        [
            ("ticket:batch:ordered:1", "math-evaluation-batch:ordered:item:1", new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } }),
            ("ticket:batch:ordered:2", "math-evaluation-batch:ordered:item:2", new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3 } })
        ],
        maxDegreeOfParallelism: 2);
    var reversed = ordered with
    {
        BatchId = Guid.NewGuid(),
        BatchIdempotencyKey = "math-evaluation-batch:reversed",
        Items = ordered.Items.Reverse().ToArray()
    };
    var orderedRepository = new InMemoryMathEvaluationBatchRepository();
    var orderedDurable = new InMemoryMathEvaluationDurableRepository();
    var orderedService = new MathEvaluationBatchService(
        registry,
        new DurableMathEvaluationService(registry, new MathCertificateEvaluationService(registry), orderedDurable),
        orderedRepository);
    var orderedResult = await orderedService.ExecuteAsync(ordered, CancellationToken.None);
    var reversedResult = await orderedService.ExecuteAsync(reversed, CancellationToken.None);
    var orderedHashes = orderedResult.CompletedResults.Values.Select(item => item.CanonicalPrizeFactsHash).Order(StringComparer.Ordinal).ToArray();
    var reversedHashes = reversedResult.CompletedResults.Values.Select(item => item.CanonicalPrizeFactsHash).Order(StringComparer.Ordinal).ToArray();
    if (!orderedHashes.SequenceEqual(reversedHashes) ||
        orderedResult.Items.Select(item => item.CertificateId).Intersect(reversedResult.Items.Select(item => item.CertificateId)).Any())
    {
        throw new InvalidOperationException("Batch item ordering and bounded parallel execution must not alter PrizeFacts or duplicate certificates.");
    }

    var readiness = await batchRepository.CheckReadinessAsync(CancellationToken.None);
    if (!readiness.BatchRecoveryReady ||
        !readiness.ItemIdempotencyReady ||
        !readiness.BoundedParallelExecutionReady ||
        !readiness.ProductionActivationDisabled ||
        readiness.BatchRepositoryConfigured)
    {
        throw new InvalidOperationException("In-memory Math Evaluation batch readiness must remain explicit non-production fallback.");
    }
}

static async Task RunSettlementInputAdapterTests()
{
    var registry = new MathEvaluatorRegistry([new KenoMathEvaluator()]);
    var durableRepository = new InMemoryMathEvaluationDurableRepository();
    var durableService = new DurableMathEvaluationService(
        registry,
        new MathCertificateEvaluationService(registry),
        durableRepository);
    var mathResult = await durableService.EvaluateAsync(
        DurableMathEvalRequest(
            "settlement-input:math-evaluation:1",
            "ticket:settlement-input:1",
            new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 } }),
        CancellationToken.None);
    var repository = new InMemorySettlementInputRepository();
    var adapter = new SettlementInputAdapter(repository);

    var first = await adapter.ConvertAsync(mathResult, CancellationToken.None);
    var duplicate = await adapter.ConvertAsync(mathResult with { RequestId = Guid.NewGuid() }, CancellationToken.None);
    if (first.SettlementInputId == Guid.Empty ||
        first.MathEvaluationCertificateId != mathResult.Certificate.CertificateId ||
        first.MathEvaluationCertificateHash != mathResult.CanonicalPrizeFactsHash ||
        first.OutcomeCertificateId != mathResult.Certificate.OutcomeCertificateId ||
        first.OutcomeCertificateHash != mathResult.Certificate.OutcomeCertificateHash ||
        first.TicketReference != mathResult.Certificate.TicketReference ||
        first.GameManifestHash != mathResult.Certificate.GameManifestHash ||
        first.MathModelHash != mathResult.Certificate.MathModelHash ||
        first.PaytableHash != mathResult.Certificate.PaytableHash ||
        first.PrizeFactsHash != mathResult.CanonicalPrizeFactsHash ||
        duplicate.SettlementInputId != first.SettlementInputId ||
        repository.Inputs.Count != 1)
    {
        throw new InvalidOperationException("Valid Math Evaluation Certificate must convert to one deterministic SettlementInput record.");
    }

    var repeat = SettlementInputAdapter.BuildSettlementInput(mathResult);
    if (repeat.CanonicalPayloadHash != first.CanonicalPayloadHash ||
        repeat.CanonicalPayloadJson != first.CanonicalPayloadJson ||
        repeat.ReplayHash != first.ReplayHash)
    {
        throw new InvalidOperationException("SettlementInput canonical payload and replay hash must be deterministic.");
    }

    var replay = await adapter.ReplayAsync(mathResult, CancellationToken.None);
    if (replay.CanonicalPayloadHash != first.CanonicalPayloadHash)
    {
        throw new InvalidOperationException("SettlementInput replay must return the original canonical handoff artifact.");
    }

    var byCertificate = await adapter.FindByMathEvaluationCertificateAsync(
        mathResult.Certificate.CertificateId,
        mathResult.CanonicalPrizeFactsHash,
        CancellationToken.None);
    var byHash = await adapter.FindByCanonicalPayloadHashAsync(first.CanonicalPayloadHash, CancellationToken.None);
    if (byCertificate?.SettlementInputId != first.SettlementInputId ||
        byHash?.SettlementInputId != first.SettlementInputId)
    {
        throw new InvalidOperationException("SettlementInput lookup by Math Evaluation Certificate and payload hash must work.");
    }

    var conflictingCertificate = mathResult.Certificate with { EvaluatorVersion = "keno-math-evaluator-conflict" };
    AssertThrows(
        () => adapter.ConvertAsync(mathResult with { Certificate = conflictingCertificate }, CancellationToken.None).GetAwaiter().GetResult(),
        "Conflicting SettlementInput payload for the same Math Evaluation Certificate must fail closed.");

    AssertThrows(
        () => adapter.ConvertAsync(
            mathResult with { CanonicalPrizeFactsHash = "sha256:bad-certificate-hash" },
            CancellationToken.None).GetAwaiter().GetResult(),
        "Math Evaluation Certificate hash mismatch must be rejected.");

    AssertThrows(
        () => adapter.ConvertAsync(
            mathResult with { Certificate = mathResult.Certificate with { OutcomeCertificateId = Guid.Empty } },
            CancellationToken.None).GetAwaiter().GetResult(),
        "Outcome Certificate reference mismatch must be rejected.");

    AssertThrows(
        () => adapter.ConvertAsync(
            mathResult with { Certificate = mathResult.Certificate with { GameManifestHash = "not-a-hash" } },
            CancellationToken.None).GetAwaiter().GetResult(),
        "Game Manifest mismatch must be rejected.");

    AssertThrows(
        () => adapter.ConvertAsync(
            mathResult with { Certificate = mathResult.Certificate with { RtpMathMetadataReference = "math-model:mismatch" } },
            CancellationToken.None).GetAwaiter().GetResult(),
        "Math Model mismatch must be rejected.");

    AssertThrows(
        () => adapter.ConvertAsync(
            mathResult with { Certificate = mathResult.Certificate with { PaytableHash = "not-a-hash" } },
            CancellationToken.None).GetAwaiter().GetResult(),
        "Paytable mismatch must be rejected.");

    var badPrizeFacts = mathResult.PrizeFacts with
    {
        OutcomeDerivedFacts = new Dictionary<string, object?> { ["ledgerEntryId"] = "forbidden" }
    };
    var badPrizeFactsJson = MathEvaluationCanonicalizer.CanonicalizePrizeFacts(badPrizeFacts);
    var badPrizeFactsHash = MathEvaluationCanonicalizer.HashJson(badPrizeFactsJson);
    AssertThrows(
        () => adapter.ConvertAsync(
            mathResult with
            {
                PrizeFacts = badPrizeFacts,
                CanonicalPrizeFactsJson = badPrizeFactsJson,
                CanonicalPrizeFactsHash = badPrizeFactsHash,
                Certificate = mathResult.Certificate with { CanonicalPrizeFactsHash = badPrizeFactsHash }
            },
            CancellationToken.None).GetAwaiter().GetResult(),
        "SettlementInput adapter must reject PrizeFacts with ledger references.");

    var lowerPayload = first.CanonicalPayloadJson.ToLowerInvariant();
    if (lowerPayload.Contains("balance", StringComparison.Ordinal) ||
        lowerPayload.Contains("wallet", StringComparison.Ordinal) ||
        lowerPayload.Contains("ledger", StringComparison.Ordinal) ||
        lowerPayload.Contains("commission", StringComparison.Ordinal) ||
        lowerPayload.Contains("tax", StringComparison.Ordinal) ||
        lowerPayload.Contains("cashier", StringComparison.Ordinal))
    {
        throw new InvalidOperationException("SettlementInput canonical payload must not contain financial, wallet, ledger, commission, tax, or cashier fields.");
    }

    var readiness = await repository.CheckReadinessAsync(CancellationToken.None);
    if (!readiness.SettlementHandoffReady ||
        !readiness.AdapterReady ||
        !readiness.CertificateValidationReady ||
        !readiness.CanonicalPayloadReady ||
        !readiness.ReplayReady ||
        !readiness.ProductionActivationDisabled ||
        readiness.RepositoryConfigured)
    {
        throw new InvalidOperationException("In-memory SettlementInput readiness must remain explicit non-production fallback.");
    }
}

static OutcomeAuthorityReadinessSection ReadySection(string section)
{
    return new OutcomeAuthorityReadinessSection(
        section,
        OutcomeAuthorityReadinessSectionStatus.Ready,
        [$"sha256:evidence:{section.Replace(' ', '-')}"],
        []);
}

static MathCertificateEvaluationRequest DurableMathEvalRequest(
    string idempotencyKey,
    string ticketReference,
    IReadOnlyDictionary<string, object?> wagerPayload,
    string wagerSchema = nameof(WagerType.KenoSpot))
{
    var manifest = MathEvalManifest();
    var mathModel = MathEvalModel();
    var paytable = MathEvalPaytable(mathModel);
    var outcomePayload = MathEvalOutcomePayload([1, 2, 3, 4, 5, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39], bullseye: 1);
    return new MathCertificateEvaluationRequest(
        Guid.NewGuid(),
        idempotencyKey,
        MathEvaluationMode.DryRun,
        manifest,
        MathEvalOutcomeCertificate(outcomePayload),
        mathModel,
        paytable,
        ticketReference,
        wagerSchema,
        wagerPayload,
        outcomePayload);
}

static MathEvaluationBatchRequest DurableMathEvalBatchRequest(
    string batchIdempotencyKey,
    IReadOnlyCollection<(string TicketReference, string ItemIdempotencyKey, IReadOnlyDictionary<string, object?> WagerPayload)> items,
    int maxDegreeOfParallelism = 1)
{
    var manifest = MathEvalManifest();
    var mathModel = MathEvalModel();
    var paytable = MathEvalPaytable(mathModel);
    var outcomePayload = MathEvalOutcomePayload([1, 2, 3, 4, 5, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39], bullseye: 1);
    return new MathEvaluationBatchRequest(
        Guid.NewGuid(),
        batchIdempotencyKey,
        MathEvaluationMode.DryRun,
        manifest,
        MathEvalOutcomeCertificate(outcomePayload),
        mathModel,
        paytable,
        nameof(WagerType.KenoSpot),
        outcomePayload,
        items.Select(item => new MathEvaluationBatchItemRequest(
            Guid.NewGuid(),
            item.TicketReference,
            item.ItemIdempotencyKey,
            item.WagerPayload)).ToArray(),
        maxDegreeOfParallelism,
        new Dictionary<string, object?> { ["qaPhase"] = "P1-004" });
}

static void AssertThrows(Action action, string message)
{
    try
    {
        action();
    }
    catch (Exception)
    {
        return;
    }

    throw new InvalidOperationException(message);
}

static void AssertKenoPrize(
    KenoMathEvaluator evaluator,
    GameManifestV1 manifest,
    MathModelDefinitionV1 mathModel,
    PaytableDefinitionV1 paytable,
    OutcomeCertificate outcome,
    IReadOnlyDictionary<string, object?> outcomePayload,
    string wagerSchema,
    IReadOnlyDictionary<string, object?> wagerPayload,
    string expectedPrizeTier,
    int expectedHitCount)
{
    var result = evaluator.Evaluate(new MathEvaluatorRequest(
        manifest,
        outcome,
        mathModel,
        paytable,
        $"ticket:{wagerSchema}",
        wagerSchema,
        wagerPayload,
        outcomePayload));

    if (result.PrizeFacts.Outcome != PrizeOutcome.Win ||
        result.PrizeFacts.PrizeTier != expectedPrizeTier ||
        result.PrizeFacts.HitCount != expectedHitCount ||
        string.IsNullOrWhiteSpace(result.PrizeFacts.PaytableRowReference) ||
        string.IsNullOrWhiteSpace(result.CanonicalPrizeFactsHash) ||
        result.CanonicalPrizeFactsJson.Contains("ledger", StringComparison.OrdinalIgnoreCase) ||
        result.CanonicalPrizeFactsJson.Contains("wallet", StringComparison.OrdinalIgnoreCase) ||
        result.CanonicalPrizeFactsJson.Contains("cashier", StringComparison.OrdinalIgnoreCase))
    {
        throw new InvalidOperationException($"Keno Math evaluator produced invalid PrizeFacts for {wagerSchema}.");
    }
}

static GameManifestV1 MathEvalManifest()
{
    return new GameManifestV1(
        Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
        Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
        "KENO",
        "Keno",
        nameof(GameType.Keno),
        [],
        [
            nameof(WagerType.KenoSpot),
            nameof(WagerType.KenoBullseye),
            nameof(WagerType.KenoBigSmall),
            nameof(WagerType.KenoOddEven),
            nameof(WagerType.KenoUpDown),
            nameof(WagerType.KenoDragonTiger),
            nameof(WagerType.KenoSumOverUnder),
            nameof(WagerType.KenoElement)
        ],
        ["outcome-strategy:keno:1.0.0"],
        ["math-model:keno:1.0.0:sha256:math-model-keno"],
        ["paytable:keno:1.0.0:sha256:paytable-keno"],
        ["settlement-policy:standard:1.0.0"],
        new Dictionary<string, object?>(),
        new Dictionary<string, object?>(),
        new Dictionary<string, object?>(),
        "cert-pack:keno:1.0.0",
        string.Empty,
        OperatorApprovalState.Approved,
        GameManifestLifecycleState.GovernanceApproved,
        DateTimeOffset.UnixEpoch,
        null,
        "1.0.0",
        "sha256:manifest-keno",
        new SignatureMetadata("qa-signing-key", "sha256-v1", "placeholder-v1", "qa-signature", DateTimeOffset.UnixEpoch));
}

static MathModelDefinitionV1 MathEvalModel()
{
    return new MathModelDefinitionV1(
        Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc"),
        "math-model:keno",
        "1.0.0",
        [nameof(GameType.Keno)],
        [
            nameof(WagerType.KenoSpot),
            nameof(WagerType.KenoBullseye),
            nameof(WagerType.KenoBigSmall),
            nameof(WagerType.KenoOddEven),
            nameof(WagerType.KenoUpDown),
            nameof(WagerType.KenoDragonTiger),
            nameof(WagerType.KenoSumOverUnder),
            nameof(WagerType.KenoElement)
        ],
        0.92m,
        -0.08m,
        "Medium",
        0.18m,
        new Dictionary<string, object?> { ["maxExposureMultiple"] = 100 },
        new Dictionary<string, object?>(),
        new Dictionary<string, object?> { ["mode"] = "bankers" },
        new Dictionary<string, object?> { ["currency"] = "USD", ["minorUnit"] = 2 },
        null,
        null,
        MathGovernanceLifecycleState.GovernanceApproved,
        "sha256:math-model-keno",
        MathCertificationBindingState.None,
        null);
}

static PaytableDefinitionV1 MathEvalPaytable(MathModelDefinitionV1 mathModel)
{
    return new PaytableDefinitionV1(
        Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd"),
        "paytable:keno",
        "1.0.0",
        mathModel.MathModelId,
        mathModel.Version,
        [
            Row("keno-spot-5", nameof(WagerType.KenoSpot), "KENO_SPOT_5", 50m, new Dictionary<string, object?> { ["spotCount"] = 5, ["hitCount"] = 5 }),
            Row("keno-bullseye", nameof(WagerType.KenoBullseye), "KENO_BULLSEYE", 25m, new Dictionary<string, object?> { ["bullseyeMatch"] = true }),
            Row("keno-big-small", nameof(WagerType.KenoBigSmall), "KENO_BIG_SMALL", 18m, new Dictionary<string, object?> { ["result"] = "WIN" }),
            Row("keno-odd-even", nameof(WagerType.KenoOddEven), "KENO_ODD_EVEN", 18m, new Dictionary<string, object?> { ["result"] = "WIN" }),
            Row("keno-up-down", nameof(WagerType.KenoUpDown), "KENO_UP_DOWN", 18m, new Dictionary<string, object?> { ["result"] = "WIN" }),
            Row("keno-dragon-tiger", nameof(WagerType.KenoDragonTiger), "KENO_DRAGON_TIGER", 18m, new Dictionary<string, object?> { ["result"] = "WIN" }),
            Row("keno-sum-over-under", nameof(WagerType.KenoSumOverUnder), "KENO_SUM_OVER_UNDER", 18m, new Dictionary<string, object?> { ["result"] = "WIN" }),
            Row("keno-element", nameof(WagerType.KenoElement), "KENO_ELEMENT", 18m, new Dictionary<string, object?> { ["result"] = "WIN" })
        ],
        [],
        new Dictionary<string, object?> { ["maxPayout"] = 10000m },
        null,
        MathGovernanceLifecycleState.GovernanceApproved,
        "sha256:paytable-keno",
        MathCertificationBindingState.None,
        null);

    static PrizeMatrixRow Row(string id, string wagerSchema, string prizeCode, decimal payout, IReadOnlyDictionary<string, object?> conditions)
    {
        return new PrizeMatrixRow(id, wagerSchema, prizeCode, 0m, payout, 10000m, conditions);
    }
}

static IReadOnlyDictionary<string, object?> MathEvalOutcomePayload(int[] numbers, int bullseye)
{
    return new SortedDictionary<string, object?>(StringComparer.Ordinal)
    {
        ["bullseye"] = bullseye,
        ["numbers"] = numbers
    };
}

static OutcomeCertificate MathEvalOutcomeCertificate(IReadOnlyDictionary<string, object?> outcomePayload)
{
    return new OutcomeCertificate(
        Guid.Parse("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
        Guid.Parse("ffffffff-ffff-ffff-ffff-ffffffffffff"),
        Guid.Parse("99999999-9999-9999-9999-999999999999"),
        "outcome-strategy:keno",
        "1.0.0",
        "rng-provider:test",
        "1.0.0",
        MathEvaluationCanonicalizer.HashPayload(outcomePayload),
        "sha256:evidence",
        [],
        null,
        OutcomeCustodyState.Generated,
        DateTimeOffset.UnixEpoch);
}

sealed class FixedEntropyProvider(byte[] fixedBytes) : IOsEntropyProvider
{
    public OsEntropyPlatform Platform => OsEntropyPlatform.Unsupported;

    public bool IsSupported => true;

    public void Fill(byte[] buffer)
    {
        for (var index = 0; index < buffer.Length; index++)
        {
            buffer[index] = fixedBytes[index % fixedBytes.Length];
        }
    }

    public OsEntropyReadiness CheckReadiness()
    {
        return new OsEntropyReadiness(Platform, Supported: true, Ready: true, []);
    }
}

sealed class ConfiguredEntropyProvider(OsEntropyPlatform platform) : IOsEntropyProvider
{
    public OsEntropyPlatform Platform => platform;

    public bool IsSupported => true;

    public void Fill(byte[] buffer)
    {
        Array.Fill(buffer, (byte)0x42);
    }

    public OsEntropyReadiness CheckReadiness()
    {
        return new OsEntropyReadiness(Platform, Supported: true, Ready: true, []);
    }
}
