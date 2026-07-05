using System.Net.Sockets;
using System.Text;
using SettlementService.Configuration;

namespace SettlementService.Infrastructure;

public sealed class InfrastructureReadinessChecks
{
    private static readonly byte[] RedisPingCommand = Encoding.ASCII.GetBytes("*1\r\n$4\r\nPING\r\n");
    private readonly ServiceConfiguration configuration;
    private readonly ILogger<InfrastructureReadinessChecks> logger;

    public InfrastructureReadinessChecks(
        ServiceConfiguration configuration,
        ILogger<InfrastructureReadinessChecks> logger)
    {
        this.configuration = configuration;
        this.logger = logger;
    }

    public async Task<DependencyHealthResult> CheckRabbitMqAsync(
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(configuration.RabbitMQ.Url))
        {
            return new DependencyHealthResult("rabbitmq", false, "RABBITMQ_URL is not configured.");
        }

        return await CheckTcpEndpointAsync(
            "rabbitmq",
            configuration.RabbitMQ.Url,
            defaultPort: 5672,
            cancellationToken);
    }

    public async Task<DependencyHealthResult> CheckRedisAsync(
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(configuration.Redis.Url))
        {
            return new DependencyHealthResult("redis", false, "REDIS_URL is not configured.");
        }

        try
        {
            var redisUri = new Uri(configuration.Redis.Url);
            using var client = new TcpClient();
            await client.ConnectAsync(redisUri.Host, GetPort(redisUri, 6379), cancellationToken);

            await using var stream = client.GetStream();
            await stream.WriteAsync(RedisPingCommand, cancellationToken);

            var buffer = new byte[16];
            var bytesRead = await stream.ReadAsync(buffer, cancellationToken);
            var response = Encoding.ASCII.GetString(buffer, 0, bytesRead);

            return response.StartsWith("+PONG", StringComparison.Ordinal)
                ? new DependencyHealthResult("redis", true)
                : new DependencyHealthResult("redis", false, "Unexpected Redis PING response.");
        }
        catch (Exception error) when (error is UriFormatException or SocketException or IOException or OperationCanceledException)
        {
            logger.LogWarning(error, "Redis readiness check failed.");
            return new DependencyHealthResult("redis", false, error.Message);
        }
    }

    public async Task<DependencyHealthResult> CheckDatabaseAsync(
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(configuration.Database.Url))
        {
            return new DependencyHealthResult("database", false, "DATABASE_URL is not configured.");
        }

        try
        {
            await using var connection = new Npgsql.NpgsqlConnection(
                PostgresConnectionString.Normalize(configuration.Database.Url));
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "select 1";
            await command.ExecuteScalarAsync(cancellationToken);

            return new DependencyHealthResult("database", true);
        }
        catch (Exception error) when (error is Npgsql.NpgsqlException or InvalidOperationException or OperationCanceledException)
        {
            logger.LogWarning(error, "Database readiness check failed.");
            return new DependencyHealthResult("database", false, error.Message);
        }
    }

    private async Task<DependencyHealthResult> CheckTcpEndpointAsync(
        string name,
        string url,
        int defaultPort,
        CancellationToken cancellationToken)
    {
        try
        {
            var uri = new Uri(url);
            using var client = new TcpClient();
            await client.ConnectAsync(uri.Host, GetPort(uri, defaultPort), cancellationToken);

            return new DependencyHealthResult(name, true);
        }
        catch (Exception error) when (error is UriFormatException or SocketException or IOException or OperationCanceledException)
        {
            logger.LogWarning(error, "{DependencyName} readiness check failed.", name);
            return new DependencyHealthResult(name, false, error.Message);
        }
    }

    private static int GetPort(Uri uri, int defaultPort)
    {
        return uri.IsDefaultPort ? defaultPort : uri.Port;
    }
}
