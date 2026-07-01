namespace AuthService.Domain.Boundaries;

public abstract record CredentialBoundary(
    Guid CredentialId,
    Guid IdentityId,
    string PublicReference,
    bool Enabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt,
    DateTimeOffset? ExpiresAt);

public sealed record PasswordCredential(
    Guid CredentialId,
    Guid IdentityId,
    string PublicReference,
    string HashAlgorithm,
    string HashVersion,
    bool Enabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt,
    DateTimeOffset? ExpiresAt)
    : CredentialBoundary(CredentialId, IdentityId, PublicReference, Enabled, CreatedAt, DisabledAt, ExpiresAt);

public sealed record TotpCredential(
    Guid CredentialId,
    Guid IdentityId,
    string PublicReference,
    string Issuer,
    bool Enabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt)
    : CredentialBoundary(CredentialId, IdentityId, PublicReference, Enabled, CreatedAt, DisabledAt, null);

public sealed record WebAuthnCredential(
    Guid CredentialId,
    Guid IdentityId,
    string PublicReference,
    string CredentialDeviceType,
    bool ResidentKey,
    bool Enabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt)
    : CredentialBoundary(CredentialId, IdentityId, PublicReference, Enabled, CreatedAt, DisabledAt, null);

public sealed record OAuthFederatedCredential(
    Guid CredentialId,
    Guid IdentityId,
    string PublicReference,
    string Provider,
    string Subject,
    bool Enabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt)
    : CredentialBoundary(CredentialId, IdentityId, PublicReference, Enabled, CreatedAt, DisabledAt, null);

public sealed record PamFederatedCredential(
    Guid CredentialId,
    Guid IdentityId,
    string PublicReference,
    string PamProvider,
    string ExternalUserId,
    bool Enabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt)
    : CredentialBoundary(CredentialId, IdentityId, PublicReference, Enabled, CreatedAt, DisabledAt, null);

public sealed record ApiKeyCredential(
    Guid CredentialId,
    Guid IdentityId,
    string PublicReference,
    string KeyId,
    bool Enabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt,
    DateTimeOffset? ExpiresAt)
    : CredentialBoundary(CredentialId, IdentityId, PublicReference, Enabled, CreatedAt, DisabledAt, ExpiresAt);

public sealed record ClientSecretCredential(
    Guid CredentialId,
    Guid IdentityId,
    string PublicReference,
    Guid OAuthClientId,
    bool Enabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt,
    DateTimeOffset? ExpiresAt)
    : CredentialBoundary(CredentialId, IdentityId, PublicReference, Enabled, CreatedAt, DisabledAt, ExpiresAt);

public sealed record CertificateCredential(
    Guid CredentialId,
    Guid IdentityId,
    string PublicReference,
    string Thumbprint,
    string Subject,
    bool Enabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DisabledAt,
    DateTimeOffset? ExpiresAt)
    : CredentialBoundary(CredentialId, IdentityId, PublicReference, Enabled, CreatedAt, DisabledAt, ExpiresAt);

public sealed record CredentialSecretBoundary(
    Guid CredentialId,
    string SecretMaterialReference,
    bool ReturnedByPublicQueryModel);
