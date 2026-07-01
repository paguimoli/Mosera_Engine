namespace AuthService.Domain.Models;

public sealed record ServiceScope(
    string Value,
    string Description,
    bool Required);

public sealed record ServiceTokenPolicy(
    TimeSpan AccessTokenLifetime,
    bool ScopesRequired,
    bool AuditRequired,
    bool MtlsBindingPlaceholder,
    bool ClientSecretMetadataOnly,
    bool CertificateMetadataOnly);

public sealed record ServiceClient(
    string ClientId,
    string ServiceName,
    IReadOnlyCollection<ServiceScope> AllowedScopes,
    ServiceTokenPolicy TokenPolicy,
    bool Enabled);

public sealed record ClientCredentialsRequest(
    string ClientId,
    IReadOnlyCollection<ServiceScope> RequestedScopes,
    string CorrelationId,
    bool MtlsCertificatePresentedPlaceholder);

public sealed record ClientCredentialsResult(
    bool WouldIssue,
    TokenIssuanceStatus Status,
    string Reason,
    bool AccessTokenGenerated,
    bool AuditRequired);
