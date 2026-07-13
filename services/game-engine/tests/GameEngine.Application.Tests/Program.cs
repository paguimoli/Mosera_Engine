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
    ]);
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

var duplicateRuntimeResult = await runtimeOrchestrator.ExecuteAsync(runtimeRequest, [runtimeProvider], CancellationToken.None);
if (duplicateRuntimeResult.Status != OutcomeRuntimeStatus.DuplicateReturned ||
    duplicateRuntimeResult.RuntimeRequestId != runtimeResult.RuntimeRequestId)
{
    throw new InvalidOperationException("Duplicate runtime idempotency request must return existing deterministic state.");
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

Console.WriteLine("GameEngine.Application.Tests PASS");

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
