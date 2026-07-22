using AuthService.Domain.Models;

namespace AuthService.Application.Contracts;

public interface IAuthenticationAuthorityRepository
{
    bool RuntimeAvailable { get; }
    Task<CanonicalIdentity?> FindIdentityByIdentifier(string normalizedIdentifier, CancellationToken cancellationToken = default);
    Task<CanonicalIdentity?> FindIdentityById(Guid identityId, CancellationToken cancellationToken = default);
    Task<PasswordCredentialVersion?> FindActivePasswordCredential(Guid identityId, CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<PasswordCredentialVersion>> ListPasswordHistory(Guid identityId, int limit, CancellationToken cancellationToken = default);
    Task<CanonicalIdentity> CreateIdentity(CanonicalIdentity identity, PasswordCredentialVersion credential, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default);
    Task<PasswordCredentialVersion> RotatePassword(Guid identityId, PasswordCredentialVersion credential, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default);
    Task CreatePasswordResetRequest(PasswordResetAuthorityRecord reset, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default);
    Task<PasswordResetAuthorityRecord?> FindActivePasswordResetByHash(string tokenHash, CancellationToken cancellationToken = default);
    Task<PasswordCredentialVersion> ConsumePasswordReset(PasswordResetAuthorityRecord reset, PasswordCredentialVersion credential, AuthenticationAuditEvidence resetEvidence, AuthenticationAuditEvidence logoutEvidence, CancellationToken cancellationToken = default);
    Task<CanonicalIdentity> TransitionIdentity(Guid identityId, CanonicalIdentityStatus expectedStatus, CanonicalIdentityStatus targetStatus, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default);
    Task<CanonicalSession> EstablishSession(CanonicalIdentity identity, CanonicalSession session, CanonicalTokenArtifacts tokens, AuthenticationAuditEvidence loginEvidence, AuthenticationAuditEvidence sessionEvidence, CancellationToken cancellationToken = default);
    Task<CanonicalSession?> FindSessionByHash(string tokenHash, CancellationToken cancellationToken = default);
    Task<CanonicalSession?> RenewSession(string tokenHash, DateTimeOffset idleExpiresAt, CancellationToken cancellationToken = default);
    Task<int> RevokeSession(string tokenHash, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default);
    Task<int> RevokeSessionById(Guid sessionId, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default);
    Task<int> RevokeAllSessions(Guid identityId, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default);
    Task AppendAudit(AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default);
    Task AppendAnonymousLoginFailure(string identifierHash, string reason, string correlationId, string? ipAddress, string? userAgent, CancellationToken cancellationToken = default);
    Task<bool> HasSuperAdminGovernance(Guid identityId, CancellationToken cancellationToken = default);
    Task<bool> CheckReadiness(CancellationToken cancellationToken = default);
}

public sealed record CanonicalLoginRequest(string Identifier, string Password, string? CorrelationId, string? IpAddress, string? UserAgent, string? DeviceMetadata);
public sealed record CanonicalLoginResult(bool Success, string? FailureReason, CanonicalIdentity? Identity, CanonicalSession? Session, CanonicalTokenArtifacts? Tokens, string CorrelationId);
public sealed record CanonicalTokenArtifacts(
    Guid AccessTokenId,
    string AccessToken,
    string JwtId,
    Guid SigningKeyId,
    string SigningKeyName,
    string Issuer,
    string Audience,
    IReadOnlyCollection<string> Scopes,
    DateTimeOffset AccessIssuedAt,
    DateTimeOffset AccessExpiresAt,
    Guid RefreshTokenId,
    Guid RefreshTokenRecordId,
    Guid RefreshTokenFamilyId,
    string RefreshToken,
    string RefreshTokenHash,
    DateTimeOffset RefreshIssuedAt,
    DateTimeOffset RefreshExpiresAt);
public sealed record CreateCanonicalIdentityRequest(Guid IdentityId, Guid TenantId, Guid? BrandId, string Username, string? Email, string AccountType, CanonicalIdentityStatus InitialStatus, string Password, Guid? ActorIdentityId, string? CorrelationId, string? IpAddress, string? UserAgent);
public sealed record PasswordRotationRequest(Guid IdentityId, string CurrentPassword, string NewPassword, string? CorrelationId, Guid? ActorIdentityId, string? IpAddress, string? UserAgent);
public sealed record PasswordResetAuthorityRequest(Guid IdentityId, string NewPassword, Guid ActorIdentityId, string Reason, string? CorrelationId, string? IpAddress, string? UserAgent);
public sealed record PublicPasswordResetRequest(string Identifier, string? CorrelationId, string? IpAddress, string? UserAgent);
public sealed record PublicPasswordResetResult(bool Success, string Message, string? ResetToken);
public sealed record PublicPasswordResetConfirmRequest(string ResetToken, string NewPassword, string? CorrelationId, string? IpAddress, string? UserAgent);
public sealed record PasswordResetAuthorityRecord(Guid ResetId, Guid IdentityId, string TokenHash, DateTimeOffset ExpiresAt, DateTimeOffset CreatedAt);
public sealed record LifecycleTransitionRequest(Guid IdentityId, CanonicalIdentityStatus ExpectedStatus, CanonicalIdentityStatus TargetStatus, Guid ActorIdentityId, string Reason, string? CorrelationId, string? IpAddress, string? UserAgent);
