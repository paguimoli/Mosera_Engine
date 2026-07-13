using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public enum ProvablyFairRuntimeRevealStatus
{
    NotEligible,
    Eligible,
    Verified,
    Failed
}

public sealed record ProvablyFairProtectedServerSeed(
    Guid SeedId,
    string ProviderId,
    string ProviderVersion,
    string Scope,
    byte[] ProtectedSeedMaterial,
    string CommitmentHash,
    DateTimeOffset GeneratedAt,
    DateTimeOffset ActivatedAt,
    bool Revealed,
    bool Retired);

public sealed record ProvablyFairNonceAllocation(
    Guid Id,
    string ProviderId,
    string ProviderVersion,
    string ProviderScope,
    ProvablyFairNonceScopeType ScopeType,
    long Nonce,
    string UniquenessScope,
    string ContentHash,
    DateTimeOffset AllocatedAt);

public sealed record ProvablyFairRuntimeReceipt(
    Guid ReceiptId,
    string WagerReference,
    Guid OutcomeCertificateId,
    string OutcomeCertificateHash,
    string ProviderId,
    string ProviderVersion,
    string ServerCommitment,
    string CanonicalClientSeed,
    long Nonce,
    ProvablyFairVerificationAlgorithm VerificationAlgorithm,
    string CanonicalVerificationPayload,
    string ResultingOutcomeHash,
    ProvablyFairVerificationStatus VerificationStatus,
    ProvablyFairRevealState RevealState,
    string ReceiptHash,
    DateTimeOffset IssuedAt);

public sealed record ProvablyFairRevealEvidence(
    Guid RevealId,
    Guid SeedId,
    string ProviderId,
    string ProviderVersion,
    string Scope,
    string ServerSeedHash,
    string CommitmentHash,
    ProvablyFairRuntimeRevealStatus RevealStatus,
    string CanonicalEvidenceHash,
    DateTimeOffset RevealedAt);

public sealed record ProvablyFairReceiptVerificationResult(
    Guid VerificationId,
    Guid ReceiptId,
    string ReceiptHash,
    string RecomputedCommitmentHash,
    string RecomputedOutcomeHash,
    ProvablyFairRuntimeRevealStatus Status,
    string? FailureReason,
    string CanonicalResultHash,
    DateTimeOffset VerifiedAt);

public sealed record ProvablyFairRuntimeReadiness(
    bool SecureSeedCustodyConfigured,
    bool CommitmentPublicationReady,
    bool NonceAllocatorDurable,
    bool HmacDerivationReady,
    bool ReceiptGenerationReady,
    bool RevealVerificationReady,
    bool ProductionGenerationDisabled,
    IReadOnlyCollection<string> Blockers)
{
    public bool IsReady => Blockers.Count == 0;
}

public interface IProvablyFairClientSeedService
{
    string Canonicalize(string? clientSeed, ProvablyFairClientSeedPolicy policy);
}

public interface IProvablyFairSeedCustodyRepository
{
    Task<ProvablyFairProtectedServerSeed> GetOrCreateActiveSeedAsync(
        string providerId,
        string providerVersion,
        string scope,
        ProvablyFairHashAlgorithm hashAlgorithm,
        CancellationToken cancellationToken);

    Task<ProvablyFairRevealEvidence> RevealAsync(
        ProvablyFairProtectedServerSeed seed,
        bool eligible,
        CancellationToken cancellationToken);

    Task<bool> CheckReadinessAsync(CancellationToken cancellationToken);
}

public interface IProvablyFairNonceAllocator
{
    Task<ProvablyFairNonceAllocation> AllocateAsync(
        string providerId,
        string providerVersion,
        string providerScope,
        ProvablyFairNonceScopeType scopeType,
        string uniquenessScope,
        CancellationToken cancellationToken);

    Task<bool> CheckReadinessAsync(CancellationToken cancellationToken);
}

public interface IProvablyFairRuntimeEvidenceRepository
{
    Task AppendCommitmentAsync(
        ProvablyFairProtectedServerSeed seed,
        CancellationToken cancellationToken);

    Task AppendReceiptAsync(
        ProvablyFairRuntimeReceipt receipt,
        CancellationToken cancellationToken);

    Task AppendRevealEvidenceAsync(
        ProvablyFairRevealEvidence evidence,
        CancellationToken cancellationToken);

    Task AppendVerificationResultAsync(
        ProvablyFairReceiptVerificationResult result,
        CancellationToken cancellationToken);

    Task<bool> CheckReadinessAsync(CancellationToken cancellationToken);
}

public sealed class ProvablyFairClientSeedService : IProvablyFairClientSeedService
{
    public string Canonicalize(string? clientSeed, ProvablyFairClientSeedPolicy policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        var value = clientSeed ?? string.Empty;
        if (policy.Required && string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException("Client seed is required by provider policy.");
        }

        foreach (var rule in policy.CanonicalizationRules)
        {
            value = rule.ToLowerInvariant() switch
            {
                "trim" => value.Trim(),
                "lowercase" => value.ToLowerInvariant(),
                "empty-to-default" when string.IsNullOrEmpty(value) => "mosera-default-client-seed",
                _ => value
            };
        }

        if (value.Length > policy.MaximumLength)
        {
            throw new InvalidOperationException("Client seed exceeds provider policy maximum length.");
        }

        _ = policy.AllowedEncoding switch
        {
            ProvablyFairEncoding.Utf8 => Encoding.UTF8.GetBytes(value),
            ProvablyFairEncoding.Base64Url => DecodeBase64Url(value),
            ProvablyFairEncoding.Hex => Convert.FromHexString(value),
            _ => throw new InvalidOperationException("Unsupported client seed encoding.")
        };

        if (policy.Required && string.IsNullOrEmpty(value))
        {
            throw new InvalidOperationException("Canonical client seed cannot be empty when required.");
        }

        return value;
    }

    private static byte[] DecodeBase64Url(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + ((4 - (padded.Length % 4)) % 4), '=');
        return Convert.FromBase64String(padded);
    }
}

public sealed class InMemoryProvablyFairSeedCustodyRepository(IOsEntropyProvider entropyProvider) : IProvablyFairSeedCustodyRepository
{
    private readonly Dictionary<string, ProvablyFairProtectedServerSeed> activeSeeds = new(StringComparer.Ordinal);
    private readonly List<ProvablyFairRevealEvidence> reveals = [];

    public IReadOnlyCollection<ProvablyFairRevealEvidence> Reveals => reveals;

    public Task<ProvablyFairProtectedServerSeed> GetOrCreateActiveSeedAsync(
        string providerId,
        string providerVersion,
        string scope,
        ProvablyFairHashAlgorithm hashAlgorithm,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var key = $"{providerId}|{providerVersion}|{scope}";
        if (activeSeeds.TryGetValue(key, out var existing))
        {
            return Task.FromResult(existing);
        }

        var seedMaterial = new byte[32];
        entropyProvider.Fill(seedMaterial);
        var now = DateTimeOffset.UtcNow;
        var seedId = DeterministicGuid($"{key}|{HashBytes(seedMaterial, hashAlgorithm)}");
        var commitment = CreateCommitment(seedMaterial, providerId, providerVersion, seedId, scope, hashAlgorithm);
        var seed = new ProvablyFairProtectedServerSeed(
            seedId,
            providerId,
            providerVersion,
            scope,
            seedMaterial,
            commitment,
            now,
            now,
            Revealed: false,
            Retired: false);
        activeSeeds.Add(key, seed);
        return Task.FromResult(seed);
    }

    public Task<ProvablyFairRevealEvidence> RevealAsync(
        ProvablyFairProtectedServerSeed seed,
        bool eligible,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var now = DateTimeOffset.UtcNow;
        var serverSeedHash = HashBytes(seed.ProtectedSeedMaterial, ProvablyFairHashAlgorithm.Sha256);
        var status = eligible ? ProvablyFairRuntimeRevealStatus.Verified : ProvablyFairRuntimeRevealStatus.NotEligible;
        var canonicalHash = HashCanonical($"{seed.SeedId:N}|{seed.CommitmentHash}|{serverSeedHash}|{status}|{now:O}");
        var evidence = new ProvablyFairRevealEvidence(
            Guid.NewGuid(),
            seed.SeedId,
            seed.ProviderId,
            seed.ProviderVersion,
            seed.Scope,
            serverSeedHash,
            seed.CommitmentHash,
            status,
            canonicalHash,
            now);
        reveals.Add(evidence);
        return Task.FromResult(evidence);
    }

    public Task<bool> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(entropyProvider.CheckReadiness().Ready);
    }

    public static string CreateCommitment(
        ReadOnlySpan<byte> serverSeed,
        string providerId,
        string providerVersion,
        Guid seedId,
        string scope,
        ProvablyFairHashAlgorithm hashAlgorithm)
    {
        var prefix = Encoding.UTF8.GetBytes($"mosera-provably-fair-commitment-v1|{providerId}|{providerVersion}|{seedId:N}|{scope}|");
        var payload = new byte[prefix.Length + serverSeed.Length];
        try
        {
            prefix.CopyTo(payload);
            serverSeed.CopyTo(payload.AsSpan(prefix.Length));
            return HashBytes(payload, hashAlgorithm);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload);
            CryptographicOperations.ZeroMemory(prefix);
        }
    }

    private static Guid DeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes.Take(16).ToArray());
    }

    private static string HashCanonical(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private static string HashBytes(ReadOnlySpan<byte> bytes, ProvablyFairHashAlgorithm hashAlgorithm)
    {
        var hash = hashAlgorithm switch
        {
            ProvablyFairHashAlgorithm.Sha256 => SHA256.HashData(bytes),
            ProvablyFairHashAlgorithm.Sha384 => SHA384.HashData(bytes),
            ProvablyFairHashAlgorithm.Sha512 => SHA512.HashData(bytes),
            _ => throw new ArgumentOutOfRangeException(nameof(hashAlgorithm), hashAlgorithm, "Unsupported Provably Fair hash algorithm.")
        };
        return hashAlgorithm switch
        {
            ProvablyFairHashAlgorithm.Sha256 => $"sha256:{Convert.ToHexString(hash).ToLowerInvariant()}",
            ProvablyFairHashAlgorithm.Sha384 => $"sha384:{Convert.ToHexString(hash).ToLowerInvariant()}",
            ProvablyFairHashAlgorithm.Sha512 => $"sha512:{Convert.ToHexString(hash).ToLowerInvariant()}",
            _ => throw new ArgumentOutOfRangeException(nameof(hashAlgorithm))
        };
    }
}

public sealed class InMemoryProvablyFairNonceAllocator : IProvablyFairNonceAllocator
{
    private readonly Dictionary<string, long> counters = new(StringComparer.Ordinal);
    private readonly List<ProvablyFairNonceAllocation> allocations = [];

    public IReadOnlyCollection<ProvablyFairNonceAllocation> Allocations => allocations;

    public Task<ProvablyFairNonceAllocation> AllocateAsync(
        string providerId,
        string providerVersion,
        string providerScope,
        ProvablyFairNonceScopeType scopeType,
        string uniquenessScope,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var key = $"{providerId}|{providerVersion}|{providerScope}|{scopeType}|{uniquenessScope}";
        var next = counters.TryGetValue(key, out var current) ? current + 1 : 1;
        counters[key] = next;
        var contentHash = OutcomeProviderOrchestrationService.HashCanonical($"{key}|{next}");
        var allocation = new ProvablyFairNonceAllocation(
            Guid.NewGuid(),
            providerId,
            providerVersion,
            providerScope,
            scopeType,
            next,
            uniquenessScope,
            contentHash,
            DateTimeOffset.UtcNow);
        allocations.Add(allocation);
        return Task.FromResult(allocation);
    }

    public Task<bool> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(false);
    }
}

public sealed class InMemoryProvablyFairRuntimeEvidenceRepository : IProvablyFairRuntimeEvidenceRepository
{
    private readonly List<string> commitments = [];
    private readonly List<ProvablyFairRuntimeReceipt> receipts = [];
    private readonly List<ProvablyFairRevealEvidence> reveals = [];
    private readonly List<ProvablyFairReceiptVerificationResult> verificationResults = [];

    public IReadOnlyCollection<ProvablyFairRuntimeReceipt> Receipts => receipts;

    public Task AppendCommitmentAsync(
        ProvablyFairProtectedServerSeed seed,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!commitments.Contains(seed.CommitmentHash, StringComparer.Ordinal))
        {
            commitments.Add(seed.CommitmentHash);
        }

        return Task.CompletedTask;
    }

    public Task AppendReceiptAsync(
        ProvablyFairRuntimeReceipt receipt,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (receipts.All(existing => existing.ReceiptHash != receipt.ReceiptHash))
        {
            receipts.Add(receipt);
        }

        return Task.CompletedTask;
    }

    public Task AppendRevealEvidenceAsync(
        ProvablyFairRevealEvidence evidence,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (reveals.All(existing => existing.CanonicalEvidenceHash != evidence.CanonicalEvidenceHash))
        {
            reveals.Add(evidence);
        }

        return Task.CompletedTask;
    }

    public Task AppendVerificationResultAsync(
        ProvablyFairReceiptVerificationResult result,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (verificationResults.All(existing => existing.CanonicalResultHash != result.CanonicalResultHash))
        {
            verificationResults.Add(result);
        }

        return Task.CompletedTask;
    }

    public Task<bool> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(false);
    }
}

public sealed class ProvablyFairRuntimeService(
    IProvablyFairSeedCustodyRepository seedCustody,
    IProvablyFairNonceAllocator nonceAllocator,
    IProvablyFairRuntimeEvidenceRepository evidenceRepository,
    IProvablyFairClientSeedService clientSeedService)
{
    public async Task<ProvablyFairRuntimeReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        var custodyReady = await seedCustody.CheckReadinessAsync(cancellationToken);
        var nonceReady = await nonceAllocator.CheckReadinessAsync(cancellationToken);
        var evidenceReady = await evidenceRepository.CheckReadinessAsync(cancellationToken);

        if (!custodyReady)
        {
            blockers.Add("Secure persistent server seed custody is not production-ready; dry-run/internal runtime only.");
        }

        if (!nonceReady)
        {
            blockers.Add("Durable Provably Fair nonce allocator is not ready.");
        }

        if (!evidenceReady)
        {
            blockers.Add("Provably Fair runtime evidence persistence is not ready.");
        }

        blockers.Add("Production Provably Fair outcome generation remains disabled.");

        return new ProvablyFairRuntimeReadiness(
            SecureSeedCustodyConfigured: custodyReady,
            CommitmentPublicationReady: evidenceReady,
            NonceAllocatorDurable: nonceReady,
            HmacDerivationReady: true,
            ReceiptGenerationReady: evidenceReady,
            RevealVerificationReady: evidenceReady,
            ProductionGenerationDisabled: true,
            Blockers: blockers);
    }

    public async Task<(OutcomeCertificate Certificate, ProvablyFairRuntimeReceipt Receipt, IReadOnlyDictionary<string, object?> OutcomePayload)> GenerateAsync(
        OutcomeProviderRuntimeContext context,
        CancellationToken cancellationToken)
    {
        if (context.Request.Mode == OutcomeRuntimeExecutionMode.Production)
        {
            throw new InvalidOperationException("Production Outcome Authority remains disabled.");
        }

        var policy = CreateClientSeedPolicy(context.Provider);
        var clientSeed = clientSeedService.Canonicalize(context.Request.CanonicalRequestHash, policy);
        var hashAlgorithm = ResolveHashAlgorithm(context.Provider);
        var verificationAlgorithm = ResolveVerificationAlgorithm(hashAlgorithm);
        var seed = await seedCustody.GetOrCreateActiveSeedAsync(
            context.Provider.ProviderId,
            context.Provider.ProviderVersion,
            context.Request.DrawRequestScope,
            hashAlgorithm,
            cancellationToken);

        await evidenceRepository.AppendCommitmentAsync(seed, cancellationToken);

        var allocation = await nonceAllocator.AllocateAsync(
            context.Provider.ProviderId,
            context.Provider.ProviderVersion,
            context.Request.DrawRequestScope,
            ProvablyFairNonceScopeType.Wager,
            "provider-wager",
            cancellationToken);

        var derivationInput = CanonicalDerivationInput(
            context,
            seed,
            clientSeed,
            allocation.Nonce);
        var derived = Hmac(seed.ProtectedSeedMaterial, derivationInput, verificationAlgorithm);
        try
        {
            var outcomePayload = GenerateOutcomePayload(context, derived);
            var canonicalOutcome = OutcomeProviderOrchestrationService.Canonicalize(outcomePayload);
            var outcomeHash = OutcomeProviderOrchestrationService.HashCanonical(canonicalOutcome);
            var certificate = CreateCertificate(context, outcomeHash, seed.CommitmentHash);
            var receipt = CreateReceipt(
                context,
                certificate,
                seed,
                clientSeed,
                allocation.Nonce,
                verificationAlgorithm,
                derivationInput,
                outcomeHash);

            await evidenceRepository.AppendReceiptAsync(receipt, cancellationToken);
            return (certificate, receipt, outcomePayload);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(derived);
        }
    }

    public async Task<ProvablyFairRevealEvidence> RevealAsync(
        ProvablyFairProtectedServerSeed seed,
        bool eligible,
        CancellationToken cancellationToken)
    {
        var evidence = await seedCustody.RevealAsync(seed, eligible, cancellationToken);
        await evidenceRepository.AppendRevealEvidenceAsync(evidence, cancellationToken);
        return evidence;
    }

    public async Task<ProvablyFairReceiptVerificationResult> VerifyRevealedReceiptAsync(
        ProvablyFairRuntimeReceipt receipt,
        byte[] revealedServerSeed,
        CancellationToken cancellationToken)
    {
        using var payload = JsonDocument.Parse(receipt.CanonicalVerificationPayload);
        var root = payload.RootElement;
        var seedId = root.GetProperty("seedId").GetGuid();
        var scope = root.GetProperty("scope").GetString() ?? receipt.WagerReference;
        var recomputedCommitment = InMemoryProvablyFairSeedCustodyRepository.CreateCommitment(
            revealedServerSeed,
            receipt.ProviderId,
            receipt.ProviderVersion,
            seedId,
            scope,
            ProvablyFairHashAlgorithm.Sha256);
        var status = CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(recomputedCommitment),
            Encoding.UTF8.GetBytes(receipt.ServerCommitment))
            ? ProvablyFairRuntimeRevealStatus.Verified
            : ProvablyFairRuntimeRevealStatus.Failed;
        var failure = status == ProvablyFairRuntimeRevealStatus.Verified ? null : "Commitment recomputation failed.";
        var resultHash = OutcomeProviderOrchestrationService.HashCanonical(
            $"{receipt.ReceiptHash}|{recomputedCommitment}|{receipt.ResultingOutcomeHash}|{status}");
        var result = new ProvablyFairReceiptVerificationResult(
            Guid.NewGuid(),
            receipt.ReceiptId,
            receipt.ReceiptHash,
            recomputedCommitment,
            receipt.ResultingOutcomeHash,
            status,
            failure,
            resultHash,
            DateTimeOffset.UtcNow);
        await evidenceRepository.AppendVerificationResultAsync(result, cancellationToken);
        return result;
    }

    private static ProvablyFairClientSeedPolicy CreateClientSeedPolicy(OutcomeProviderDefinitionV1 provider)
    {
        var required = provider.CapabilityMarkers.SupportsPlayerVerificationReceipt;
        return new ProvablyFairClientSeedPolicy(
            required,
            256,
            ProvablyFairEncoding.Utf8,
            ["max-length"],
            ["trim"]);
    }

    private static ProvablyFairHashAlgorithm ResolveHashAlgorithm(OutcomeProviderDefinitionV1 provider)
    {
        if (provider.SigningRequirements.TryGetValue("verificationAlgorithm", out var algorithm) &&
            algorithm?.ToString()?.Contains("512", StringComparison.OrdinalIgnoreCase) == true)
        {
            return ProvablyFairHashAlgorithm.Sha512;
        }

        if (provider.SigningRequirements.TryGetValue("verificationAlgorithm", out algorithm) &&
            algorithm?.ToString()?.Contains("384", StringComparison.OrdinalIgnoreCase) == true)
        {
            return ProvablyFairHashAlgorithm.Sha384;
        }

        return ProvablyFairHashAlgorithm.Sha256;
    }

    private static ProvablyFairVerificationAlgorithm ResolveVerificationAlgorithm(ProvablyFairHashAlgorithm hashAlgorithm)
    {
        return hashAlgorithm switch
        {
            ProvablyFairHashAlgorithm.Sha256 => ProvablyFairVerificationAlgorithm.HmacSha256,
            ProvablyFairHashAlgorithm.Sha384 => ProvablyFairVerificationAlgorithm.HmacSha384,
            ProvablyFairHashAlgorithm.Sha512 => ProvablyFairVerificationAlgorithm.HmacSha512,
            _ => throw new ArgumentOutOfRangeException(nameof(hashAlgorithm), hashAlgorithm, "Unsupported hash algorithm.")
        };
    }

    private static byte[] CanonicalDerivationInput(
        OutcomeProviderRuntimeContext context,
        ProvablyFairProtectedServerSeed seed,
        string clientSeed,
        long nonce)
    {
        return Encoding.UTF8.GetBytes(string.Join(
            "|",
            "mosera-provably-fair-derivation-v1",
            context.Provider.ProviderId,
            context.Provider.ProviderVersion,
            seed.SeedId,
            seed.CommitmentHash,
            clientSeed,
            nonce,
            context.Request.GameManifestId,
            context.Request.GameManifestVersion,
            string.Join(",", context.Request.RequiredPrimitives.OrderBy(item => item.ToString(), StringComparer.Ordinal)),
            context.Request.DrawRequestScope));
    }

    private static byte[] Hmac(
        byte[] key,
        byte[] payload,
        ProvablyFairVerificationAlgorithm algorithm)
    {
        using HMAC hmac = algorithm switch
        {
            ProvablyFairVerificationAlgorithm.HmacSha256 => new HMACSHA256(key),
            ProvablyFairVerificationAlgorithm.HmacSha384 => new HMACSHA384(key),
            ProvablyFairVerificationAlgorithm.HmacSha512 => new HMACSHA512(key),
            _ => throw new ArgumentOutOfRangeException(nameof(algorithm), algorithm, "Unsupported Provably Fair verification algorithm.")
        };

        return hmac.ComputeHash(payload);
    }

    private static IReadOnlyDictionary<string, object?> GenerateOutcomePayload(
        OutcomeProviderRuntimeContext context,
        byte[] derived)
    {
        var cursor = 0;
        var numbers = context.Request.RequiredPrimitives.Contains(OutcomePrimitiveType.UniqueNumberSet)
            ? UniqueNumbers(derived, ref cursor, 1, 90, 5)
            : [NextInt32(derived, ref cursor, 0, 9)];
        return new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["drawRequestScope"] = context.Request.DrawRequestScope,
            ["provider"] = context.Provider.ProviderId,
            ["resultNumbers"] = string.Join(",", numbers),
            ["runtime"] = "provably-fair"
        };
    }

    private static IReadOnlyList<int> UniqueNumbers(byte[] source, ref int cursor, int minInclusive, int maxInclusive, int count)
    {
        var values = Enumerable.Range(minInclusive, maxInclusive - minInclusive + 1).ToArray();
        for (var index = 0; index < count; index++)
        {
            var selected = NextInt32(source, ref cursor, index, values.Length - 1);
            (values[index], values[selected]) = (values[selected], values[index]);
        }

        return values.Take(count).ToArray();
    }

    private static int NextInt32(byte[] source, ref int cursor, int minInclusive, int maxInclusive)
    {
        var range = (ulong)(maxInclusive - minInclusive + 1);
        var threshold = (0UL - range) % range;
        while (true)
        {
            if (cursor + sizeof(ulong) > source.Length)
            {
                var expanded = SHA512.HashData(source);
                Buffer.BlockCopy(expanded, 0, source, 0, Math.Min(expanded.Length, source.Length));
                cursor = 0;
            }

            var value = BitConverter.ToUInt64(source, cursor);
            cursor += sizeof(ulong);
            if (value >= threshold)
            {
                return minInclusive + (int)(value % range);
            }
        }
    }

    private static OutcomeCertificate CreateCertificate(
        OutcomeProviderRuntimeContext context,
        string outcomeHash,
        string evidenceHash)
    {
        var certificateId = DeterministicGuid($"{context.Request.IdempotencyKey}|provably-fair-certificate|{outcomeHash}");
        var outcomeId = DeterministicGuid($"{context.Request.IdempotencyKey}|provably-fair-outcome|{outcomeHash}");
        return new OutcomeCertificate(
            certificateId,
            outcomeId,
            DeterministicGuid(context.Request.DrawRequestScope),
            context.Request.RequiredPrimitives.FirstOrDefault().ToString(),
            context.Request.GameManifestVersion,
            context.Provider.ProviderId,
            context.Provider.ProviderVersion,
            outcomeHash,
            evidenceHash,
            [],
            SigningMetadata: null,
            OutcomeCustodyState.Generated,
            DateTimeOffset.UtcNow);
    }

    private static ProvablyFairRuntimeReceipt CreateReceipt(
        OutcomeProviderRuntimeContext context,
        OutcomeCertificate certificate,
        ProvablyFairProtectedServerSeed seed,
        string clientSeed,
        long nonce,
        ProvablyFairVerificationAlgorithm algorithm,
        byte[] derivationInput,
        string outcomeHash)
    {
        var payload = JsonSerializer.Serialize(new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["algorithm"] = algorithm.ToString(),
            ["clientSeed"] = clientSeed,
            ["commitment"] = seed.CommitmentHash,
            ["derivationInputHash"] = OutcomeProviderOrchestrationService.HashCanonical(Convert.ToHexString(derivationInput)),
            ["nonce"] = nonce,
            ["providerId"] = context.Provider.ProviderId,
            ["providerVersion"] = context.Provider.ProviderVersion,
            ["scope"] = seed.Scope,
            ["seedId"] = seed.SeedId,
            ["wagerReference"] = context.Request.DrawRequestScope
        });
        var receiptHash = OutcomeProviderOrchestrationService.HashCanonical($"{payload}|{outcomeHash}");
        return new ProvablyFairRuntimeReceipt(
            DeterministicGuid(receiptHash),
            context.Request.DrawRequestScope,
            certificate.CertificateId,
            certificate.CanonicalOutcomeHash,
            context.Provider.ProviderId,
            context.Provider.ProviderVersion,
            seed.CommitmentHash,
            clientSeed,
            nonce,
            algorithm,
            payload,
            outcomeHash,
            ProvablyFairVerificationStatus.PendingReveal,
            ProvablyFairRevealState.NotEligible,
            receiptHash,
            DateTimeOffset.UtcNow);
    }

    private static Guid DeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes.Take(16).ToArray());
    }
}
