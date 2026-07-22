namespace LedgerService.Configuration;

public sealed record ServiceConfiguration(
    string ServiceName,
    string Environment,
    RabbitMqConfiguration RabbitMQ,
    RedisConfiguration Redis,
    SupabaseConfiguration Supabase,
    DatabaseConfiguration Database,
    ServiceDependencyConfiguration CreditWalletService)
{
    public static ServiceConfiguration FromEnvironment(IHostEnvironment environment)
    {
        var serviceName = GetEnvironmentValue("SERVICE_NAME", "ledger-service");
        var environmentName = System.Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT")
            ?? environment.EnvironmentName;

        return new ServiceConfiguration(
            serviceName,
            environmentName,
            new RabbitMqConfiguration(
                GetEnvironmentValue("RABBITMQ_URL", string.Empty),
                GetEnvironmentValue("RABBITMQ_EXCHANGE_NAME", "lottery.events")),
            new RedisConfiguration(GetEnvironmentValue("REDIS_URL", string.Empty)),
            new SupabaseConfiguration(
                GetEnvironmentValue("SUPABASE_URL", string.Empty),
                GetEnvironmentValue("SUPABASE_SERVICE_ROLE_KEY", string.Empty)),
            new DatabaseConfiguration(GetEnvironmentValue("DATABASE_URL", string.Empty)),
            new ServiceDependencyConfiguration(
                GetEnvironmentValue("CREDIT_WALLET_SERVICE_URL", "http://credit-wallet-service:8080")));
    }

    private static string GetEnvironmentValue(string name, string fallback)
    {
        var value = System.Environment.GetEnvironmentVariable(name);

        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }
}

public sealed record RabbitMqConfiguration(string Url, string ExchangeName);

public sealed record RedisConfiguration(string Url);

public sealed record SupabaseConfiguration(string Url, string ServiceRoleKey);

public sealed record DatabaseConfiguration(string Url);

public sealed record ServiceDependencyConfiguration(string Url);
