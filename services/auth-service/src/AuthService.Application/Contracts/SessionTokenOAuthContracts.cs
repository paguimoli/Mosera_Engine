using AuthService.Domain.Models;

namespace AuthService.Application.Contracts;

public interface ISessionCreationPolicy
{
    SessionCreationResult Evaluate(SessionCreationRequest request, Identity identity);
}

public interface ISessionFactory
{
    Task<SessionCreationResult> CreateDiagnosticSessionAsync(
        SessionCreationRequest request,
        CancellationToken cancellationToken);
}

public interface ITokenIssuancePolicy
{
    TokenIssuanceResult Evaluate(TokenIssuanceRequest request, AuthSession session);
}

public interface ITokenIssuer
{
    Task<TokenIssuanceResult> IssueDiagnosticTokenAsync(
        TokenIssuanceRequest request,
        CancellationToken cancellationToken);
}

public interface ITokenIntrospectionService
{
    Task<TokenIntrospectionResult> IntrospectAsync(
        string tokenReference,
        CancellationToken cancellationToken);
}

public interface IOAuthAuthorizationServerModel
{
    OidcProviderMetadata GetProviderMetadata();

    JwksDocument GetJwksDocument();
}

public interface IServiceClientCredentialsPolicy
{
    ClientCredentialsResult Evaluate(ClientCredentialsRequest request, ServiceClient client);
}
