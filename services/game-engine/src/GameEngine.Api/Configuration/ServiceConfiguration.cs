namespace GameEngine.Api.Configuration;

public sealed record ServiceConfiguration(
    string ServiceName,
    string Environment,
    RabbitMqConfiguration RabbitMq,
    RedisConfiguration Redis,
    GameEngineSchemaConfiguration Schema,
    bool CanonicalOutcomePipelineEnabled,
    bool LegacyOutcomePublicationEnabled,
    bool CanonicalOutcomeRecoveryEnabled,
    ProductionActivationConfiguration ProductionActivation)
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
            new GameEngineSchemaConfiguration(GetEnvironmentValue("GAME_ENGINE_SCHEMA", "game_engine")),
            string.Equals(
                System.Environment.GetEnvironmentVariable("OUTCOME_CANONICAL_PIPELINE_ENABLED"),
                "true",
                StringComparison.OrdinalIgnoreCase),
            string.Equals(
                System.Environment.GetEnvironmentVariable("OUTCOME_LEGACY_PUBLICATION_ENABLED"),
                "true",
                StringComparison.OrdinalIgnoreCase),
            string.Equals(
                System.Environment.GetEnvironmentVariable("OUTCOME_CANONICAL_RECOVERY_ENABLED"),
                "true",
                StringComparison.OrdinalIgnoreCase),
            new ProductionActivationConfiguration(
                IsTrue("GAME_ENGINE_PRODUCTION_ACTIVATION_ENABLED"),
                IsTrue("GAME_ENGINE_PRODUCTION_SIGNING_ENABLED"),
                GetEnvironmentValue("GAME_ENGINE_SIGNING_PROVIDER_ID", string.Empty),
                GetEnvironmentValue("GAME_ENGINE_SIGNING_PROVIDER_VERSION", string.Empty),
                GetEnvironmentValue("GAME_ENGINE_SIGNING_KEY_VERSION", string.Empty),
                GetEnvironmentValue("GAME_ENGINE_SIGNING_PUBLIC_KEY_PEM", string.Empty)
                    .Replace("\\n", "\n", StringComparison.Ordinal)));
    }

    private static string GetEnvironmentValue(string name, string fallback)
    {
        var value = System.Environment.GetEnvironmentVariable(name);

        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }

    private static bool IsTrue(string name) => string.Equals(
        System.Environment.GetEnvironmentVariable(name),
        "true",
        StringComparison.OrdinalIgnoreCase);
}

public sealed record RabbitMqConfiguration(string Url, string ExchangeName);

public sealed record RedisConfiguration(string Url);

public sealed record GameEngineSchemaConfiguration(string SchemaName);

public sealed record ProductionActivationConfiguration(
    bool Enabled,
    bool SigningEnabled,
    string SigningProviderId,
    string SigningProviderVersion,
    string SigningKeyVersion,
    string SigningPublicKeyPem);
