using System.Security.Cryptography;
using System.Text;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public interface IOutcomeProviderRuntime
{
    OutcomeProviderType ProviderType { get; }

    Task<OutcomeProviderRuntimeReadiness> ValidateProviderReadinessAsync(
        OutcomeProviderDefinitionV1 provider,
        CancellationToken cancellationToken);

    Task<OutcomeProviderRuntimeResult> CreateOutcomeAsync(
        OutcomeProviderRuntimeContext context,
        CancellationToken cancellationToken);

    Task<OutcomeRuntimeAttemptEvidence> CreateEvidenceAsync(
        OutcomeProviderRuntimeContext context,
        OutcomeRuntimeStatus status,
        OutcomeRuntimeFailureCode failureCode,
        string? failureReason,
        bool lockAcquired,
        CancellationToken cancellationToken);

    string CanonicalizeOutcome(IReadOnlyDictionary<string, object?> outcomePayload);

    Task<OutcomeCertificate?> CreateOutcomeCertificateAsync(
        OutcomeProviderRuntimeContext context,
        string canonicalOutcomeHash,
        CancellationToken cancellationToken);

    Task<ValidationResult> VerifyReplayAsync(
        OutcomeProviderRuntimeContext context,
        CancellationToken cancellationToken);
}

public interface IOutcomeProviderResolver
{
    Task<OutcomeProviderDefinitionV1> ResolveAsync(
        OutcomeProviderRuntimeRequest request,
        IReadOnlyCollection<OutcomeProviderDefinitionV1> availableProviders,
        CancellationToken cancellationToken);
}

public interface IOutcomeRuntimeRequestRepository
{
    Task<OutcomeRuntimeStoredRequest?> FindByIdempotencyKeyAsync(
        string idempotencyKey,
        string drawRequestScope,
        CancellationToken cancellationToken);

    Task<OutcomeRuntimeRequestClaim> ClaimRequestAsync(
        OutcomeRuntimeStoredRequest request,
        CancellationToken cancellationToken);

    Task<OutcomeRuntimeStoredRequest> AppendRequestAsync(
        OutcomeRuntimeStoredRequest request,
        CancellationToken cancellationToken);

    Task AppendAttemptAsync(
        OutcomeRuntimeAttemptEvidence attempt,
        CancellationToken cancellationToken);

    Task<OutcomeRuntimePersistenceReadiness> CheckReadinessAsync(
        CancellationToken cancellationToken);
}

public interface IOutcomeRuntimeLockManager
{
    Task<OutcomeRuntimeLockLease> TryAcquireAsync(
        string lockScope,
        TimeSpan timeout,
        CancellationToken cancellationToken);

    Task ReleaseAsync(
        OutcomeRuntimeLockLease lease,
        CancellationToken cancellationToken);

    Task<OutcomeRuntimeLockingReadiness> CheckReadinessAsync(
        CancellationToken cancellationToken);
}

public sealed class OutcomeProviderResolver : IOutcomeProviderResolver
{
    public Task<OutcomeProviderDefinitionV1> ResolveAsync(
        OutcomeProviderRuntimeRequest request,
        IReadOnlyCollection<OutcomeProviderDefinitionV1> availableProviders,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (request.ManifestBinding is null)
        {
            throw new InvalidOperationException("Game Manifest must bind exactly one Outcome Provider version.");
        }

        if (request.SilentFallbackConfigured)
        {
            throw new InvalidOperationException("Silent fallback Outcome Providers are not allowed.");
        }

        var matches = availableProviders
            .Where(provider =>
                provider.ProviderId == request.ManifestBinding.ProviderId &&
                provider.ProviderVersion == request.ManifestBinding.ProviderVersion)
            .ToArray();

        if (matches.Length == 0)
        {
            throw new InvalidOperationException("Manifest-bound Outcome Provider was not found.");
        }

        if (matches.Length > 1)
        {
            throw new InvalidOperationException("Manifest-bound Outcome Provider resolution is ambiguous.");
        }

        var resolved = matches[0];

        if (resolved.ProviderType != request.ExpectedProviderType)
        {
            throw new InvalidOperationException("Manifest-bound Outcome Provider type does not match the expected provider type.");
        }

        if (resolved.LifecycleState != OutcomeProviderLifecycleState.Active)
        {
            throw new InvalidOperationException("Manifest-bound Outcome Provider is not active.");
        }

        if (!resolved.ProductionEligible && request.Mode == OutcomeRuntimeExecutionMode.Production)
        {
            throw new InvalidOperationException("Manifest-bound Outcome Provider is not production eligible.");
        }

        if (resolved.ProviderType == OutcomeProviderType.SimulationTest && request.Mode == OutcomeRuntimeExecutionMode.Production)
        {
            throw new InvalidOperationException("Simulation/test Outcome Providers cannot be production authority.");
        }

        foreach (var primitive in request.RequiredPrimitives.Concat(request.ManifestBinding.ProviderCapabilityRequirements))
        {
            if (!resolved.SupportedOutcomePrimitiveTypes.Contains(primitive))
            {
                throw new InvalidOperationException($"Outcome Provider does not support required primitive {primitive}.");
            }
        }

        if (request.ManifestBinding.PlayerVerificationReceiptRequired &&
            !resolved.CapabilityMarkers.SupportsPlayerVerificationReceipt)
        {
            throw new InvalidOperationException("Player verification receipt requirement is unsupported by the bound Outcome Provider.");
        }

        return Task.FromResult(resolved);
    }
}

public abstract class OutcomeProviderRuntimeShellBase : IOutcomeProviderRuntime
{
    protected OutcomeProviderRuntimeShellBase(OutcomeProviderType providerType)
    {
        ProviderType = providerType;
    }

    public OutcomeProviderType ProviderType { get; }

    public virtual Task<OutcomeProviderRuntimeReadiness> ValidateProviderReadinessAsync(
        OutcomeProviderDefinitionV1 provider,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var blockers = new List<string>();

        if (provider.ProviderType != ProviderType)
        {
            blockers.Add("Provider runtime type does not match the provider definition.");
        }

        if (provider.LifecycleState != OutcomeProviderLifecycleState.Active)
        {
            blockers.Add("Provider definition is not active.");
        }

        if (provider.FailureMode != OutcomeProviderFailureMode.FailClosed)
        {
            blockers.Add("Provider runtime must fail closed.");
        }

        blockers.Add("Production outcome generation is not implemented in this phase.");

        return Task.FromResult(new OutcomeProviderRuntimeReadiness(
            ProviderType,
            ProviderResolverReady: true,
            OrchestrationReady: true,
            DurableIdempotencyConfigured: true,
            AdvisoryLockingConfigured: true,
            ProviderRuntimeImplemented: false,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: provider.HealthReadinessCapabilities,
            Blockers: blockers));
    }

    public virtual Task<OutcomeProviderRuntimeResult> CreateOutcomeAsync(
        OutcomeProviderRuntimeContext context,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var now = DateTimeOffset.UtcNow;
        return Task.FromResult(new OutcomeProviderRuntimeResult(
            context.Request.RuntimeRequestId,
            context.Request.IdempotencyKey,
            context.Request.DrawRequestScope,
            context.Request.GameManifestId,
            context.Request.GameManifestVersion,
            context.Provider.ProviderId,
            context.Provider.ProviderVersion,
            context.Provider.ProviderType,
            context.Request.Mode,
            context.Request.Mode == OutcomeRuntimeExecutionMode.Production
                ? OutcomeRuntimeStatus.ProductionDisabled
                : OutcomeRuntimeStatus.GenerationNotImplemented,
            context.Request.Mode == OutcomeRuntimeExecutionMode.Production
                ? OutcomeRuntimeFailureCode.ProductionDisabled
                : OutcomeRuntimeFailureCode.GenerationNotImplemented,
            context.Request.Mode == OutcomeRuntimeExecutionMode.Production
                ? "Production Outcome Authority remains disabled."
                : "Provider runtime shell is present, but outcome generation is not implemented in this phase.",
            context.Request.CanonicalRequestHash,
            ResultReference: null,
            EvidenceReference: null,
            StartedAt: now,
            CompletedAt: now));
    }

    public Task<OutcomeRuntimeAttemptEvidence> CreateEvidenceAsync(
        OutcomeProviderRuntimeContext context,
        OutcomeRuntimeStatus status,
        OutcomeRuntimeFailureCode failureCode,
        string? failureReason,
        bool lockAcquired,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var now = DateTimeOffset.UtcNow;
        var lockScope = OutcomeProviderOrchestrationService.BuildLockScope(context.Request);
        var hash = OutcomeProviderOrchestrationService.HashCanonical(
            $"{context.Request.IdempotencyKey}|{context.Request.DrawRequestScope}|{context.Provider.ProviderId}|{status}|{failureCode}|{lockAcquired}");

        return Task.FromResult(new OutcomeRuntimeAttemptEvidence(
            Guid.NewGuid(),
            context.Request.RuntimeRequestId,
            context.Request.IdempotencyKey,
            context.Request.DrawRequestScope,
            context.Provider.ProviderId,
            context.Provider.ProviderVersion,
            context.Provider.ProviderType,
            context.Request.Mode,
            status,
            failureCode,
            failureReason,
            lockScope,
            lockAcquired,
            hash,
            now,
            now));
    }

    public string CanonicalizeOutcome(IReadOnlyDictionary<string, object?> outcomePayload)
    {
        return OutcomeProviderOrchestrationService.Canonicalize(outcomePayload);
    }

    public Task<OutcomeCertificate?> CreateOutcomeCertificateAsync(
        OutcomeProviderRuntimeContext context,
        string canonicalOutcomeHash,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult<OutcomeCertificate?>(null);
    }

    public Task<ValidationResult> VerifyReplayAsync(
        OutcomeProviderRuntimeContext context,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(ValidationResult.Success());
    }
}

public sealed class CertifiedCsprngOutcomeProviderRuntime : OutcomeProviderRuntimeShellBase
{
    private const string DefaultCsprngProviderId = "certified-csprng-runtime";
    private const string DefaultCsprngProviderVersion = "1.0.0";
    private const string DefaultEntropyProviderId = "os-csprng";
    private const string DefaultEntropyProviderVersion = "1.0.0";

    private readonly IOsEntropyProvider entropyProvider;
    private readonly IHmacDrbgRuntime drbgRuntime;
    private readonly ICertifiedCsprngSampler sampler;
    private readonly ICertifiedCsprngEvidenceRepository evidenceRepository;

    public CertifiedCsprngOutcomeProviderRuntime()
        : this(
            new AutoOsEntropyProvider(),
            new HmacDrbgRuntime(),
            new CertifiedCsprngSampler(new HmacDrbgRuntime()),
            new InMemoryCertifiedCsprngEvidenceRepository())
    {
    }

    public CertifiedCsprngOutcomeProviderRuntime(
        IOsEntropyProvider entropyProvider,
        IHmacDrbgRuntime drbgRuntime,
        ICertifiedCsprngSampler sampler,
        ICertifiedCsprngEvidenceRepository evidenceRepository)
        : base(OutcomeProviderType.CertifiedCsprng)
    {
        this.entropyProvider = entropyProvider;
        this.drbgRuntime = drbgRuntime;
        this.sampler = sampler;
        this.evidenceRepository = evidenceRepository;
    }

    public override async Task<OutcomeProviderRuntimeReadiness> ValidateProviderReadinessAsync(
        OutcomeProviderDefinitionV1 provider,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var blockers = new List<string>();
        var entropyReadiness = entropyProvider.CheckReadiness();
        var drbgReadiness = drbgRuntime.RunHealthChecks();
        var evidenceReady = await evidenceRepository.CheckReadinessAsync(cancellationToken);

        if (provider.ProviderType != ProviderType)
        {
            blockers.Add("Provider runtime type does not match the provider definition.");
        }

        if (provider.LifecycleState != OutcomeProviderLifecycleState.Active)
        {
            blockers.Add("Provider definition is not active.");
        }

        if (provider.FailureMode != OutcomeProviderFailureMode.FailClosed)
        {
            blockers.Add("Provider runtime must fail closed.");
        }

        if (!entropyReadiness.Ready)
        {
            blockers.AddRange(entropyReadiness.Blockers);
        }

        if (!drbgReadiness.IsReady)
        {
            blockers.AddRange(drbgReadiness.Blockers);
        }

        if (!evidenceReady)
        {
            blockers.Add("Durable DRBG evidence persistence is not ready.");
        }

        blockers.Add("Production outcome generation remains disabled.");

        return new OutcomeProviderRuntimeReadiness(
            ProviderType,
            ProviderResolverReady: true,
            OrchestrationReady: true,
            DurableIdempotencyConfigured: true,
            AdvisoryLockingConfigured: true,
            ProviderRuntimeImplemented: true,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: provider.HealthReadinessCapabilities
                .Concat([
                    "os-entropy",
                    "hmac-drbg",
                    "rejection-sampling",
                    "fisher-yates",
                    "unique-number-selection",
                    "integer-rational-weighted-selection"
                ])
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            Blockers: blockers);
    }

    public override async Task<OutcomeProviderRuntimeResult> CreateOutcomeAsync(
        OutcomeProviderRuntimeContext context,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var started = DateTimeOffset.UtcNow;
        if (context.Request.Mode == OutcomeRuntimeExecutionMode.Production)
        {
            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.ProductionDisabled,
                OutcomeRuntimeFailureCode.ProductionDisabled,
                "Production Outcome Authority remains disabled.",
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: null,
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }

        var entropy = new byte[48];
        var nonce = new byte[32];
        var personalization = Encoding.UTF8.GetBytes(
            $"{context.Request.RuntimeRequestId:N}|{context.Request.DrawRequestScope}|{context.Provider.ProviderId}|{context.Provider.ProviderVersion}");
        HmacDrbgSession? session = null;
        byte[]? randomStream = null;
        var startupResult = DrbgEvidenceTestResult.Missing;
        var katResult = DrbgEvidenceTestResult.Missing;
        var continuousResult = DrbgEvidenceTestResult.Missing;
        try
        {
            entropyProvider.Fill(entropy);
            entropyProvider.Fill(nonce);

            var health = drbgRuntime.RunHealthChecks();
            startupResult = health.StartupSelfTestPassed ? DrbgEvidenceTestResult.Passed : DrbgEvidenceTestResult.Failed;
            katResult = health.KnownAnswerResults.All(result => result.Passed)
                ? DrbgEvidenceTestResult.Passed
                : DrbgEvidenceTestResult.Failed;
            continuousResult = health.ContinuousTestReady ? DrbgEvidenceTestResult.Passed : DrbgEvidenceTestResult.Failed;
            if (!health.IsReady)
            {
                throw new CryptographicException(string.Join("; ", health.Blockers));
            }

            session = drbgRuntime.Instantiate(
                CertifiedCsprngHashAlgorithm.Sha256,
                entropy,
                nonce,
                personalization,
                securityStrengthBits: 256);

            var generatedNumbers = context.Request.RequiredPrimitives.Contains(OutcomePrimitiveType.UniqueNumberSet)
                ? sampler.UniqueNumbers(session, 1, 90, 5)
                : [sampler.NextInt32(session, 0, 9)];
            randomStream = drbgRuntime.Generate(session, 64);
            var generatedAt = DateTimeOffset.UtcNow;
            var randomStreamHash = HashBytes(randomStream);
            var canonicalOutcome = CanonicalizeOutcome(new Dictionary<string, object?>
            {
                ["drawRequestScope"] = context.Request.DrawRequestScope,
                ["outcomePrimitive"] = context.Request.RequiredPrimitives.FirstOrDefault().ToString(),
                ["resultNumbers"] = string.Join(",", generatedNumbers),
                ["randomStreamHash"] = randomStreamHash
            });
            var canonicalOutcomeHash = OutcomeProviderOrchestrationService.HashCanonical(canonicalOutcome);
            var evidenceHash = OutcomeProviderOrchestrationService.HashCanonical(
                $"{context.Request.RuntimeRequestId:N}|{context.Request.DrawRequestScope}|{context.Provider.ProviderId}|{canonicalOutcomeHash}|{session.ReseedCounter}");

            var seedCommitmentHash = HashSeedCommitment(entropy, nonce, personalization);
            drbgRuntime.Destroy(session);
            var destroyedAt = DateTimeOffset.UtcNow;

            var evidence = new DrbgSessionEvidence(
                Guid.NewGuid(),
                context.Request.DrawRequestScope,
                DefaultCsprngProviderId,
                DefaultCsprngProviderVersion,
                DefaultEntropyProviderId,
                DefaultEntropyProviderVersion,
                session.ReseedCounter,
                HashBytes(personalization),
                HashBytes(nonce),
                seedCommitmentHash,
                startupResult,
                katResult,
                continuousResult,
                generatedAt,
                destroyedAt,
                evidenceHash,
                SigningMetadata: null);
            session = null;

            await evidenceRepository.AppendAsync(evidence, cancellationToken);

            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.Accepted,
                OutcomeRuntimeFailureCode.None,
                FailureReason: null,
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: $"placeholder:drbg-session:{evidence.CanonicalEvidenceHash}",
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.FailedClosed,
                OutcomeRuntimeFailureCode.RuntimeNotReady,
                "Certified CSPRNG runtime failed closed.",
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: null,
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }
        finally
        {
            if (session is not null)
            {
                drbgRuntime.Destroy(session);
            }

            CryptographicOperations.ZeroMemory(entropy);
            CryptographicOperations.ZeroMemory(nonce);
            CryptographicOperations.ZeroMemory(personalization);
            if (randomStream is not null)
            {
                CryptographicOperations.ZeroMemory(randomStream);
            }
        }
    }

    private static string HashBytes(byte[] bytes)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()}";
    }

    private static string HashSeedCommitment(byte[] entropy, byte[] nonce, byte[] personalization)
    {
        var material = new byte[entropy.Length + nonce.Length + personalization.Length];
        try
        {
            Buffer.BlockCopy(entropy, 0, material, 0, entropy.Length);
            Buffer.BlockCopy(nonce, 0, material, entropy.Length, nonce.Length);
            Buffer.BlockCopy(personalization, 0, material, entropy.Length + nonce.Length, personalization.Length);
            return HashBytes(material);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(material);
        }
    }
}

public sealed class ProvablyFairOutcomeProviderRuntime : OutcomeProviderRuntimeShellBase
{
    private readonly ProvablyFairRuntimeService runtimeService;

    public ProvablyFairOutcomeProviderRuntime()
        : this(new ProvablyFairRuntimeService(
            new InMemoryProvablyFairSeedCustodyRepository(new AutoOsEntropyProvider()),
            new InMemoryProvablyFairNonceAllocator(),
            new InMemoryProvablyFairRuntimeEvidenceRepository(),
            new ProvablyFairClientSeedService()))
    {
    }

    public ProvablyFairOutcomeProviderRuntime(ProvablyFairRuntimeService runtimeService)
        : base(OutcomeProviderType.ProvablyFair)
    {
        this.runtimeService = runtimeService;
    }

    public override async Task<OutcomeProviderRuntimeReadiness> ValidateProviderReadinessAsync(
        OutcomeProviderDefinitionV1 provider,
        CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        var readiness = await runtimeService.CheckReadinessAsync(cancellationToken);

        if (provider.ProviderType != ProviderType)
        {
            blockers.Add("Provider runtime type does not match the provider definition.");
        }

        if (provider.LifecycleState != OutcomeProviderLifecycleState.Active)
        {
            blockers.Add("Provider definition is not active.");
        }

        if (provider.FailureMode != OutcomeProviderFailureMode.FailClosed)
        {
            blockers.Add("Provider runtime must fail closed.");
        }

        blockers.AddRange(readiness.Blockers);

        return new OutcomeProviderRuntimeReadiness(
            ProviderType,
            ProviderResolverReady: true,
            OrchestrationReady: true,
            DurableIdempotencyConfigured: true,
            AdvisoryLockingConfigured: true,
            ProviderRuntimeImplemented: true,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: provider.HealthReadinessCapabilities
                .Concat([
                    "protected-seed-custody-boundary",
                    "commitment-publication",
                    "monotonic-nonce-allocation",
                    "hmac-derivation",
                    "verification-receipts",
                    "reveal-verification"
                ])
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            Blockers: blockers);
    }

    public override async Task<OutcomeProviderRuntimeResult> CreateOutcomeAsync(
        OutcomeProviderRuntimeContext context,
        CancellationToken cancellationToken)
    {
        var started = DateTimeOffset.UtcNow;
        if (context.Request.Mode == OutcomeRuntimeExecutionMode.Production)
        {
            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.ProductionDisabled,
                OutcomeRuntimeFailureCode.ProductionDisabled,
                "Production Outcome Authority remains disabled.",
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: null,
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }

        try
        {
            var (_, receipt, _) = await runtimeService.GenerateAsync(context, cancellationToken);
            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.Accepted,
                OutcomeRuntimeFailureCode.None,
                FailureReason: null,
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: $"placeholder:provably-fair-receipt:{receipt.ReceiptHash}",
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.FailedClosed,
                OutcomeRuntimeFailureCode.RuntimeNotReady,
                "Provably Fair runtime failed closed.",
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: null,
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }
    }
}

public sealed class ExternalOfficialResultOutcomeProviderRuntime : OutcomeProviderRuntimeShellBase
{
    private readonly ExternalOfficialResultRuntimeService runtimeService;

    public ExternalOfficialResultOutcomeProviderRuntime()
        : this(new ExternalOfficialResultRuntimeService(
            new InMemoryExternalResultSourceRepository(),
            new InMemoryExternalResultEvidenceRepository()))
    {
    }

    public ExternalOfficialResultOutcomeProviderRuntime(ExternalOfficialResultRuntimeService runtimeService)
        : base(OutcomeProviderType.ExternalOfficialResult)
    {
        this.runtimeService = runtimeService;
    }

    public override async Task<OutcomeProviderRuntimeReadiness> ValidateProviderReadinessAsync(
        OutcomeProviderDefinitionV1 provider,
        CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        var compatibility = ExternalOfficialResultValidator.ValidateProviderCompatibility(provider);
        blockers.AddRange(compatibility.Errors.Select(error => error.Message));

        if (provider.LifecycleState != OutcomeProviderLifecycleState.Active)
        {
            blockers.Add("Provider definition is not active.");
        }

        if (provider.FailureMode != OutcomeProviderFailureMode.FailClosed)
        {
            blockers.Add("Provider runtime must fail closed.");
        }

        var readiness = await runtimeService.CheckReadinessAsync(cancellationToken);
        blockers.AddRange(readiness.Blockers);

        return new OutcomeProviderRuntimeReadiness(
            ProviderType,
            ProviderResolverReady: true,
            OrchestrationReady: true,
            DurableIdempotencyConfigured: readiness.DurableIdempotencyReady,
            AdvisoryLockingConfigured: readiness.AdvisoryLockingReady,
            ProviderRuntimeImplemented: true,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: provider.HealthReadinessCapabilities
                .Concat(readiness.CapabilityMarkers)
                .Concat([
                    "external-source-authenticity",
                    "signed-result-ingestion",
                    "canonical-result-normalization",
                    "duplicate-conflict-handling",
                    "external-custody-evidence"
                ])
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            Blockers: blockers);
    }

    public override async Task<OutcomeProviderRuntimeResult> CreateOutcomeAsync(
        OutcomeProviderRuntimeContext context,
        CancellationToken cancellationToken)
    {
        var started = DateTimeOffset.UtcNow;
        if (context.Request.Mode == OutcomeRuntimeExecutionMode.Production)
        {
            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.ProductionDisabled,
                OutcomeRuntimeFailureCode.ProductionDisabled,
                "Production Outcome Authority remains disabled.",
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: null,
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }

        try
        {
            var result = await runtimeService.IngestAsync(context, cancellationToken);
            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.Accepted,
                OutcomeRuntimeFailureCode.None,
                FailureReason: null,
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: $"placeholder:external-official-result:{result.Evidence.EvidenceHash}",
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.FailedClosed,
                ClassifyFailure(error),
                error.Message,
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: null,
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }
    }

    private static OutcomeRuntimeFailureCode ClassifyFailure(Exception error)
    {
        if (error.Message.Contains("signature", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.ExternalResultSignatureInvalid;
        }

        if (error.Message.Contains("conflict", StringComparison.OrdinalIgnoreCase) ||
            error.Message.Contains("supersession", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.ExternalResultConflict;
        }

        if (error.Message.Contains("source is unknown", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.UnknownExternalSource;
        }

        if (error.Message.Contains("schema", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.ExternalResultSchemaMismatch;
        }

        if (error.Message.Contains("timestamp", StringComparison.OrdinalIgnoreCase) ||
            error.Message.Contains("stale", StringComparison.OrdinalIgnoreCase) ||
            error.Message.Contains("future", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.ExternalResultTimestampInvalid;
        }

        if (error.Message.Contains("game", StringComparison.OrdinalIgnoreCase) ||
            error.Message.Contains("drawing", StringComparison.OrdinalIgnoreCase) ||
            error.Message.Contains("manifest", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.ExternalResultIdentityMismatch;
        }

        return OutcomeRuntimeFailureCode.ExternalSourceAuthenticationFailed;
    }
}

public sealed class PhysicalDrawResultOutcomeProviderRuntime : OutcomeProviderRuntimeShellBase
{
    private readonly PhysicalDrawResultRuntimeService runtimeService;

    public PhysicalDrawResultOutcomeProviderRuntime()
        : this(new PhysicalDrawResultRuntimeService(
            new InMemoryPhysicalDrawAuthorityRepository(),
            new InMemoryPhysicalDrawEvidenceRepository()))
    {
    }

    public PhysicalDrawResultOutcomeProviderRuntime(PhysicalDrawResultRuntimeService runtimeService)
        : base(OutcomeProviderType.PhysicalDrawResult)
    {
        this.runtimeService = runtimeService;
    }

    public override async Task<OutcomeProviderRuntimeReadiness> ValidateProviderReadinessAsync(
        OutcomeProviderDefinitionV1 provider,
        CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        var compatibility = PhysicalDrawResultValidator.ValidateProviderCompatibility(provider);
        blockers.AddRange(compatibility.Errors.Select(error => error.Message));

        if (provider.LifecycleState != OutcomeProviderLifecycleState.Active)
        {
            blockers.Add("Provider definition is not active.");
        }

        if (provider.FailureMode != OutcomeProviderFailureMode.FailClosed)
        {
            blockers.Add("Provider runtime must fail closed.");
        }

        var readiness = await runtimeService.CheckReadinessAsync(cancellationToken);
        blockers.AddRange(readiness.Blockers);

        return new OutcomeProviderRuntimeReadiness(
            ProviderType,
            ProviderResolverReady: true,
            OrchestrationReady: true,
            DurableIdempotencyConfigured: readiness.DurableIdempotencyReady,
            AdvisoryLockingConfigured: readiness.AdvisoryLockingReady,
            ProviderRuntimeImplemented: true,
            ProductionGenerationDisabled: true,
            CapabilityMarkers: provider.HealthReadinessCapabilities
                .Concat(readiness.CapabilityMarkers)
                .Concat([
                    "physical-draw-authority-validation",
                    "physical-draw-witness-validation",
                    "physical-draw-equipment-validation",
                    "physical-draw-custody-evidence",
                    "physical-draw-conflict-handling"
                ])
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            Blockers: blockers);
    }

    public override async Task<OutcomeProviderRuntimeResult> CreateOutcomeAsync(
        OutcomeProviderRuntimeContext context,
        CancellationToken cancellationToken)
    {
        var started = DateTimeOffset.UtcNow;
        if (context.Request.Mode == OutcomeRuntimeExecutionMode.Production)
        {
            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.ProductionDisabled,
                OutcomeRuntimeFailureCode.ProductionDisabled,
                "Production Outcome Authority remains disabled.",
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: null,
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }

        try
        {
            var result = await runtimeService.IngestAsync(context, cancellationToken);
            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.Accepted,
                OutcomeRuntimeFailureCode.None,
                FailureReason: null,
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: $"placeholder:physical-draw-result:{result.Evidence.EvidenceHash}",
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            return new OutcomeProviderRuntimeResult(
                context.Request.RuntimeRequestId,
                context.Request.IdempotencyKey,
                context.Request.DrawRequestScope,
                context.Request.GameManifestId,
                context.Request.GameManifestVersion,
                context.Provider.ProviderId,
                context.Provider.ProviderVersion,
                context.Provider.ProviderType,
                context.Request.Mode,
                OutcomeRuntimeStatus.FailedClosed,
                ClassifyFailure(error),
                error.Message,
                context.Request.CanonicalRequestHash,
                ResultReference: null,
                EvidenceReference: null,
                StartedAt: started,
                CompletedAt: DateTimeOffset.UtcNow);
        }
    }

    private static OutcomeRuntimeFailureCode ClassifyFailure(Exception error)
    {
        if (error.Message.Contains("authority is unknown", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.UnknownPhysicalDrawAuthority;
        }

        if (error.Message.Contains("authority is not active", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.PhysicalDrawAuthorityInactive;
        }

        if (error.Message.Contains("equipment", StringComparison.OrdinalIgnoreCase) ||
            error.Message.Contains("machine", StringComparison.OrdinalIgnoreCase) ||
            error.Message.Contains("ball set", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.PhysicalDrawEquipmentInvalid;
        }

        if (error.Message.Contains("witness", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.PhysicalDrawWitnessInvalid;
        }

        if (error.Message.Contains("conflict", StringComparison.OrdinalIgnoreCase) ||
            error.Message.Contains("supersession", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.PhysicalDrawConflict;
        }

        if (error.Message.Contains("schema", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.PhysicalDrawSchemaMismatch;
        }

        if (error.Message.Contains("timestamp", StringComparison.OrdinalIgnoreCase) ||
            error.Message.Contains("stale", StringComparison.OrdinalIgnoreCase) ||
            error.Message.Contains("future", StringComparison.OrdinalIgnoreCase))
        {
            return OutcomeRuntimeFailureCode.PhysicalDrawTimestampInvalid;
        }

        return OutcomeRuntimeFailureCode.PhysicalDrawIdentityMismatch;
    }
}

public sealed class SimulationTestOutcomeProviderRuntime : OutcomeProviderRuntimeShellBase
{
    public SimulationTestOutcomeProviderRuntime() : base(OutcomeProviderType.SimulationTest)
    {
    }
}

public sealed class OutcomeProviderOrchestrationService
{
    private readonly IOutcomeProviderResolver resolver;
    private readonly IOutcomeRuntimeRequestRepository requestRepository;
    private readonly IOutcomeRuntimeLockManager lockManager;
    private readonly OutcomeRuntimeRecoveryService recoveryService;
    private readonly IReadOnlyDictionary<OutcomeProviderType, IOutcomeProviderRuntime> runtimes;

    public OutcomeProviderOrchestrationService(
        IOutcomeProviderResolver resolver,
        IOutcomeRuntimeRequestRepository requestRepository,
        IOutcomeRuntimeLockManager lockManager,
        IEnumerable<IOutcomeProviderRuntime> runtimes,
        OutcomeRuntimeRecoveryService? recoveryService = null)
    {
        this.resolver = resolver;
        this.requestRepository = requestRepository;
        this.lockManager = lockManager;
        this.recoveryService = recoveryService ?? new OutcomeRuntimeRecoveryService(
            new InMemoryOutcomeRuntimeProvenanceRepository(),
            new EnvironmentOutcomeRuntimeCrashInjector());
        this.runtimes = runtimes.ToDictionary(runtime => runtime.ProviderType);
    }

    public async Task<OutcomeProviderRuntimeResult> ExecuteAsync(
        OutcomeProviderRuntimeRequest request,
        IReadOnlyCollection<OutcomeProviderDefinitionV1> availableProviders,
        CancellationToken cancellationToken)
    {
        var existing = await requestRepository.FindByIdempotencyKeyAsync(
            request.IdempotencyKey,
            request.DrawRequestScope,
            cancellationToken);

        if (existing is not null)
        {
            if (existing.CanonicalRequestHash != request.CanonicalRequestHash)
            {
                await recoveryService.AppendRecoveryEvidenceAsync(
                    OutcomeRuntimeRecoveryEventType.RollbackDetection,
                    request,
                    provider: null,
                    OutcomeRuntimeFailureCode.IdempotencyConflict.ToString(),
                    "Conflicting payload for the same runtime idempotency key.",
                    cancellationToken);
                throw new InvalidOperationException("Conflicting payload for the same runtime idempotency key.");
            }

            await recoveryService.AppendRecoveryEvidenceAsync(
                OutcomeRuntimeRecoveryEventType.RecoveredRuntime,
                request,
                provider: null,
                "IDEMPOTENT_REPLAY",
                "Completed runtime request was replayed idempotently without regeneration.",
                cancellationToken);
            return ToResult(existing, OutcomeRuntimeStatus.DuplicateReturned);
        }

        OutcomeProviderDefinitionV1 provider;
        try
        {
            provider = await resolver.ResolveAsync(request, availableProviders, cancellationToken);
        }
        catch (InvalidOperationException exception)
        {
            return await PersistFailClosedAsync(
                request,
                request.ManifestBinding?.ProviderId ?? "unresolved",
                request.ManifestBinding?.ProviderVersion ?? "unresolved",
                request.ExpectedProviderType,
                OutcomeRuntimeFailureCode.MissingProvider,
                exception.Message,
                lockAcquired: false,
                cancellationToken);
        }

        recoveryService.ThrowIfCrashPoint(OutcomeRuntimeCrashInjectionStage.ProviderValidation);
        if (!runtimes.TryGetValue(provider.ProviderType, out var runtime))
        {
            return await PersistFailClosedAsync(
                request,
                provider.ProviderId,
                provider.ProviderVersion,
                provider.ProviderType,
                OutcomeRuntimeFailureCode.RuntimeNotReady,
                "No runtime shell is registered for the resolved Outcome Provider type.",
                lockAcquired: false,
                cancellationToken);
        }

        var readiness = await runtime.ValidateProviderReadinessAsync(provider, cancellationToken);
        if (request.Mode == OutcomeRuntimeExecutionMode.Production && !readiness.IsReady)
        {
            return await PersistFailClosedAsync(
                request,
                provider.ProviderId,
                provider.ProviderVersion,
                provider.ProviderType,
                OutcomeRuntimeFailureCode.RuntimeNotReady,
                string.Join("; ", readiness.Blockers),
                lockAcquired: false,
                cancellationToken);
        }

        var lockScope = BuildLockScope(request);
        recoveryService.ThrowIfCrashPoint(OutcomeRuntimeCrashInjectionStage.LockAcquisition);
        var lease = await lockManager.TryAcquireAsync(lockScope, TimeSpan.FromSeconds(5), cancellationToken);
        if (!lease.Acquired)
        {
            return await PersistFailClosedAsync(
                request,
                provider.ProviderId,
                provider.ProviderVersion,
                provider.ProviderType,
                OutcomeRuntimeFailureCode.LockUnavailable,
                lease.FailureReason ?? "Outcome runtime lock was unavailable.",
                lockAcquired: false,
                cancellationToken);
        }

        try
        {
            var context = new OutcomeProviderRuntimeContext(request, provider);
            recoveryService.ThrowIfCrashPoint(OutcomeRuntimeCrashInjectionStage.ProviderExecution);
            OutcomeProviderRuntimeResult result;
            try
            {
                result = await runtime.CreateOutcomeAsync(context, cancellationToken);
            }
            catch (Exception error) when (error is InvalidOperationException or CryptographicException)
            {
                await recoveryService.AppendRecoveryEvidenceAsync(
                    OutcomeRuntimeRecoveryEventType.ProviderRecovery,
                    request,
                    provider,
                    OutcomeRuntimeFailureCode.RuntimeRecoveryRequired.ToString(),
                    error.Message,
                    cancellationToken);

                return await PersistFailClosedAsync(
                    request,
                    provider.ProviderId,
                    provider.ProviderVersion,
                    provider.ProviderType,
                    OutcomeRuntimeFailureCode.RuntimeRecoveryRequired,
                    error.Message,
                    lockAcquired: true,
                    cancellationToken);
            }

            recoveryService.ThrowIfCrashPoint(OutcomeRuntimeCrashInjectionStage.Completion);
            var stored = ToStored(result);
            var claim = await requestRepository.ClaimRequestAsync(stored, cancellationToken);
            if (claim.Duplicate)
            {
                await recoveryService.AppendRecoveryEvidenceAsync(
                    OutcomeRuntimeRecoveryEventType.RecoveredRuntime,
                    request,
                    provider,
                    "DUPLICATE_CLAIM",
                    "Runtime request claim returned existing immutable state without regeneration.",
                    cancellationToken);
                return ToResult(claim.Request, OutcomeRuntimeStatus.DuplicateReturned);
            }

            await recoveryService.RecordRequestProvenanceAsync(
                claim.Request.RuntimeRequestId,
                request,
                provider,
                cancellationToken);

            var attempt = await runtime.CreateEvidenceAsync(
                context,
                result.Status,
                result.FailureCode,
                result.FailureReason,
                lockAcquired: true,
                cancellationToken);
            await requestRepository.AppendAttemptAsync(attempt, cancellationToken);
            await recoveryService.RecordAttemptProvenanceAsync(attempt, request, provider, cancellationToken);

            if (result.Status is OutcomeRuntimeStatus.GenerationNotImplemented or OutcomeRuntimeStatus.ProductionDisabled)
            {
                await recoveryService.AppendRecoveryEvidenceAsync(
                    OutcomeRuntimeRecoveryEventType.ProviderRecovery,
                    request,
                    provider,
                    result.FailureCode.ToString(),
                    result.FailureReason,
                    cancellationToken);
            }

            return result;
        }
        finally
        {
            await lockManager.ReleaseAsync(lease, cancellationToken);
            recoveryService.ThrowIfCrashPoint(OutcomeRuntimeCrashInjectionStage.LockRelease);
        }
    }

    public static string BuildLockScope(OutcomeProviderRuntimeRequest request)
    {
        return request.ManifestBinding?.ProviderId is null
            ? $"outcome-runtime:{request.DrawRequestScope}"
            : $"outcome-runtime:{request.ManifestBinding.ProviderId}:{request.ManifestBinding.ProviderVersion}:{request.DrawRequestScope}";
    }

    public static string Canonicalize(IReadOnlyDictionary<string, object?> payload)
    {
        return string.Join(
            "|",
            payload.OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .Select(pair => $"{pair.Key}={pair.Value}"));
    }

    public static string HashCanonical(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private async Task<OutcomeProviderRuntimeResult> PersistFailClosedAsync(
        OutcomeProviderRuntimeRequest request,
        string providerId,
        string providerVersion,
        OutcomeProviderType providerType,
        OutcomeRuntimeFailureCode failureCode,
        string failureReason,
        bool lockAcquired,
        CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var stored = new OutcomeRuntimeStoredRequest(
            request.RuntimeRequestId,
            request.IdempotencyKey,
            request.DrawRequestScope,
            request.GameManifestId,
            request.GameManifestVersion,
            providerId,
            providerVersion,
            providerType,
            request.Mode,
            OutcomeRuntimeStatus.FailedClosed,
            failureCode,
            failureReason,
            request.CanonicalRequestHash,
            ResultReference: null,
            EvidenceReference: null,
            StartedAt: now,
            CompletedAt: now);

        var claim = await requestRepository.ClaimRequestAsync(stored, cancellationToken);
        if (claim.Duplicate)
        {
            await recoveryService.AppendRecoveryEvidenceAsync(
                OutcomeRuntimeRecoveryEventType.RecoveredRuntime,
                request,
                provider: null,
                "FAIL_CLOSED_REPLAY",
                "Failed-closed runtime request was replayed idempotently without regeneration.",
                cancellationToken);
            return ToResult(claim.Request, OutcomeRuntimeStatus.DuplicateReturned);
        }

        await recoveryService.AppendRecoveryEvidenceAsync(
            OutcomeRuntimeRecoveryEventType.RecoveryAttempt,
            request,
            provider: null,
            failureCode.ToString(),
            failureReason,
            cancellationToken);

        var attempt = new OutcomeRuntimeAttemptEvidence(
            Guid.NewGuid(),
            request.RuntimeRequestId,
            request.IdempotencyKey,
            request.DrawRequestScope,
            providerId,
            providerVersion,
            providerType,
            request.Mode,
            OutcomeRuntimeStatus.FailedClosed,
            failureCode,
            failureReason,
            BuildLockScope(request),
            lockAcquired,
            HashCanonical($"{request.IdempotencyKey}|{request.DrawRequestScope}|{failureCode}|{failureReason}|{lockAcquired}"),
            now,
            now);
        await requestRepository.AppendAttemptAsync(attempt, cancellationToken);

        return ToResult(stored);
    }

    private static OutcomeRuntimeStoredRequest ToStored(OutcomeProviderRuntimeResult result)
    {
        return new OutcomeRuntimeStoredRequest(
            result.RuntimeRequestId,
            result.IdempotencyKey,
            result.DrawRequestScope,
            result.GameManifestId,
            result.GameManifestVersion,
            result.ProviderId,
            result.ProviderVersion,
            result.ProviderType,
            result.Mode,
            result.Status,
            result.FailureCode,
            result.FailureReason,
            result.CanonicalRequestHash,
            result.ResultReference,
            result.EvidenceReference,
            result.StartedAt,
            result.CompletedAt);
    }

    private static OutcomeProviderRuntimeResult ToResult(
        OutcomeRuntimeStoredRequest stored,
        OutcomeRuntimeStatus? overrideStatus = null)
    {
        return new OutcomeProviderRuntimeResult(
            stored.RuntimeRequestId,
            stored.IdempotencyKey,
            stored.DrawRequestScope,
            stored.GameManifestId,
            stored.GameManifestVersion,
            stored.ProviderId,
            stored.ProviderVersion,
            stored.ProviderType,
            stored.Mode,
            overrideStatus ?? stored.Status,
            stored.FailureCode,
            stored.FailureReason,
            stored.CanonicalRequestHash,
            stored.ResultReference,
            stored.EvidenceReference,
            stored.StartedAt,
            stored.CompletedAt);
    }
}

public sealed class InMemoryOutcomeRuntimeRequestRepository : IOutcomeRuntimeRequestRepository
{
    private readonly List<OutcomeRuntimeStoredRequest> requests = [];
    private readonly List<OutcomeRuntimeAttemptEvidence> attempts = [];

    public IReadOnlyCollection<OutcomeRuntimeStoredRequest> Requests => requests;

    public IReadOnlyCollection<OutcomeRuntimeAttemptEvidence> Attempts => attempts;

    public Task<OutcomeRuntimeStoredRequest?> FindByIdempotencyKeyAsync(
        string idempotencyKey,
        string drawRequestScope,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(requests.LastOrDefault(request =>
            request.IdempotencyKey == idempotencyKey &&
            request.DrawRequestScope == drawRequestScope));
    }

    public Task<OutcomeRuntimeStoredRequest> AppendRequestAsync(
        OutcomeRuntimeStoredRequest request,
        CancellationToken cancellationToken)
    {
        return AppendRequestCoreAsync(request, cancellationToken);
    }

    private async Task<OutcomeRuntimeStoredRequest> AppendRequestCoreAsync(
        OutcomeRuntimeStoredRequest request,
        CancellationToken cancellationToken)
    {
        return (await ClaimRequestAsync(request, cancellationToken)).Request;
    }

    public Task<OutcomeRuntimeRequestClaim> ClaimRequestAsync(
        OutcomeRuntimeStoredRequest request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var existing = requests.LastOrDefault(existing =>
            existing.IdempotencyKey == request.IdempotencyKey &&
            existing.DrawRequestScope == request.DrawRequestScope);

        if (existing is not null)
        {
            if (existing.CanonicalRequestHash != request.CanonicalRequestHash)
            {
                throw new InvalidOperationException("Conflicting payload for the same runtime idempotency key.");
            }

            return Task.FromResult(new OutcomeRuntimeRequestClaim(existing, Created: false, Duplicate: true));
        }

        requests.Add(request);
        return Task.FromResult(new OutcomeRuntimeRequestClaim(request, Created: true, Duplicate: false));
    }

    public Task AppendAttemptAsync(
        OutcomeRuntimeAttemptEvidence attempt,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        attempts.Add(attempt);
        return Task.CompletedTask;
    }

    public Task<OutcomeRuntimePersistenceReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new OutcomeRuntimePersistenceReadiness(
            DurablePersistenceConfigured: false,
            DurablePersistenceReachable: false,
            IdempotencyRepositoryReady: true,
            RuntimeAttemptsRepositoryReady: true,
            ProductionGenerationDisabled: true,
            Blockers: ["Outcome runtime persistence is using non-production in-memory storage."]));
    }
}

public sealed class InMemoryOutcomeRuntimeLockManager : IOutcomeRuntimeLockManager
{
    private readonly HashSet<string> heldLocks = new(StringComparer.Ordinal);

    public void Hold(string lockScope)
    {
        heldLocks.Add(lockScope);
    }

    public Task<OutcomeRuntimeLockLease> TryAcquireAsync(
        string lockScope,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!heldLocks.Add(lockScope))
        {
            return Task.FromResult(new OutcomeRuntimeLockLease(lockScope, Acquired: false, "Outcome runtime lock is already held."));
        }

        return Task.FromResult(new OutcomeRuntimeLockLease(lockScope, Acquired: true, FailureReason: null));
    }

    public Task ReleaseAsync(
        OutcomeRuntimeLockLease lease,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (lease.Acquired)
        {
            heldLocks.Remove(lease.LockScope);
        }

        return Task.CompletedTask;
    }

    public Task<OutcomeRuntimeLockingReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new OutcomeRuntimeLockingReadiness(
            AdvisoryLockingConfigured: false,
            AdvisoryLockingReachable: false,
            RedisLockDependencyAbsent: true,
            Blockers: ["Outcome runtime locking is using non-production in-memory coordination."]));
    }
}
