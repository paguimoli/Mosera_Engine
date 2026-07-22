using System.Security.Cryptography;
using System.Text;
using AuthService.Application.Contracts;
using AuthService.Domain.Models;

namespace AuthService.Application.Services;

public sealed class AuthenticationAuthorityService(
    IAuthenticationAuthorityRepository repository,
    Argon2idPasswordService passwords,
    AuthAccessTokenService accessTokens,
    IRoleRepository roles,
    IPermissionRepository permissions)
{
    private static readonly TimeSpan IdleTimeout = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan AbsoluteTimeout = TimeSpan.FromHours(12);

    public AuthenticationAuthorityMode AuthorityMode => ParseAuthorityMode(Environment.GetEnvironmentVariable("AUTH_AUTHORITY"));

    public async Task<CanonicalIdentity> CreateIdentityAsync(CreateCanonicalIdentityRequest request, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        await EnsureGovernanceActor(request.ActorIdentityId, allowInitialBootstrap: true, cancellationToken);
        var username = NormalizeRequired(request.Username, "username");
        var email = NormalizeOptional(request.Email);
        var policyErrors = passwords.ValidatePassword(request.Password, username, email);
        if (policyErrors.Count > 0) throw new InvalidOperationException(string.Join(',', policyErrors));
        if (request.InitialStatus is CanonicalIdentityStatus.Deleted or CanonicalIdentityStatus.Compromised) throw new InvalidOperationException("invalid_initial_identity_status");

        var now = DateTimeOffset.UtcNow;
        var identity = new CanonicalIdentity(request.IdentityId, request.TenantId, request.BrandId, request.Username.Trim(), username, request.Email?.Trim(), email, request.AccountType.Trim().ToUpperInvariant(), request.InitialStatus, "ACTIVE", "NOT_ENROLLED", now, null, now.AddDays(90));
        var credential = await BuildCredential(identity.IdentityId, 1, request.Password, now, cancellationToken);
        return await repository.CreateIdentity(identity, credential, Evidence(identity, request.ActorIdentityId, identity.IdentityId, "IDENTITY_CREATED", "SUCCESS", "created", request.CorrelationId, request.IpAddress, request.UserAgent), cancellationToken);
    }

    public async Task<CanonicalLoginResult> LoginAsync(CanonicalLoginRequest request, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        var correlationId = NormalizeCorrelationId(request.CorrelationId);
        var identity = await repository.FindIdentityByIdentifier(NormalizeRequired(request.Identifier, "identifier"), cancellationToken);
        if (identity is null)
        {
            await PerformDummyHash(request.Password, cancellationToken);
            await repository.AppendAnonymousLoginFailure(HashOpaqueToken(NormalizeRequired(request.Identifier, "identifier")), "invalid_credentials", correlationId, request.IpAddress, request.UserAgent, cancellationToken);
            return new CanonicalLoginResult(false, "invalid_credentials", null, null, null, correlationId);
        }

        if (identity.Status is not (CanonicalIdentityStatus.Active or CanonicalIdentityStatus.Emergency))
        {
            await PerformDummyHash(request.Password, cancellationToken);
            await repository.AppendAudit(Evidence(identity, null, identity.IdentityId, "LOGIN", "DENIED", $"identity_{identity.Status.ToString().ToLowerInvariant()}", correlationId, request.IpAddress, request.UserAgent), cancellationToken);
            return new CanonicalLoginResult(false, "invalid_credentials", null, null, null, correlationId);
        }

        var credential = await repository.FindActivePasswordCredential(identity.IdentityId, cancellationToken);
        if (credential is null || credential.Compromised || !await passwords.VerifyAsync(request.Password, credential.PasswordHash, cancellationToken))
        {
            await repository.AppendAudit(Evidence(identity, null, identity.IdentityId, "LOGIN", "FAILURE", "invalid_credentials", correlationId, request.IpAddress, request.UserAgent), cancellationToken);
            return new CanonicalLoginResult(false, "invalid_credentials", null, null, null, correlationId);
        }

        var now = DateTimeOffset.UtcNow;
        var opaqueToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var session = new CanonicalSession(Guid.NewGuid(), identity.IdentityId, opaqueToken, HashOpaqueToken(opaqueToken), now, now.Add(IdleTimeout), now.Add(AbsoluteTimeout), null, request.IpAddress, request.UserAgent, request.DeviceMetadata);
        var identityRoles = await roles.ListRoles(identity.IdentityId, cancellationToken);
        var identityPermissions = await permissions.ListPermissions(identity.IdentityId, cancellationToken);
        var tokenArtifacts = await accessTokens.PrepareCanonicalTokensAsync(identity, session, identityRoles, identityPermissions, correlationId, cancellationToken);
        var established = await repository.EstablishSession(
            identity,
            session,
            tokenArtifacts,
            Evidence(identity, identity.IdentityId, identity.IdentityId, "LOGIN", "SUCCESS", "credential_verified", correlationId, request.IpAddress, request.UserAgent),
            Evidence(identity, identity.IdentityId, identity.IdentityId, "SESSION_CREATED", "SUCCESS", "single_session_replacement", correlationId, request.IpAddress, request.UserAgent),
            cancellationToken);
        return new CanonicalLoginResult(true, null, identity, established, tokenArtifacts, correlationId);
    }

    public async Task<PasswordCredentialVersion> RotatePasswordAsync(PasswordRotationRequest request, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        var identity = await RequireIdentity(request.IdentityId, cancellationToken);
        var current = await repository.FindActivePasswordCredential(identity.IdentityId, cancellationToken) ?? throw new InvalidOperationException("active_credential_not_found");
        if (!await passwords.VerifyAsync(request.CurrentPassword, current.PasswordHash, cancellationToken)) throw new InvalidOperationException("invalid_credentials");
        return await PersistNewPassword(identity, request.NewPassword, request.ActorIdentityId ?? request.IdentityId, "PASSWORD_CHANGED", "credential_rotation", request.CorrelationId, request.IpAddress, request.UserAgent, cancellationToken);
    }

    public async Task<PasswordCredentialVersion> ResetPasswordAsync(PasswordResetAuthorityRequest request, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        await EnsureGovernanceActor(request.ActorIdentityId, allowInitialBootstrap: false, cancellationToken);
        var identity = await RequireIdentity(request.IdentityId, cancellationToken);
        var credential = await PersistNewPassword(identity, request.NewPassword, request.ActorIdentityId, "PASSWORD_RESET", request.Reason, request.CorrelationId, request.IpAddress, request.UserAgent, cancellationToken);
        await repository.RevokeAllSessions(identity.IdentityId, Evidence(identity, request.ActorIdentityId, identity.IdentityId, "LOGOUT_ALL", "SUCCESS", "credential_reset", request.CorrelationId, request.IpAddress, request.UserAgent), cancellationToken);
        return credential;
    }

    public async Task<PublicPasswordResetResult> RequestPasswordResetAsync(PublicPasswordResetRequest request, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        const string message = "If the account exists, password reset instructions have been generated.";
        var identity = await repository.FindIdentityByIdentifier(NormalizeRequired(request.Identifier, "identifier"), cancellationToken);
        if (identity is null || identity.Status is not (CanonicalIdentityStatus.Active or CanonicalIdentityStatus.Emergency)) return new PublicPasswordResetResult(true, message, null);
        var rawToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var now = DateTimeOffset.UtcNow;
        var reset = new PasswordResetAuthorityRecord(Guid.NewGuid(), identity.IdentityId, HashOpaqueToken(rawToken), now.AddMinutes(30), now);
        await repository.CreatePasswordResetRequest(reset, Evidence(identity, identity.IdentityId, identity.IdentityId, "PASSWORD_RESET_REQUESTED", "SUCCESS", "reset_requested", request.CorrelationId, request.IpAddress, request.UserAgent), cancellationToken);
        var exposeToken = !string.Equals(Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT"), "Production", StringComparison.OrdinalIgnoreCase);
        return new PublicPasswordResetResult(true, message, exposeToken ? rawToken : null);
    }

    public async Task<PasswordCredentialVersion> ConfirmPasswordResetAsync(PublicPasswordResetConfirmRequest request, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        var reset = await repository.FindActivePasswordResetByHash(HashOpaqueToken(request.ResetToken), cancellationToken) ?? throw new InvalidOperationException("invalid_password_reset_token");
        var identity = await RequireIdentity(reset.IdentityId, cancellationToken);
        var errors = passwords.ValidatePassword(request.NewPassword, identity.NormalizedUsername, identity.NormalizedEmail);
        if (errors.Count > 0) throw new InvalidOperationException(string.Join(',', errors));
        var history = await repository.ListPasswordHistory(identity.IdentityId, 12, cancellationToken);
        foreach (var historic in history)
        {
            if (await passwords.VerifyAsync(request.NewPassword, historic.PasswordHash, cancellationToken)) throw new InvalidOperationException("password_reuse_rejected");
        }
        var now = DateTimeOffset.UtcNow;
        var credential = await BuildCredential(identity.IdentityId, history.Count == 0 ? 1 : history.Max(item => item.Version) + 1, request.NewPassword, now, cancellationToken);
        return await repository.ConsumePasswordReset(
            reset,
            credential,
            Evidence(identity, identity.IdentityId, identity.IdentityId, "PASSWORD_RESET", "SUCCESS", "reset_token_consumed", request.CorrelationId, request.IpAddress, request.UserAgent),
            Evidence(identity, identity.IdentityId, identity.IdentityId, "LOGOUT_ALL", "SUCCESS", "password_reset", request.CorrelationId, request.IpAddress, request.UserAgent),
            cancellationToken);
    }

    public async Task<CanonicalIdentity> TransitionAsync(LifecycleTransitionRequest request, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        await EnsureGovernanceActor(request.ActorIdentityId, allowInitialBootstrap: false, cancellationToken);
        if (!AllowedTransition(request.ExpectedStatus, request.TargetStatus)) throw new InvalidOperationException("invalid_lifecycle_transition");
        var identity = await RequireIdentity(request.IdentityId, cancellationToken);
        var evidence = Evidence(identity, request.ActorIdentityId, identity.IdentityId, request.TargetStatus.ToString().ToUpperInvariant(), "SUCCESS", request.Reason, request.CorrelationId, request.IpAddress, request.UserAgent);
        var transitioned = await repository.TransitionIdentity(identity.IdentityId, request.ExpectedStatus, request.TargetStatus, evidence, cancellationToken);
        if (request.TargetStatus is CanonicalIdentityStatus.Disabled or CanonicalIdentityStatus.Locked or CanonicalIdentityStatus.Compromised or CanonicalIdentityStatus.Deleted)
        {
            await repository.RevokeAllSessions(identity.IdentityId, Evidence(identity, request.ActorIdentityId, identity.IdentityId, "SESSION_REVOKED", "SUCCESS", $"identity_{request.TargetStatus.ToString().ToLowerInvariant()}", request.CorrelationId, request.IpAddress, request.UserAgent), cancellationToken);
        }
        return transitioned;
    }

    public async Task<CanonicalSession?> ValidateSessionAsync(string opaqueToken, bool renew, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        var session = await repository.FindSessionByHash(HashOpaqueToken(opaqueToken), cancellationToken);
        if (session is null || session.RevokedAt is not null || session.IdleExpiresAt <= DateTimeOffset.UtcNow || session.AbsoluteExpiresAt <= DateTimeOffset.UtcNow) return null;
        var identity = await repository.FindIdentityById(session.IdentityId, cancellationToken);
        if (identity?.Status is not (CanonicalIdentityStatus.Active or CanonicalIdentityStatus.Emergency)) return null;
        if (!renew) return session with { OpaqueToken = opaqueToken };
        var renewedIdle = DateTimeOffset.UtcNow.Add(IdleTimeout);
        if (renewedIdle > session.AbsoluteExpiresAt) renewedIdle = session.AbsoluteExpiresAt;
        return await repository.RenewSession(session.TokenHash, renewedIdle, cancellationToken) is { } renewed ? renewed with { OpaqueToken = opaqueToken } : null;
    }

    public async Task<int> LogoutAsync(string opaqueToken, string? correlationId, string? ipAddress, string? userAgent, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        var session = await repository.FindSessionByHash(HashOpaqueToken(opaqueToken), cancellationToken);
        if (session is null) return 0;
        var identity = await RequireIdentity(session.IdentityId, cancellationToken);
        return await repository.RevokeSession(session.TokenHash, Evidence(identity, identity.IdentityId, identity.IdentityId, "LOGOUT", "SUCCESS", "user_logout", correlationId, ipAddress, userAgent), cancellationToken);
    }

    public async Task<int> LogoutAllAsync(Guid identityId, Guid actorIdentityId, string reason, string? correlationId, string? ipAddress, string? userAgent, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        if (actorIdentityId != identityId)
        {
            await EnsureGovernanceActor(actorIdentityId, allowInitialBootstrap: false, cancellationToken);
        }
        var identity = await RequireIdentity(identityId, cancellationToken);
        return await repository.RevokeAllSessions(identityId, Evidence(identity, actorIdentityId, identityId, "LOGOUT_ALL", "SUCCESS", reason, correlationId, ipAddress, userAgent), cancellationToken);
    }

    public async Task<int> ForceRevokeSessionAsync(Guid sessionId, Guid identityId, Guid actorIdentityId, string reason, string? correlationId, string? ipAddress, string? userAgent, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        await EnsureGovernanceActor(actorIdentityId, allowInitialBootstrap: false, cancellationToken);
        var identity = await RequireIdentity(identityId, cancellationToken);
        return await repository.RevokeSessionById(sessionId, Evidence(identity, actorIdentityId, identityId, "SESSION_REVOKED", "SUCCESS", reason, correlationId, ipAddress, userAgent), cancellationToken);
    }

    public async Task<AuthenticationAuthorityReadiness> GetReadinessAsync(CancellationToken cancellationToken = default)
    {
        var reachable = repository.RuntimeAvailable && await repository.CheckReadiness(cancellationToken);
        var blockers = new List<string>();
        if (!reachable) blockers.Add("canonical_auth_database_unavailable");
        if (AuthorityMode == AuthenticationAuthorityMode.Service) blockers.Add("service_authority_promotion_not_approved");
        return new AuthenticationAuthorityReadiness(AuthorityMode, reachable, true, reachable, reachable, true, reachable, reachable, false, blockers);
    }

    public async Task RecordAuditAsync(Guid subjectIdentityId, Guid? actorIdentityId, string action, string result, string reason, string? correlationId, string? ipAddress, string? userAgent, CancellationToken cancellationToken = default)
    {
        EnsureRuntime();
        var identity = await RequireIdentity(subjectIdentityId, cancellationToken);
        await repository.AppendAudit(Evidence(identity, actorIdentityId, subjectIdentityId, action, result, reason, correlationId, ipAddress, userAgent), cancellationToken);
    }

    public static string HashOpaqueToken(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    private async Task<PasswordCredentialVersion> PersistNewPassword(CanonicalIdentity identity, string newPassword, Guid actorIdentityId, string action, string reason, string? correlationId, string? ipAddress, string? userAgent, CancellationToken cancellationToken)
    {
        var errors = passwords.ValidatePassword(newPassword, identity.NormalizedUsername, identity.NormalizedEmail);
        if (errors.Count > 0) throw new InvalidOperationException(string.Join(',', errors));
        var history = await repository.ListPasswordHistory(identity.IdentityId, 12, cancellationToken);
        foreach (var historic in history)
        {
            if (await passwords.VerifyAsync(newPassword, historic.PasswordHash, cancellationToken)) throw new InvalidOperationException("password_reuse_rejected");
        }
        var now = DateTimeOffset.UtcNow;
        var credential = await BuildCredential(identity.IdentityId, history.Count == 0 ? 1 : history.Max(item => item.Version) + 1, newPassword, now, cancellationToken);
        return await repository.RotatePassword(identity.IdentityId, credential, Evidence(identity, actorIdentityId, identity.IdentityId, action, "SUCCESS", reason, correlationId, ipAddress, userAgent), cancellationToken);
    }

    private async Task<PasswordCredentialVersion> BuildCredential(Guid identityId, int version, string password, DateTimeOffset now, CancellationToken cancellationToken) =>
        new(Guid.NewGuid(), identityId, version, await passwords.HashAsync(password, cancellationToken), "ARGON2ID", passwords.MemoryCostKiB, passwords.Iterations, passwords.Parallelism, false, now, version > 1 ? now : null, null);

    private async Task<CanonicalIdentity> RequireIdentity(Guid identityId, CancellationToken cancellationToken) =>
        await repository.FindIdentityById(identityId, cancellationToken) ?? throw new InvalidOperationException("identity_not_found");

    private async Task PerformDummyHash(string password, CancellationToken cancellationToken)
    {
        var dummy = await passwords.HashAsync("Mosera-Dummy-Auth-Work!2026", cancellationToken);
        await passwords.VerifyAsync(password, dummy, cancellationToken);
    }

    private static AuthenticationAuditEvidence Evidence(CanonicalIdentity identity, Guid? actor, Guid? subject, string action, string result, string reason, string? correlationId, string? ipAddress, string? userAgent) =>
        new(Guid.NewGuid(), identity.TenantId, identity.BrandId, actor, subject, action, result, reason, NormalizeCorrelationId(correlationId), DateTimeOffset.UtcNow, ipAddress, userAgent, "AUTH_SERVICE");

    private static bool AllowedTransition(CanonicalIdentityStatus from, CanonicalIdentityStatus to) => (from, to) switch
    {
        (CanonicalIdentityStatus.Disabled, CanonicalIdentityStatus.Active) => true,
        (CanonicalIdentityStatus.Locked, CanonicalIdentityStatus.Active) => true,
        (CanonicalIdentityStatus.Compromised, CanonicalIdentityStatus.Active) => true,
        (CanonicalIdentityStatus.Active, CanonicalIdentityStatus.Disabled or CanonicalIdentityStatus.Locked or CanonicalIdentityStatus.Compromised or CanonicalIdentityStatus.Emergency or CanonicalIdentityStatus.Deleted) => true,
        (CanonicalIdentityStatus.Emergency, CanonicalIdentityStatus.Disabled or CanonicalIdentityStatus.Locked) => true,
        _ => false
    };

    private void EnsureRuntime()
    {
        if (!repository.RuntimeAvailable) throw new InvalidOperationException("canonical_auth_runtime_unavailable");
        if (AuthorityMode == AuthenticationAuthorityMode.Service) throw new InvalidOperationException("service_authority_not_promoted");
    }

    private async Task EnsureGovernanceActor(Guid? actorIdentityId, bool allowInitialBootstrap, CancellationToken cancellationToken)
    {
        if (actorIdentityId is Guid actor && await repository.HasSuperAdminGovernance(actor, cancellationToken)) return;

        if (allowInitialBootstrap && actorIdentityId is null &&
            string.Equals(Environment.GetEnvironmentVariable("AUTH_ALLOW_INITIAL_BOOTSTRAP"), "true", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        throw new InvalidOperationException("super_admin_governance_required");
    }

    private static string NormalizeRequired(string value, string name) => string.IsNullOrWhiteSpace(value) ? throw new ArgumentException($"{name}_required") : value.Trim().ToLowerInvariant();
    private static string? NormalizeOptional(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim().ToLowerInvariant();
    private static string NormalizeCorrelationId(string? value) => string.IsNullOrWhiteSpace(value) ? Guid.NewGuid().ToString("N") : value.Trim();
    private static AuthenticationAuthorityMode ParseAuthorityMode(string? value) => value?.Trim().ToUpperInvariant() switch
    {
        "SERVICE_SHADOW" => AuthenticationAuthorityMode.ServiceShadow,
        "SERVICE_DRY_RUN" => AuthenticationAuthorityMode.ServiceDryRun,
        "SERVICE" => AuthenticationAuthorityMode.Service,
        _ => AuthenticationAuthorityMode.Monolith
    };
}
