namespace SettlementService.Configuration;

public sealed record ServiceConfiguration(
    string ServiceName,
    string Environment,
    DatabaseConfiguration Database,
    ServiceIntegrationConfiguration Integrations,
    SettlementRuntimeConfiguration Runtime,
    RabbitMqConfiguration RabbitMQ,
    RedisConfiguration Redis,
    SupabaseConfiguration Supabase)
{
    public static ServiceConfiguration FromEnvironment(IHostEnvironment environment)
    {
        var serviceName = GetEnvironmentValue("SERVICE_NAME", "settlement-service");
        var environmentName = System.Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT")
            ?? environment.EnvironmentName;

        var isProduction = string.Equals(environmentName, "Production", StringComparison.OrdinalIgnoreCase);
        var legacyMutationRoutesEnabled = GetBooleanEnvironmentValue(
            "SETTLEMENT_LEGACY_MUTATIONS_ENABLED",
            !isProduction);
        if (isProduction && legacyMutationRoutesEnabled)
        {
            throw new InvalidOperationException(
                "SETTLEMENT_LEGACY_MUTATIONS_ENABLED must be false in production.");
        }

        return new ServiceConfiguration(
            serviceName,
            environmentName,
            new DatabaseConfiguration(GetEnvironmentValue("DATABASE_URL", string.Empty)),
            new ServiceIntegrationConfiguration(
                GetEnvironmentValue("LEDGER_SERVICE_URL", string.Empty),
                GetEnvironmentValue("CREDIT_SERVICE_URL", string.Empty),
                GetEnvironmentValue("CREDIT_WALLET_INTERNAL_API_KEY", string.Empty)),
            new SettlementRuntimeConfiguration(
                legacyMutationRoutesEnabled,
                GetBooleanEnvironmentValue("SETTLEMENT_AUTOMATIC_RECOVERY_ENABLED", true),
                GetIntegerEnvironmentValue("SETTLEMENT_AUTOMATIC_RECOVERY_INTERVAL_MS", 1_000, 100, 60_000),
                GetIntegerEnvironmentValue("SETTLEMENT_AUTOMATIC_RECOVERY_BATCH_SIZE", 100, 1, 1_000),
                GetIntegerEnvironmentValue("SETTLEMENT_AUTOMATIC_RECOVERY_CONCURRENCY", 4, 1, 16),
                GetIntegerEnvironmentValue("SETTLEMENT_AUTOMATIC_RECOVERY_MAX_ATTEMPTS", 20, 1, 100),
                GetIntegerEnvironmentValue("SETTLEMENT_AUTOMATIC_RECOVERY_GRACE_MS", 2_500, 0, 60_000)),
            new RabbitMqConfiguration(
                GetEnvironmentValue("RABBITMQ_URL", string.Empty),
                GetEnvironmentValue("RABBITMQ_EXCHANGE_NAME", "lottery.events")),
            new RedisConfiguration(GetEnvironmentValue("REDIS_URL", string.Empty)),
            new SupabaseConfiguration(
                GetEnvironmentValue("SUPABASE_URL", string.Empty),
                GetEnvironmentValue("SUPABASE_SERVICE_ROLE_KEY", string.Empty)));
    }

    private static string GetEnvironmentValue(string name, string fallback)
    {
        var value = System.Environment.GetEnvironmentVariable(name);

        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }

    private static bool GetBooleanEnvironmentValue(string name, bool fallback)
    {
        var value = System.Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value)
            ? fallback
            : bool.TryParse(value, out var parsed)
                ? parsed
                : throw new InvalidOperationException($"{name} must be true or false.");
    }

    private static int GetIntegerEnvironmentValue(
        string name,
        int fallback,
        int minimum,
        int maximum)
    {
        var value = System.Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }

        return int.TryParse(value, out var parsed) && parsed >= minimum && parsed <= maximum
            ? parsed
            : throw new InvalidOperationException(
                $"{name} must be an integer between {minimum} and {maximum}.");
    }
}

public sealed record RabbitMqConfiguration(string Url, string ExchangeName);

public sealed record DatabaseConfiguration(string Url);

public sealed record ServiceIntegrationConfiguration(
    string LedgerServiceUrl,
    string CreditServiceUrl,
    string CreditWalletInternalApiKey);

public sealed record SettlementRuntimeConfiguration(
    bool LegacyMutationRoutesEnabled,
    bool AutomaticRecoveryEnabled,
    int AutomaticRecoveryIntervalMs,
    int AutomaticRecoveryBatchSize,
    int AutomaticRecoveryConcurrency,
    int AutomaticRecoveryMaxAttempts,
    int AutomaticRecoveryGraceMs);

public sealed record RedisConfiguration(string Url);

public sealed record SupabaseConfiguration(string Url, string ServiceRoleKey);
