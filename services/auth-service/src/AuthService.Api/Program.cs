using System.Text.Json.Serialization;
using AuthService.Application;
using AuthService.Application.Contracts;
using AuthService.Application.Services;
using AuthService.Domain.Models;
using AuthService.Infrastructure;

var builder = WebApplication.CreateBuilder(args);
var databaseUrl = Environment.GetEnvironmentVariable("DATABASE_URL");

builder.Services.AddSingleton<AuthArchitectureService>();
builder.Services.AddSingleton<AuthInfrastructureStatusProvider>();
builder.Services.AddSingleton<IdentityMappingService>();
builder.Services.AddSingleton<ShadowValidationService>();
builder.Services.AddHttpClient<SupabaseLegacyPlatformIdentitySource>();
builder.Services.AddSingleton<ILegacyPlatformIdentitySource>(services =>
{
    var source = services.GetRequiredService<SupabaseLegacyPlatformIdentitySource>();
    return source.Configured ? source : new EmptyLegacyPlatformIdentitySource();
});
builder.Services.AddSingleton<ShadowIdentityImportService>();
builder.Services.AddSingleton<MigrationReadinessService>();
if (string.IsNullOrWhiteSpace(databaseUrl))
{
    builder.Services.AddSingleton<DisabledAuthRepository>();
    builder.Services.AddSingleton<IIdentityRepository>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<ICredentialRepository>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<IRoleRepository>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<IPermissionRepository>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<IMembershipRepository>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<ISessionRepository>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<IAuditEventRepository>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<ITokenRepository>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<IRefreshTokenRepository>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<IServiceAccountRepository>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<ISigningKeyRepository>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<IAuthRuntimeStore>(services => services.GetRequiredService<DisabledAuthRepository>());
    builder.Services.AddSingleton<IAuthenticationAuthorityRepository, DisabledAuthenticationAuthorityRepository>();
}
else
{
    builder.Services.AddSingleton(_ => new PostgresAuthRepository(databaseUrl));
    builder.Services.AddSingleton<IIdentityRepository>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<ICredentialRepository>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<IRoleRepository>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<IPermissionRepository>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<IMembershipRepository>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<ISessionRepository>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<IAuditEventRepository>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<ITokenRepository>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<IRefreshTokenRepository>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<IServiceAccountRepository>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<ISigningKeyRepository>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<IAuthRuntimeStore>(services => services.GetRequiredService<PostgresAuthRepository>());
    builder.Services.AddSingleton<IAuthenticationAuthorityRepository>(_ => new PostgresAuthenticationAuthorityRepository(databaseUrl));
}
builder.Services.AddSingleton<AuthLoginRuntimeService>();
builder.Services.AddSingleton<AuthAccessTokenService>();
builder.Services.AddSingleton<Argon2idPasswordService>();
builder.Services.AddSingleton<AuthenticationAuthorityService>();
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    service = "auth-service",
    productionAuthenticationEnabled = true,
    productionTokenIssuanceEnabled = true,
    nextJsCutoverEnabled = false,
    timestamp = DateTimeOffset.UtcNow
}));

app.MapGet("/health/live", () => Results.Ok(new
{
    status = "ok",
    service = "auth-service",
    check = "live",
    timestamp = DateTimeOffset.UtcNow
}));

async Task<IResult> ReadyResult(
    AuthInfrastructureStatusProvider infrastructure,
    AuthenticationAuthorityService authority,
    CancellationToken cancellationToken)
{
    var status = infrastructure.GetStatus();
    var authorityReadiness = await authority.GetReadinessAsync(cancellationToken);
    var ready = string.IsNullOrWhiteSpace(databaseUrl) || (status.DatabaseReady && authorityReadiness.DatabaseReachable);
    var response = new
    {
        status = ready ? "ready" : "not_ready",
        service = "auth-service",
        architectureOnly = false,
        runtimeScope = "login-session-access-token",
        productionTokenIssuanceEnabled = true,
        oauthRuntimeEnabled = false,
        nextJsCutoverEnabled = false,
        infrastructure = status,
        authenticationAuthority = authorityReadiness,
        timestamp = DateTimeOffset.UtcNow
    };

    return ready ? Results.Ok(response) : Results.Json(response, statusCode: StatusCodes.Status503ServiceUnavailable);
}

app.MapGet("/ready", ReadyResult);
app.MapGet("/health/ready", ReadyResult);

var group = app.MapGroup("/api/auth-service");

group.MapGet("/status", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetStatus()
}));

group.MapGet("/identity-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetIdentityModel()
}));

group.MapGet("/oauth-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetOAuthModel()
}));

group.MapGet("/oauth-model/runtime", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetOAuthRuntimeModel()
}));

group.MapGet("/policy-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetPolicyModel()
}));

group.MapGet("/session-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetSessionModel()
}));

group.MapGet("/token-issuance-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetTokenIssuanceModel()
}));

group.MapGet("/jwks-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetJwksModel()
}));

group.MapGet("/service-auth-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetServiceAuthModel()
}));

group.MapGet("/session-readiness", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetSessionReadiness()
}));

group.MapGet("/token-readiness", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetTokenReadiness()
}));

group.MapGet("/oauth-readiness", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetOAuthReadiness()
}));

group.MapGet("/persistence-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetPersistenceModel()
}));

group.MapGet("/credential-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetCredentialModel()
}));

group.MapGet("/credential-verification-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetCredentialVerificationModel()
}));

group.MapGet("/password-policy", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetPasswordPolicy()
}));

group.MapGet("/mfa-policy", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetMfaPolicy()
}));

group.MapGet("/authentication-eligibility", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetAuthenticationEligibility()
}));

group.MapGet("/credential-verifiers", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetCredentialVerifiers()
}));

group.MapGet("/token-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetTokenModel()
}));

group.MapGet("/migration-readiness", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetMigrationReadiness()
}));

group.MapGet("/migration-plan", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetMigrationPlan()
}));

group.MapGet("/coexistence-status", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetCoexistenceStatus()
}));

group.MapGet("/compatibility-model", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetCompatibilityModel()
}));

group.MapGet("/schema-status", (AuthArchitectureService service) => Results.Ok(new
{
    success = true,
    data = service.GetSchemaStatus()
}));

group.MapPost("/login", async (
    AuthenticationAuthorityService service,
    LoginEndpointRequest request,
    HttpRequest httpRequest,
    CancellationToken cancellationToken) =>
{
    var result = await service.LoginAsync(
        new CanonicalLoginRequest(
            request.LoginId ?? string.Empty,
            request.Password ?? string.Empty,
            request.CorrelationId,
            ReadClientIp(httpRequest),
            httpRequest.Headers.UserAgent.FirstOrDefault(),
            httpRequest.Headers["X-Device-Metadata"].FirstOrDefault()),
        cancellationToken);

    if (!result.Success)
    {
        var failure = new
        {
            success = false,
            error = "Invalid login credentials.",
            failureReason = result.FailureReason,
            correlationId = result.CorrelationId,
            lockoutEnforced = false,
            rateLimitEnforced = false,
            productionLockoutRateLimitReady = false
        };

        return Results.Json(failure, statusCode: StatusCodes.Status401Unauthorized);
    }

    return Results.Ok(new
    {
        success = true,
        session = ToCanonicalSessionResponse(result.Session!),
        sessionToken = result.Session!.OpaqueToken,
        identity = ToCanonicalIdentityResponse(result.Identity!),
        accessToken = result.Tokens!.AccessToken,
        tokenType = "Bearer",
        accessTokenExpiresAt = result.Tokens.AccessExpiresAt,
        accessTokenKeyId = result.Tokens.SigningKeyName,
        accessTokenJwtId = result.Tokens.JwtId,
        issuer = result.Tokens.Issuer,
        audience = result.Tokens.Audience,
        refreshToken = result.Tokens.RefreshToken,
        refreshTokenId = result.Tokens.RefreshTokenId,
        refreshTokenExpiresAt = result.Tokens.RefreshExpiresAt,
        correlationId = result.CorrelationId,
        tokenIssued = true,
        refreshTokenIssued = true,
        oauthFlow = false,
        nextJsCutover = false,
        lockoutEnforced = false,
        rateLimitEnforced = false,
        productionLockoutRateLimitReady = false
    });
});

group.MapGet("/authority/readiness", async (AuthenticationAuthorityService service, CancellationToken cancellationToken) =>
{
    var readiness = await service.GetReadinessAsync(cancellationToken);
    return readiness.DatabaseReachable ? Results.Ok(readiness) : Results.Json(readiness, statusCode: StatusCodes.Status503ServiceUnavailable);
});

group.MapPost("/authority/identities", async (AuthenticationAuthorityService service, CreateIdentityEndpointRequest request, HttpRequest httpRequest, CancellationToken cancellationToken) =>
{
    try
    {
        var identity = await service.CreateIdentityAsync(new CreateCanonicalIdentityRequest(
            request.IdentityId ?? Guid.NewGuid(), request.TenantId, request.BrandId, request.Username ?? string.Empty,
            request.Email, request.AccountType ?? "ADMIN", request.InitialStatus, request.Password ?? string.Empty,
            request.ActorIdentityId, request.CorrelationId, ReadClientIp(httpRequest), httpRequest.Headers.UserAgent.FirstOrDefault()), cancellationToken);
        return Results.Created($"/api/auth-service/authority/identities/{identity.IdentityId}", ToCanonicalIdentityResponse(identity));
    }
    catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or Npgsql.PostgresException)
    {
        return Results.BadRequest(new { success = false, error = exception.Message });
    }
});

group.MapPost("/authority/password/change", async (AuthenticationAuthorityService service, PasswordChangeEndpointRequest request, HttpRequest httpRequest, CancellationToken cancellationToken) =>
{
    try
    {
        var credential = await service.RotatePasswordAsync(new PasswordRotationRequest(request.IdentityId, request.CurrentPassword ?? string.Empty, request.NewPassword ?? string.Empty, request.CorrelationId, request.ActorIdentityId, ReadClientIp(httpRequest), httpRequest.Headers.UserAgent.FirstOrDefault()), cancellationToken);
        return Results.Ok(new { success = true, credentialVersion = credential.Version, credentialId = credential.CredentialVersionId, algorithm = credential.Algorithm });
    }
    catch (Exception exception) when (exception is ArgumentException or InvalidOperationException)
    {
        return Results.BadRequest(new { success = false, error = exception.Message });
    }
});

group.MapPost("/authority/password/reset", async (AuthenticationAuthorityService service, PasswordResetEndpointRequest request, HttpRequest httpRequest, CancellationToken cancellationToken) =>
{
    try
    {
        var credential = await service.ResetPasswordAsync(new PasswordResetAuthorityRequest(request.IdentityId, request.NewPassword ?? string.Empty, request.ActorIdentityId, request.Reason ?? "governed_reset", request.CorrelationId, ReadClientIp(httpRequest), httpRequest.Headers.UserAgent.FirstOrDefault()), cancellationToken);
        return Results.Ok(new { success = true, credentialVersion = credential.Version, credentialId = credential.CredentialVersionId, algorithm = credential.Algorithm });
    }
    catch (Exception exception) when (exception is ArgumentException or InvalidOperationException)
    {
        return Results.BadRequest(new { success = false, error = exception.Message });
    }
});

group.MapPost("/authority/password-reset/request", async (AuthenticationAuthorityService service, PublicPasswordResetEndpointRequest request, HttpRequest httpRequest, CancellationToken cancellationToken) =>
{
    var result = await service.RequestPasswordResetAsync(new PublicPasswordResetRequest(request.Identifier ?? string.Empty, request.CorrelationId, ReadClientIp(httpRequest), httpRequest.Headers.UserAgent.FirstOrDefault()), cancellationToken);
    return Results.Ok(new { success = result.Success, message = result.Message, resetToken = result.ResetToken });
});

group.MapPost("/authority/password-reset/confirm", async (AuthenticationAuthorityService service, PublicPasswordResetConfirmEndpointRequest request, HttpRequest httpRequest, CancellationToken cancellationToken) =>
{
    try
    {
        var credential = await service.ConfirmPasswordResetAsync(new PublicPasswordResetConfirmRequest(request.ResetToken ?? string.Empty, request.NewPassword ?? string.Empty, request.CorrelationId, ReadClientIp(httpRequest), httpRequest.Headers.UserAgent.FirstOrDefault()), cancellationToken);
        return Results.Ok(new { success = true, credentialVersion = credential.Version });
    }
    catch (Exception exception) when (exception is ArgumentException or InvalidOperationException)
    {
        return Results.BadRequest(new { success = false, errors = new[] { exception.Message } });
    }
});

group.MapPost("/authority/lifecycle", async (AuthenticationAuthorityService service, LifecycleEndpointRequest request, HttpRequest httpRequest, CancellationToken cancellationToken) =>
{
    try
    {
        var identity = await service.TransitionAsync(new LifecycleTransitionRequest(request.IdentityId, request.ExpectedStatus, request.TargetStatus, request.ActorIdentityId, request.Reason ?? "governed_transition", request.CorrelationId, ReadClientIp(httpRequest), httpRequest.Headers.UserAgent.FirstOrDefault()), cancellationToken);
        return Results.Ok(new { success = true, identity = ToCanonicalIdentityResponse(identity) });
    }
    catch (Exception exception) when (exception is ArgumentException or InvalidOperationException)
    {
        return Results.BadRequest(new { success = false, error = exception.Message });
    }
});

group.MapPost("/authority/session/validate", async (AuthenticationAuthorityService service, CanonicalSessionEndpointRequest request, CancellationToken cancellationToken) =>
{
    var session = await service.ValidateSessionAsync(request.SessionToken ?? string.Empty, request.Renew, cancellationToken);
    return session is null
        ? Results.Json(new { success = false, valid = false }, statusCode: StatusCodes.Status401Unauthorized)
        : Results.Ok(new { success = true, valid = true, session = ToCanonicalSessionResponse(session) });
});

group.MapPost("/authority/logout", async (AuthenticationAuthorityService service, CanonicalLogoutEndpointRequest request, HttpRequest httpRequest, CancellationToken cancellationToken) =>
{
    var revoked = await service.LogoutAsync(request.SessionToken ?? string.Empty, request.CorrelationId, ReadClientIp(httpRequest), httpRequest.Headers.UserAgent.FirstOrDefault(), cancellationToken);
    return Results.Ok(new { success = true, revoked });
});

group.MapPost("/authority/logout-all", async (AuthenticationAuthorityService service, CanonicalLogoutAllEndpointRequest request, HttpRequest httpRequest, CancellationToken cancellationToken) =>
{
    var revoked = await service.LogoutAllAsync(request.IdentityId, request.ActorIdentityId, request.Reason ?? "logout_all", request.CorrelationId, ReadClientIp(httpRequest), httpRequest.Headers.UserAgent.FirstOrDefault(), cancellationToken);
    return Results.Ok(new { success = true, revoked });
});

group.MapPost("/authority/session/revoke", async (AuthenticationAuthorityService service, CanonicalSessionRevokeEndpointRequest request, HttpRequest httpRequest, CancellationToken cancellationToken) =>
{
    var revoked = await service.ForceRevokeSessionAsync(request.SessionId, request.IdentityId, request.ActorIdentityId, request.Reason ?? "forced_admin_revocation", request.CorrelationId, ReadClientIp(httpRequest), httpRequest.Headers.UserAgent.FirstOrDefault(), cancellationToken);
    return revoked > 0 ? Results.Ok(new { success = true, revoked }) : Results.NotFound(new { success = false, error = "active_session_not_found" });
});

group.MapPost("/authority/mfa/{operation}", (string operation) => Results.Json(new
{
    success = false,
    error = "mfa_mutation_deferred_to_security_hardening",
    operation,
    legacyMutationAllowed = false
}, statusCode: StatusCodes.Status501NotImplemented));

group.MapPost("/authority/audit", async (AuthenticationAuthorityService service, CanonicalAuditEndpointRequest request, HttpRequest httpRequest, CancellationToken cancellationToken) =>
{
    await service.RecordAuditAsync(request.SubjectIdentityId, request.ActorIdentityId, request.Action ?? "UNKNOWN", request.Result ?? "SUCCESS", request.Reason ?? "delegated_event", request.CorrelationId, ReadClientIp(httpRequest), httpRequest.Headers.UserAgent.FirstOrDefault(), cancellationToken);
    return Results.Accepted();
});

group.MapPost("/refresh", async (
    AuthAccessTokenService tokens,
    RefreshEndpointRequest request,
    CancellationToken cancellationToken) =>
{
    var result = await tokens.RefreshAsync(request.RefreshToken ?? string.Empty, request.CorrelationId, cancellationToken);
    return result.Success
        ? Results.Ok(new
        {
            success = true,
            accessToken = result.AccessToken!.AccessToken,
            tokenType = result.AccessToken.TokenType,
            accessTokenExpiresAt = result.AccessToken.ExpiresAt,
            accessTokenKeyId = result.AccessToken.KeyId,
            accessTokenJwtId = result.AccessToken.JwtId,
            issuer = result.AccessToken.Issuer,
            audience = result.AccessToken.Audience,
            refreshToken = result.RefreshToken,
            refreshTokenId = result.RefreshTokenId,
            refreshTokenExpiresAt = result.RefreshTokenExpiresAt,
            replayDetected = false
        })
        : Results.Json(new
        {
            success = false,
            error = result.Reason,
            replayDetected = result.ReplayDetected
        }, statusCode: StatusCodes.Status401Unauthorized);
});

group.MapPost("/service-token", async (
    AuthAccessTokenService tokens,
    ServiceTokenEndpointRequest request,
    CancellationToken cancellationToken) =>
{
    var result = await tokens.IssueServiceTokenAsync(
        request.ServiceName ?? string.Empty,
        request.ClientSecret ?? string.Empty,
        request.Scopes ?? [],
        request.CorrelationId,
        cancellationToken);

    return result.Success
        ? Results.Ok(new
        {
            success = true,
            accessToken = result.AccessToken,
            tokenType = result.TokenType,
            accessTokenExpiresAt = result.ExpiresAt,
            accessTokenKeyId = result.KeyId,
            accessTokenJwtId = result.JwtId,
            issuer = result.Issuer,
            audience = result.Audience,
            scopes = result.Scopes
        })
        : Results.Json(new
        {
            success = false,
            error = result.Reason
        }, statusCode: StatusCodes.Status401Unauthorized);
});

group.MapPost("/service-token/validate", async (
    AuthAccessTokenService tokens,
    ServiceTokenValidationEndpointRequest request,
    CancellationToken cancellationToken) =>
{
    var result = await tokens.ValidateServiceTokenAsync(
        request.AccessToken ?? string.Empty,
        request.RequiredScope,
        cancellationToken);

    return result.Valid
        ? Results.Ok(new
        {
            success = true,
            valid = true,
            reason = result.Reason,
            scopes = result.Scopes
        })
        : Results.Json(new
        {
            success = false,
            valid = false,
            reason = result.Reason
        }, statusCode: StatusCodes.Status401Unauthorized);
});

group.MapGet("/jwks", async (AuthAccessTokenService tokens, CancellationToken cancellationToken) =>
{
    var keys = await tokens.GetJwksAsync(cancellationToken);
    return Results.Ok(new
    {
        keys = keys.Select(ToJwksResponse)
    });
});

app.MapGet("/.well-known/jwks.json", async (AuthAccessTokenService tokens, CancellationToken cancellationToken) =>
{
    var keys = await tokens.GetJwksAsync(cancellationToken);
    return Results.Ok(new
    {
        keys = keys.Select(ToJwksResponse)
    });
});

group.MapPost("/tokens/validate", async (
    AuthAccessTokenService tokens,
    TokenValidationEndpointRequest request,
    CancellationToken cancellationToken) =>
{
    var result = await tokens.ValidateAsync(request.AccessToken ?? string.Empty, cancellationToken);
    return result.Valid
        ? Results.Ok(new
        {
            success = true,
            valid = true,
            reason = result.Reason,
            claims = result.Claims
        })
        : Results.Json(new
        {
            success = false,
            valid = false,
            reason = result.Reason
        }, statusCode: StatusCodes.Status401Unauthorized);
});

group.MapGet("/sessions/{sessionId:guid}", async (
    Guid sessionId,
    AuthLoginRuntimeService service,
    CancellationToken cancellationToken) =>
{
    var result = await service.ValidateSessionAsync(sessionId, cancellationToken);
    return result.Valid
        ? Results.Ok(new
        {
            success = true,
            valid = true,
            reason = result.Reason,
            session = ToSessionResponse(result.Session!),
            identity = ToIdentityResponse(result.Identity!),
            roles = result.Roles.Select(ToRoleResponse),
            groups = result.Roles.Select(ToGroupResponse),
            permissions = result.Permissions.Select(ToPermissionResponse),
            claims = result.Permissions.Select(permission => new
            {
                type = "permission",
                value = permission,
                issuer = "auth-service"
            })
        })
        : Results.Json(new
        {
            success = false,
            valid = false,
            reason = result.Reason,
            sessionId
        }, statusCode: StatusCodes.Status401Unauthorized);
});

group.MapGet("/me", async (
    HttpRequest httpRequest,
    AuthenticationAuthorityService service,
    IAuthenticationAuthorityRepository identities,
    IRoleRepository roles,
    IPermissionRepository permissions,
    CancellationToken cancellationToken) =>
{
    var sessionToken = ReadOpaqueSessionToken(httpRequest);
    if (sessionToken is null)
    {
        return Results.Json(new { success = false, error = "Session token is required." }, statusCode: StatusCodes.Status401Unauthorized);
    }

    var session = await service.ValidateSessionAsync(sessionToken, renew: true, cancellationToken);
    if (session is null)
    {
        return Results.Json(new
        {
            success = false,
            error = "Session is invalid."
        }, statusCode: StatusCodes.Status401Unauthorized);
    }
    var identity = await identities.FindIdentityById(session.IdentityId, cancellationToken);
    if (identity is null) return Results.Json(new { success = false, error = "Identity is invalid." }, statusCode: StatusCodes.Status401Unauthorized);
    var identityRoles = await roles.ListRoles(identity.IdentityId, cancellationToken);
    var identityPermissions = await permissions.ListPermissions(identity.IdentityId, cancellationToken);
    return Results.Ok(new
    {
        success = true,
        session = ToCanonicalSessionResponse(session),
        identity = ToCanonicalIdentityResponse(identity),
        roles = identityRoles.Select(ToRoleResponse),
        groups = identityRoles.Select(ToGroupResponse),
        permissions = identityPermissions.Select(ToPermissionResponse),
        claims = identityPermissions.Select(permission => new { type = "permission", value = permission, issuer = "auth-service" })
    });
});

group.MapPost("/logout", async (
    AuthenticationAuthorityService service,
    LogoutEndpointRequest request,
    HttpRequest httpRequest,
    CancellationToken cancellationToken) =>
{
    var token = request.SessionToken ?? request.SessionId;
    if (string.IsNullOrWhiteSpace(token)) return Results.BadRequest(new { success = false, error = "sessionToken is required." });
    var revoked = await service.LogoutAsync(token, request.CorrelationId, ReadClientIp(httpRequest), httpRequest.Headers.UserAgent.FirstOrDefault(), cancellationToken);
    return Results.Ok(new { success = true, revoked, correlationId = request.CorrelationId });
});

group.MapGet("/shadow-import-status", async (ShadowIdentityImportService service, CancellationToken cancellationToken) => Results.Ok(new
{
    success = true,
    data = await service.GetStatusAsync(cancellationToken)
}));

group.MapGet("/migration-validation", async (MigrationReadinessService service, CancellationToken cancellationToken) => Results.Ok(new
{
    success = true,
    data = await service.ValidateAsync(cancellationToken)
}));

group.MapGet("/migration-report", async (MigrationReadinessService service, CancellationToken cancellationToken) => Results.Ok(new
{
    success = true,
    data = await service.BuildReportAsync(cancellationToken)
}));

group.MapPost("/shadow-import/run", async (ShadowIdentityImportService service, CancellationToken cancellationToken) => Results.Ok(new
{
    success = true,
    data = await service.RunAsync(cancellationToken)
}));

app.Run();

static string? ReadOpaqueSessionToken(HttpRequest request)
{
    if (request.Headers.TryGetValue("X-Auth-Session-Id", out var sessionHeader) && !string.IsNullOrWhiteSpace(sessionHeader.FirstOrDefault()))
    {
        return sessionHeader.FirstOrDefault();
    }
    if (request.Headers.TryGetValue("Authorization", out var authorizationHeader))
    {
        var value = authorizationHeader.FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(value) && value.StartsWith("Session ", StringComparison.OrdinalIgnoreCase)) return value["Session ".Length..];
    }
    return null;
}

static string? ReadClientIp(HttpRequest request) =>
    request.Headers["X-Forwarded-For"].FirstOrDefault()?.Split(',')[0].Trim()
    ?? request.Headers["X-Real-IP"].FirstOrDefault()
    ?? request.HttpContext.Connection.RemoteIpAddress?.ToString();

static object ToIdentityResponse(AuthService.Domain.Models.Identity identity)
{
    return new
    {
        identityId = identity.Id,
        loginId = identity.LoginId.Value,
        identityType = identity.Type,
        lifecycleState = identity.LifecycleState
    };
}

static object ToSessionResponse(AuthService.Domain.Models.Session session)
{
    return new
    {
        sessionId = session.Id,
        identityId = session.IdentityId,
        state = session.State,
        policyCode = session.PolicyCode,
        createdAt = session.CreatedAt,
        expiresAt = session.ExpiresAt,
        revokedAt = session.RevokedAt
    };
}

static object ToCanonicalIdentityResponse(CanonicalIdentity identity) => new
{
    identityId = identity.IdentityId,
    tenantId = identity.TenantId,
    brandId = identity.BrandId,
    loginId = identity.Username,
    email = identity.Email,
    identityType = identity.AccountType,
    lifecycleState = identity.Status,
    credentialStatus = identity.CredentialStatus,
    mfaStatus = identity.MfaStatus,
    createdAt = identity.CreatedAt,
    disabledAt = identity.DisabledAt,
    reviewDueAt = identity.ReviewDueAt
};

static object ToCanonicalSessionResponse(CanonicalSession session) => new
{
    sessionId = session.SessionId,
    identityId = session.IdentityId,
    state = session.RevokedAt is null ? "Active" : "Revoked",
    policyCode = "canonical-single-session",
    createdAt = session.CreatedAt,
    expiresAt = session.AbsoluteExpiresAt,
    idleExpiresAt = session.IdleExpiresAt,
    revokedAt = session.RevokedAt,
    ipAddress = session.IpAddress,
    userAgent = session.UserAgent,
    deviceMetadata = session.DeviceMetadata
};

static object ToRoleResponse(AuthService.Domain.Models.Role role)
{
    return new
    {
        code = role.Code,
        displayName = role.DisplayName,
        systemRole = role.SystemRole,
        permissions = role.Permissions
    };
}

static object ToGroupResponse(AuthService.Domain.Models.Role role)
{
    return new
    {
        id = role.Code,
        name = role.DisplayName,
        code = role.Code,
        isSystemGroup = role.SystemRole
    };
}

static object ToPermissionResponse(string permission)
{
    return new
    {
        id = permission,
        key = permission,
        description = (string?)null,
        isSystemPermission = permission.StartsWith("system.", StringComparison.OrdinalIgnoreCase)
    };
}

static object ToJwksResponse(AuthService.Domain.Boundaries.JwksKeyDescriptor key)
{
    return new
    {
        kid = key.KeyId,
        kty = key.PublicParameters.GetValueOrDefault("kty") ?? "RSA",
        use = key.Use,
        alg = key.Algorithm,
        n = key.PublicParameters.GetValueOrDefault("n"),
        e = key.PublicParameters.GetValueOrDefault("e")
    };
}

public sealed record LoginEndpointRequest(string? LoginId, string? Password, string? CorrelationId);

public sealed record LogoutEndpointRequest(string? SessionId, string? SessionToken, string? CorrelationId);
public sealed record CreateIdentityEndpointRequest(Guid? IdentityId, Guid TenantId, Guid? BrandId, string? Username, string? Email, string? AccountType, CanonicalIdentityStatus InitialStatus, string? Password, Guid? ActorIdentityId, string? CorrelationId);
public sealed record PasswordChangeEndpointRequest(Guid IdentityId, string? CurrentPassword, string? NewPassword, Guid? ActorIdentityId, string? CorrelationId);
public sealed record PasswordResetEndpointRequest(Guid IdentityId, string? NewPassword, Guid ActorIdentityId, string? Reason, string? CorrelationId);
public sealed record PublicPasswordResetEndpointRequest(string? Identifier, string? CorrelationId);
public sealed record PublicPasswordResetConfirmEndpointRequest(string? ResetToken, string? NewPassword, string? CorrelationId);
public sealed record LifecycleEndpointRequest(Guid IdentityId, CanonicalIdentityStatus ExpectedStatus, CanonicalIdentityStatus TargetStatus, Guid ActorIdentityId, string? Reason, string? CorrelationId);
public sealed record CanonicalSessionEndpointRequest(string? SessionToken, bool Renew);
public sealed record CanonicalLogoutEndpointRequest(string? SessionToken, string? CorrelationId);
public sealed record CanonicalLogoutAllEndpointRequest(Guid IdentityId, Guid ActorIdentityId, string? Reason, string? CorrelationId);
public sealed record CanonicalSessionRevokeEndpointRequest(Guid SessionId, Guid IdentityId, Guid ActorIdentityId, string? Reason, string? CorrelationId);
public sealed record CanonicalAuditEndpointRequest(Guid SubjectIdentityId, Guid? ActorIdentityId, string? Action, string? Result, string? Reason, string? CorrelationId);

public sealed record TokenValidationEndpointRequest(string? AccessToken);

public sealed record RefreshEndpointRequest(string? RefreshToken, string? CorrelationId);

public sealed record ServiceTokenEndpointRequest(string? ServiceName, string? ClientSecret, IReadOnlyCollection<string>? Scopes, string? CorrelationId);

public sealed record ServiceTokenValidationEndpointRequest(string? AccessToken, string? RequiredScope);
