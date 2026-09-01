using Npgsql;

namespace SettlementService.Infrastructure;

public static class PostgresConnectionString
{
    public static string Normalize(string value)
    {
        NpgsqlConnectionStringBuilder builder;
        if (Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            uri.Scheme is "postgres" or "postgresql")
        {
            var credentials = uri.UserInfo.Split(':', 2);
            builder = new NpgsqlConnectionStringBuilder
            {
                Host = uri.Host,
                Port = uri.IsDefaultPort ? 5432 : uri.Port,
                Database = uri.AbsolutePath.TrimStart('/'),
                Username = Uri.UnescapeDataString(credentials.ElementAtOrDefault(0) ?? string.Empty),
                Password = Uri.UnescapeDataString(credentials.ElementAtOrDefault(1) ?? string.Empty)
            };
        }
        else
        {
            builder = new NpgsqlConnectionStringBuilder(value);
        }
        builder.Pooling = true;
        builder.MinPoolSize = 0;
        builder.MaxPoolSize = ReadPoolMaximum(8);
        var applicationName = Environment.GetEnvironmentVariable("DATABASE_APPLICATION_NAME")?.Trim();
        if (!string.IsNullOrEmpty(applicationName)) builder.ApplicationName = applicationName;

        return builder.ConnectionString;
    }

    private static int ReadPoolMaximum(int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable("DATABASE_MAX_POOL_SIZE"), out var value)
            ? Math.Clamp(value, 1, 32)
            : fallback;
}
