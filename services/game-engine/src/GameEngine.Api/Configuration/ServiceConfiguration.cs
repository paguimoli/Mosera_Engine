namespace GameEngine.Api.Configuration;

public sealed record ServiceConfiguration(
    string ServiceName,
    string Environment,
    RabbitMqConfiguration RabbitMq,
    RedisConfiguration Redis,
    GameEngineSchemaConfiguration Schema)
{
    public static ServiceConfiguration FromEnvironment(IHostEnvironment environment)
    {
        return new ServiceConfiguration(
            GetEnvironmentValue("SERVICE_NAME", "game-engine"),
            System.Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? environment.EnvironmentName,
            new RabbitMqConfiguration(
                GetEnvironmentValue("RABBITMQ_URL", string.Empty),
                GetEnvironmentValue("RABBITMQ_EXCHANGE_NAME", "lottery.events")),
            new RedisConfiguration(GetEnvironmentValue("REDIS_URL", string.Empty)),
            new GameEngineSchemaConfiguration(GetEnvironmentValue("GAME_ENGINE_SCHEMA", "game_engine")));
    }

    private static string GetEnvironmentValue(string name, string fallback)
    {
        var value = System.Environment.GetEnvironmentVariable(name);

        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }
}

public sealed record RabbitMqConfiguration(string Url, string ExchangeName);

public sealed record RedisConfiguration(string Url);

public sealed record GameEngineSchemaConfiguration(string SchemaName);
