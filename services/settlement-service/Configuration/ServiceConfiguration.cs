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
            new SettlementRuntimeConfiguration(legacyMutationRoutesEnabled),
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
}

public sealed record RabbitMqConfiguration(string Url, string ExchangeName);

public sealed record DatabaseConfiguration(string Url);

public sealed record ServiceIntegrationConfiguration(
    string LedgerServiceUrl,
    string CreditServiceUrl,
    string CreditWalletInternalApiKey);

public sealed record SettlementRuntimeConfiguration(bool LegacyMutationRoutesEnabled);

public sealed record RedisConfiguration(string Url);

public sealed record SupabaseConfiguration(string Url, string ServiceRoleKey);
