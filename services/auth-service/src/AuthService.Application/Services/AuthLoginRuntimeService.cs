using System.Security.Cryptography;
using AuthService.Application.Contracts;
using AuthService.Domain.Boundaries;
using AuthService.Domain.Models;

namespace AuthService.Application.Services;

public sealed class AuthLoginRuntimeService(
    IIdentityRepository identities,
    ICredentialRepository credentials,
    ISessionRepository sessions,
    IRoleRepository roles,
    IPermissionRepository permissions,
    IAuthRuntimeStore runtimeStore)
{
    private static readonly TimeSpan SessionLifetime = TimeSpan.FromHours(12);

    public async Task<LoginRuntimeResult> LoginAsync(
        LoginRuntimeRequest request,
        CancellationToken cancellationToken = default)
    {
        var correlationId = NormalizeCorrelationId(request.CorrelationId);
        if (!runtimeStore.RuntimeAvailable)
        {
            return LoginRuntimeResult.Failed(
                CredentialFailureReason.VerificationNotImplemented,
                correlationId,
                "Auth Service login runtime requires DATABASE_URL-backed persistence.");
        }

        if (string.IsNullOrWhiteSpace(request.LoginId) || string.IsNullOrWhiteSpace(request.Password))
        {
            await AppendLoginAudit(null, "LOGIN_FAILURE", correlationId, "invalid_request", cancellationToken);
            return LoginRuntimeResult.Failed(CredentialFailureReason.InvalidCredential, correlationId);
        }

        var identity = await identities.FindByLoginId(new LoginId(request.LoginId), cancellationToken);
        if (identity is null)
        {
            await AppendLoginAudit(null, "LOGIN_FAILURE", correlationId, "identity_not_found", cancellationToken);
            return LoginRuntimeResult.Failed(CredentialFailureReason.IdentityNotFound, correlationId);
        }

        if (identity.LifecycleState != IdentityLifecycleState.Active)
        {
            await AppendLoginAudit(identity.Id, "LOGIN_FAILURE", correlationId, "lifecycle_denied", cancellationToken);
            return LoginRuntimeResult.Failed(CredentialFailureReason.LifecycleDenied, correlationId);
        }

        var nowForCredentialCheck = DateTimeOffset.UtcNow;
        var passwordCredentials = (await credentials.ListPublicCredentials(identity.Id, cancellationToken))
            .OfType<PasswordCredential>()
            .Where(credential => credential.Enabled && (credential.ExpiresAt is null || credential.ExpiresAt > nowForCredentialCheck))
            .ToArray();

        foreach (var passwordCredential in passwordCredentials)
        {
            var secret = await credentials.FindSecretBoundary(passwordCredential.CredentialId, cancellationToken);
            if (secret is null || secret.ReturnedByPublicQueryModel)
            {
                continue;
            }

            var verified = PasswordHashVerifier.Verify(
                request.Password,
                secret.SecretMaterialReference,
                passwordCredential.HashAlgorithm);

            if (!verified)
            {
                continue;
            }

            var now = DateTimeOffset.UtcNow;
            var session = new Session(
                Guid.NewGuid(),
                identity.Id,
                SessionState.Active,
                "interactive-default",
                now,
                now.Add(SessionLifetime),
                RevokedAt: null);

            session = await runtimeStore.SaveSession(session, cancellationToken);
            await AppendLoginAudit(identity.Id, "LOGIN_SUCCESS", correlationId, "password", cancellationToken);

            return LoginRuntimeResult.Successful(identity, session, correlationId);
        }

        await AppendLoginAudit(identity.Id, "LOGIN_FAILURE", correlationId, "invalid_credential", cancellationToken);
        return LoginRuntimeResult.Failed(CredentialFailureReason.InvalidCredential, correlationId);
    }

    public async Task<SessionValidationResult> ValidateSessionAsync(
        Guid sessionId,
        CancellationToken cancellationToken = default)
    {
        var session = await sessions.FindSession(sessionId, cancellationToken);
        if (session is null)
        {
            return SessionValidationResult.Invalid(sessionId, "session_not_found");
        }

        if (session.State == SessionState.Revoked || session.RevokedAt is not null)
        {
            return SessionValidationResult.Invalid(sessionId, "session_revoked", session);
        }

        if (session.State == SessionState.Expired || session.ExpiresAt <= DateTimeOffset.UtcNow)
        {
            return SessionValidationResult.Invalid(sessionId, "session_expired", session);
        }

        if (session.State != SessionState.Active)
        {
            return SessionValidationResult.Invalid(sessionId, "session_not_active", session);
        }

        var identity = await identities.FindById(session.IdentityId, cancellationToken);
        if (identity is null || identity.LifecycleState != IdentityLifecycleState.Active)
        {
            return SessionValidationResult.Invalid(sessionId, "identity_not_active", session, identity);
        }

        var identityRoles = await roles.ListRoles(identity.Id, cancellationToken);
        var identityPermissions = await permissions.ListPermissions(identity.Id, cancellationToken);

        return SessionValidationResult.ValidResult(session, identity, identityRoles, identityPermissions);
    }

    public async Task<LogoutRuntimeResult> LogoutAsync(
        Guid sessionId,
        string? correlationId,
        CancellationToken cancellationToken = default)
    {
        var normalizedCorrelationId = NormalizeCorrelationId(correlationId);
        var validation = await ValidateSessionAsync(sessionId, cancellationToken);
        if (!runtimeStore.RuntimeAvailable)
        {
            return new LogoutRuntimeResult(false, sessionId, normalizedCorrelationId, null, "runtime_unavailable");
        }

        var revokedAt = DateTimeOffset.UtcNow;
        var revoked = await runtimeStore.RevokeSession(sessionId, revokedAt, cancellationToken);
        await runtimeStore.AppendAuditEvent(new AuditEvent(
            Guid.NewGuid(),
            AuditEventCategory.Session,
            ActorIdentityId: validation.Identity?.Id,
            SubjectIdentityId: validation.Identity?.Id ?? revoked?.IdentityId,
            Action: "LOGOUT",
            CorrelationId: normalizedCorrelationId,
            Metadata: new Dictionary<string, string>
            {
                ["sessionId"] = sessionId.ToString(),
                ["previousValidation"] = validation.Valid ? "valid" : validation.Reason
            },
            CreatedAt: revokedAt), cancellationToken);

        return new LogoutRuntimeResult(true, sessionId, normalizedCorrelationId, revokedAt, null);
    }

    private async Task AppendLoginAudit(
        Guid? identityId,
        string action,
        string correlationId,
        string reason,
        CancellationToken cancellationToken)
    {
        await runtimeStore.AppendAuditEvent(new AuditEvent(
            Guid.NewGuid(),
            AuditEventCategory.Session,
            ActorIdentityId: identityId,
            SubjectIdentityId: identityId,
            Action: action,
            CorrelationId: correlationId,
            Metadata: new Dictionary<string, string>
            {
                ["reason"] = reason,
                ["lockoutEnforced"] = "false",
                ["rateLimitEnforced"] = "false",
                ["lockoutRateLimitPlaceholder"] = "explicit"
            },
            CreatedAt: DateTimeOffset.UtcNow), cancellationToken);
    }

    private static string NormalizeCorrelationId(string? correlationId)
    {
        return string.IsNullOrWhiteSpace(correlationId) ? Guid.NewGuid().ToString("N") : correlationId.Trim();
    }
}

public static class PasswordHashVerifier
{
    public static bool Verify(string password, string encodedHash, string algorithm)
    {
        if (!algorithm.Equals("PBKDF2-SHA256", StringComparison.OrdinalIgnoreCase) &&
            !algorithm.Equals("PBKDF2_SHA256", StringComparison.OrdinalIgnoreCase) &&
            !algorithm.Equals("PBKDF2", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var parts = encodedHash.Split('$', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 4 ||
            !parts[0].Equals("pbkdf2-sha256", StringComparison.OrdinalIgnoreCase) ||
            !int.TryParse(parts[1], out var iterations) ||
            iterations < 100_000)
        {
            return false;
        }

        try
        {
            var salt = Convert.FromBase64String(parts[2]);
            var expected = Convert.FromBase64String(parts[3]);
            var actual = Rfc2898DeriveBytes.Pbkdf2(
                password,
                salt,
                iterations,
                HashAlgorithmName.SHA256,
                expected.Length);

            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        catch (FormatException)
        {
            return false;
        }
    }
}

public sealed record LoginRuntimeRequest(
    string LoginId,
    string Password,
    string? CorrelationId);

public sealed record LoginRuntimeResult(
    bool Success,
    CredentialFailureReason FailureReason,
    Identity? Identity,
    Session? Session,
    string CorrelationId,
    string? RuntimeUnavailableReason)
{
    public static LoginRuntimeResult Successful(Identity identity, Session session, string correlationId)
    {
        return new LoginRuntimeResult(true, CredentialFailureReason.None, identity, session, correlationId, null);
    }

    public static LoginRuntimeResult Failed(
        CredentialFailureReason failureReason,
        string correlationId,
        string? runtimeUnavailableReason = null)
    {
        return new LoginRuntimeResult(false, failureReason, null, null, correlationId, runtimeUnavailableReason);
    }
}

public sealed record SessionValidationResult(
    bool Valid,
    Guid SessionId,
    string Reason,
    Session? Session,
    Identity? Identity,
    IReadOnlyCollection<Role> Roles,
    IReadOnlyCollection<string> Permissions)
{
    public static SessionValidationResult ValidResult(
        Session session,
        Identity identity,
        IReadOnlyCollection<Role> roles,
        IReadOnlyCollection<string> permissions)
    {
        return new SessionValidationResult(true, session.Id, "valid", session, identity, roles, permissions);
    }

    public static SessionValidationResult Invalid(
        Guid sessionId,
        string reason,
        Session? session = null,
        Identity? identity = null)
    {
        return new SessionValidationResult(false, sessionId, reason, session, identity, [], []);
    }
}

public sealed record LogoutRuntimeResult(
    bool Success,
    Guid SessionId,
    string CorrelationId,
    DateTimeOffset? RevokedAt,
    string? FailureReason);
