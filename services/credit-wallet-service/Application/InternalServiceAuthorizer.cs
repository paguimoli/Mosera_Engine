using System.Security.Cryptography;
using System.Text;
using CreditWalletService.Configuration;
using CreditWalletService.Contracts;

namespace CreditWalletService.Application;

public sealed class InternalServiceAuthorizer(ServiceConfiguration configuration)
{
    public bool ProductionReady =>
        !configuration.InternalAuthorization.Required ||
        !string.IsNullOrWhiteSpace(configuration.InternalAuthorization.ApiKey);

    public bool ProductionCredentialReady
    {
        get
        {
            var value = configuration.InternalAuthorization.ApiKey;
            if (!configuration.InternalAuthorization.Required || string.IsNullOrWhiteSpace(value) || value.Length < 32)
            {
                return false;
            }
            return !new[] { "local", "dummy", "test", "example", "changeme" }
                .Any(marker => value.Contains(marker, StringComparison.OrdinalIgnoreCase));
        }
    }

    public bool IsAuthorized(HttpContext context)
    {
        var caller = GetCaller(context);
        if (string.IsNullOrWhiteSpace(caller) ||
            !configuration.InternalAuthorization.AllowedCallers.Contains(caller, StringComparer.Ordinal))
        {
            return false;
        }

        if (!configuration.InternalAuthorization.Required)
        {
            return true;
        }

        var authorization = context.Request.Headers.Authorization.FirstOrDefault();
        const string prefix = "Bearer ";
        if (string.IsNullOrWhiteSpace(authorization) ||
            !authorization.StartsWith(prefix, StringComparison.Ordinal))
        {
            return false;
        }

        var supplied = Encoding.UTF8.GetBytes(authorization[prefix.Length..].Trim());
        var expected = Encoding.UTF8.GetBytes(configuration.InternalAuthorization.ApiKey);
        return supplied.Length == expected.Length && CryptographicOperations.FixedTimeEquals(supplied, expected);
    }

    public static string? GetCaller(HttpContext context)
    {
        return context.Request.Headers[CanonicalWalletOperationHeaders.InternalServiceName]
            .FirstOrDefault()?.Trim();
    }
}
