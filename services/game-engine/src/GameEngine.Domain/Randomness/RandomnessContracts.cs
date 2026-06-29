using GameEngine.Domain.Model;

namespace GameEngine.Domain.Randomness;

public interface IRandomnessProvider
{
    RandomnessProviderMetadata GetProviderMetadata();

    string GetVersion();

    IReadOnlyCollection<RandomnessCapability> GetCapabilities();

    RandomnessProviderHealth HealthCheck();

    byte[] GenerateRandomBytes(int length);

    int GenerateBoundedInteger(int minimumInclusive, int maximumExclusive);
}

public interface IProductionPrngProvider : IRandomnessProvider
{
}

public interface ITestPrngProvider : IRandomnessProvider
{
    void ResetSeed(int seed);
}

public interface IRandomnessHealthCheck
{
    RandomnessProviderHealth Check(IRandomnessProvider provider);
}

public interface IRandomnessStatisticsProvider
{
    StatisticalFrameworkStatus GetStatisticsStatus();
}

public interface IDrawSamplingFramework
{
    DrawSamplingDiagnostic GetDiagnostic();

    IReadOnlyCollection<int> SampleWithoutReplacement(DrawSamplingRequest request, IRandomnessProvider provider);

    IReadOnlyCollection<int> SampleWithReplacement(DrawSamplingRequest request, IRandomnessProvider provider);
}

public interface IStatisticalValidator
{
    string ValidatorId { get; }

    string ValidatorName { get; }

    ValidationSuiteResult Validate(IReadOnlyCollection<int> sample);
}

public interface IDistributionValidator : IStatisticalValidator
{
}

public interface IRegressionValidator : IStatisticalValidator
{
}

public interface IPerformanceBenchmark
{
    string BenchmarkId { get; }

    string BenchmarkName { get; }

    ValidationSuiteResult Run();
}

public interface IRandomnessAnalyzer
{
    IReadOnlyCollection<ValidationSuiteResult> Analyze(IReadOnlyCollection<int> sample);
}

public interface ICertificationPackageBuilder
{
    CertificationPackage BuildPackage(string profileId);
}

public interface ICertificationSuite
{
    CertificationSuiteStatus GetStatus();

    IReadOnlyCollection<CertificationPackage> GetPackages();

    CertificationPackage BuildPackage(string profileId);
}

public interface IValidationSuite
{
    IReadOnlyCollection<ValidationSuiteResult> DiscoverValidators();

    IReadOnlyCollection<ValidationSuiteResult> RunPlaceholderValidation(ValidationSuiteCommand command);
}
