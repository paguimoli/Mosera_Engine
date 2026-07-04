namespace AuthService.Infrastructure;

public sealed record AuthInfrastructureStatus(
    bool DatabaseWiringEnabled,
    bool DatabaseReady,
    bool TokenSigningEnabled,
    bool ServiceTokenEnabled,
    bool PasswordHashingEnabled,
    bool OAuthRuntimeEnabled,
    string Reason);

public sealed class AuthInfrastructureStatusProvider
{
    private readonly string? databaseUrl;

    public AuthInfrastructureStatusProvider()
        : this(Environment.GetEnvironmentVariable("DATABASE_URL"))
    {
    }

    public AuthInfrastructureStatusProvider(string? databaseUrl)
    {
        this.databaseUrl = string.IsNullOrWhiteSpace(databaseUrl) ? null : databaseUrl;
    }

    public AuthInfrastructureStatus GetStatus()
    {
        if (!string.IsNullOrWhiteSpace(databaseUrl))
        {
            return new AuthInfrastructureStatus(
                DatabaseWiringEnabled: true,
                DatabaseReady: CanConnectToDatabase(),
                TokenSigningEnabled: CanUseTokenSigning(),
                ServiceTokenEnabled: CanUseServiceTokens(),
                PasswordHashingEnabled: true,
                OAuthRuntimeEnabled: false,
                Reason: "DATABASE_URL-backed Auth Service persistence, session login runtime, and JWT access token signing are configured; OAuth runtime remains disabled.");
        }

        return new AuthInfrastructureStatus(
            DatabaseWiringEnabled: false,
            DatabaseReady: false,
            TokenSigningEnabled: false,
            ServiceTokenEnabled: false,
            PasswordHashingEnabled: false,
            OAuthRuntimeEnabled: false,
            Reason: "DATABASE_URL is absent; Auth Service persistence is in safe diagnostic-disabled mode.");
    }

    private bool CanConnectToDatabase()
    {
        try
        {
            using var connection = new Npgsql.NpgsqlConnection(AuthPostgresConnectionString.Normalize(databaseUrl!));
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "select to_regclass('auth_service.identities') is not null;";
            return command.ExecuteScalar() is true;
        }
        catch
        {
            return false;
        }
    }

    private bool CanUseTokenSigning()
    {
        try
        {
            using var connection = new Npgsql.NpgsqlConnection(AuthPostgresConnectionString.Normalize(databaseUrl!));
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "select to_regclass('auth_service.signing_keys') is not null;";
            return command.ExecuteScalar() is true;
        }
        catch
        {
            return false;
        }
    }

    private bool CanUseServiceTokens()
    {
        try
        {
            using var connection = new Npgsql.NpgsqlConnection(AuthPostgresConnectionString.Normalize(databaseUrl!));
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = """
select to_regclass('auth_service.service_accounts') is not null
   and to_regclass('auth_service.oauth_clients') is not null
   and to_regclass('auth_service.oauth_client_secrets') is not null;
""";
            return command.ExecuteScalar() is true;
        }
        catch
        {
            return false;
        }
    }
}
