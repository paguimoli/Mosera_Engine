namespace SettlementService.Configuration;

public sealed record ServiceConfiguration(
    string ServiceName,
    string Environment,
    RabbitMqConfiguration RabbitMQ,
    RedisConfiguration Redis)
{
    public static ServiceConfiguration FromEnvironment(IHostEnvironment environment)
    {
        var serviceName = GetEnvironmentValue("SERVICE_NAME", "settlement-service");
        var environmentName = System.Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT")
            ?? environment.EnvironmentName;

        return new ServiceConfiguration(
            serviceName,
            environmentName,
            new RabbitMqConfiguration(
                GetEnvironmentValue("RABBITMQ_URL", string.Empty),
                GetEnvironmentValue("RABBITMQ_EXCHANGE_NAME", "lottery.events")),
            new RedisConfiguration(GetEnvironmentValue("REDIS_URL", string.Empty)));
    }

    private static string GetEnvironmentValue(string name, string fallback)
    {
        var value = System.Environment.GetEnvironmentVariable(name);

        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }
}

public sealed record RabbitMqConfiguration(string Url, string ExchangeName);

public sealed record RedisConfiguration(string Url);
