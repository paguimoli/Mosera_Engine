using GameEngine.Application.Services;

namespace GameEngine.Api.Configuration;

public sealed record SchedulerOutcomeFanoutConfiguration(
    bool Enabled,
    bool QualificationMode,
    string DeploymentEnvironment,
    string SigningPrivateKeyPem,
    int PageSize,
    int MaxDegreeOfParallelism,
    int AdmissionBatchSize,
    int AdmissionConcurrency,
    int MaxBufferedEvaluations,
    int SettlementPreparationConcurrency,
    string QualificationFailureStage,
    int QualificationFailureAfterPages)
{
    private static readonly HashSet<string> FailureStages = new(StringComparer.Ordinal)
    {
        "",
        "AfterCertificateBeforeFanout",
        "AfterMathBeforeSettlementInput",
        "AfterSettlementInputBeforeRequest",
        "AfterCompletedPages"
    };

    public static SchedulerOutcomeFanoutConfiguration FromEnvironment()
    {
        var configuration = new SchedulerOutcomeFanoutConfiguration(
            IsTrue("GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_ENABLED"),
            IsTrue("GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_QUALIFICATION_MODE"),
            Environment.GetEnvironmentVariable("DEPLOYMENT_ENVIRONMENT") ?? "local",
            NormalizePem(Environment.GetEnvironmentVariable("GAME_ENGINE_QUALIFICATION_SIGNING_PRIVATE_KEY_PEM")),
            ReadBoundedInt("GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_PAGE_SIZE", 100, 1, 500),
            ReadBoundedInt("GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_CONCURRENCY", 12, 1, 32),
            ReadBoundedInt("GAME_ENGINE_MATH_ADMISSION_BATCH_SIZE", 100, 1, 500),
            ReadBoundedInt("GAME_ENGINE_MATH_ADMISSION_CONCURRENCY", 2, 1, 8),
            ReadBoundedInt("GAME_ENGINE_MATH_ADMISSION_BUFFER_LIMIT", 5_000, 100, 20_000),
            ReadBoundedInt("GAME_ENGINE_SETTLEMENT_PREPARATION_CONCURRENCY", 6, 1, 16),
            Environment.GetEnvironmentVariable("GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_FAILURE_STAGE")?.Trim() ?? "",
            ReadBoundedInt("GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_FAILURE_AFTER_PAGES", 1, 1, 500));

        if (configuration.Enabled && !configuration.QualificationMode)
        {
            throw new InvalidOperationException(
                "Scheduler outcome fanout requires the explicit qualification-mode marker in this release candidate.");
        }
        if (configuration.Enabled &&
            string.Equals(configuration.DeploymentEnvironment, "production", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "Scheduler outcome fanout qualification mode cannot run in production.");
        }
        if (configuration.Enabled && string.IsNullOrWhiteSpace(configuration.SigningPrivateKeyPem))
        {
            throw new InvalidOperationException(
                "Scheduler outcome fanout qualification mode requires an ephemeral RSA signing private key.");
        }
        if (!FailureStages.Contains(configuration.QualificationFailureStage))
        {
            throw new InvalidOperationException(
                "GAME_ENGINE_SCHEDULER_OUTCOME_FANOUT_FAILURE_STAGE is not a supported qualification checkpoint.");
        }
        if (!string.IsNullOrEmpty(configuration.QualificationFailureStage) &&
            (!configuration.Enabled || !configuration.QualificationMode ||
             string.Equals(configuration.DeploymentEnvironment, "production", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException(
                "Scheduler fanout failure injection is restricted to explicit non-production qualification mode.");
        }
        return configuration;
    }

    public SchedulerOutcomeFanoutOptions ToOptions() => new(
        Enabled,
        QualificationMode,
        DeploymentEnvironment,
        SigningPrivateKeyPem,
        PageSize,
        MaxDegreeOfParallelism,
        QualificationFailureStage,
        QualificationFailureAfterPages)
    {
        AdmissionBatchSize = AdmissionBatchSize,
        AdmissionConcurrency = AdmissionConcurrency,
        MaxBufferedEvaluations = MaxBufferedEvaluations,
        SettlementPreparationConcurrency = SettlementPreparationConcurrency
    };

    private static bool IsTrue(string name) => string.Equals(
        Environment.GetEnvironmentVariable(name),
        "true",
        StringComparison.OrdinalIgnoreCase);

    private static int ReadBoundedInt(string name, int fallback, int minimum, int maximum)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(raw)) return fallback;
        if (!int.TryParse(raw, out var parsed) || parsed < minimum || parsed > maximum)
        {
            throw new InvalidOperationException($"{name} must be an integer between {minimum} and {maximum}.");
        }
        return parsed;
    }

    private static string NormalizePem(string? value) =>
        string.IsNullOrWhiteSpace(value) ? string.Empty : value.Replace("\\n", "\n", StringComparison.Ordinal);
}
