using System.Security.Cryptography;
using GameEngine.Domain.Model;
using GameEngine.Domain.Randomness;

namespace GameEngine.Application.Services;

public sealed class SecureRandomnessProvider : IProductionPrngProvider
{
    public RandomnessProviderMetadata GetProviderMetadata()
    {
        return new RandomnessProviderMetadata(
            "secure-rng-placeholder",
            "Secure RNG Infrastructure Placeholder",
            RandomnessProviderType.ProductionPrng,
            GetVersion(),
            ProductionRngImplemented: false,
            Deterministic: false,
            "RandomNumberGenerator abstraction only; not approved as a production game RNG.");
    }

    public string GetVersion() => "0.0.0-framework";

    public IReadOnlyCollection<RandomnessCapability> GetCapabilities()
    {
        return
        [
            RandomnessCapability.GenerateRandomBytes,
            RandomnessCapability.GenerateBoundedInteger,
            RandomnessCapability.CryptographicProvider,
            RandomnessCapability.CertificationEvidence
        ];
    }

    public RandomnessProviderHealth HealthCheck()
    {
        return new RandomnessProviderHealth(
            RandomnessProviderHealthStatus.Warning,
            ["Provider is available as infrastructure but is not certified for production game draws."],
            DateTimeOffset.UtcNow);
    }

    public byte[] GenerateRandomBytes(int length)
    {
        if (length <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(length), "Length must be positive.");
        }

        return RandomNumberGenerator.GetBytes(length);
    }

    public int GenerateBoundedInteger(int minimumInclusive, int maximumExclusive)
    {
        if (maximumExclusive <= minimumInclusive)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumExclusive), "Maximum must be greater than minimum.");
        }

        return RandomNumberGenerator.GetInt32(minimumInclusive, maximumExclusive);
    }
}

public sealed class DeterministicTestRandomnessProvider : ITestPrngProvider
{
    private readonly int initialSeed;
    private Random random;

    public DeterministicTestRandomnessProvider(int seed = 226)
    {
        initialSeed = seed;
        random = new Random(seed);
    }

    public RandomnessProviderMetadata GetProviderMetadata()
    {
        return new RandomnessProviderMetadata(
            "deterministic-test-prng",
            "Deterministic Test PRNG",
            RandomnessProviderType.TestPrng,
            GetVersion(),
            ProductionRngImplemented: false,
            Deterministic: true,
            "Seed-based deterministic test provider; never valid for production game draws.");
    }

    public string GetVersion() => "0.0.0-test-framework";

    public IReadOnlyCollection<RandomnessCapability> GetCapabilities()
    {
        return
        [
            RandomnessCapability.GenerateRandomBytes,
            RandomnessCapability.GenerateBoundedInteger,
            RandomnessCapability.DeterministicSeed,
            RandomnessCapability.CertificationEvidence
        ];
    }

    public RandomnessProviderHealth HealthCheck()
    {
        return new RandomnessProviderHealth(
            RandomnessProviderHealthStatus.Healthy,
            ["Deterministic test provider is available for repeatable certification harnesses."],
            DateTimeOffset.UtcNow);
    }

    public byte[] GenerateRandomBytes(int length)
    {
        if (length <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(length), "Length must be positive.");
        }

        var bytes = new byte[length];
        random.NextBytes(bytes);
        return bytes;
    }

    public int GenerateBoundedInteger(int minimumInclusive, int maximumExclusive)
    {
        if (maximumExclusive <= minimumInclusive)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumExclusive), "Maximum must be greater than minimum.");
        }

        return random.Next(minimumInclusive, maximumExclusive);
    }

    public void ResetSeed(int seed)
    {
        random = new Random(seed);
    }

    public void Reset() => ResetSeed(initialSeed);
}

public sealed class RandomnessRegistry
{
    private readonly IReadOnlyCollection<IRandomnessProvider> providers;

    public RandomnessRegistry()
    {
        providers =
        [
            new SecureRandomnessProvider(),
            new DeterministicTestRandomnessProvider()
        ];
    }

    public IReadOnlyCollection<RandomnessProviderDiagnostic> GetProviders()
    {
        return providers.Select(provider => new RandomnessProviderDiagnostic(
            provider.GetProviderMetadata(),
            provider.GetCapabilities(),
            provider.HealthCheck())).ToArray();
    }

    public IRandomnessProvider GetProvider(string providerId)
    {
        return providers.Single(provider => provider.GetProviderMetadata().ProviderId == providerId);
    }

    public object GetStatus()
    {
        var diagnostics = GetProviders();
        return new
        {
            status = "WARNING",
            providerCount = diagnostics.Count,
            productionProviderCount = diagnostics.Count(provider => provider.Metadata.ProviderType == RandomnessProviderType.ProductionPrng),
            testProviderCount = diagnostics.Count(provider => provider.Metadata.ProviderType == RandomnessProviderType.TestPrng),
            productionRngImplemented = diagnostics.Any(provider => provider.Metadata.ProductionRngImplemented),
            warnings = new[]
            {
                "Production RNG is an infrastructure placeholder only.",
                "Deterministic test PRNG must never be used for production game draws."
            },
            generatedAt = DateTimeOffset.UtcNow
        };
    }
}
