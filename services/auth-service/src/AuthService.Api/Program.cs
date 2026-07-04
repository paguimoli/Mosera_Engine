using System.Text.Json.Serialization;
using AuthService.Application;
using AuthService.Application.Contracts;
using AuthService.Application.Services;
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
}
builder.Services.AddSingleton<AuthLoginRuntimeService>();
builder.Services.AddSingleton<AuthAccessTokenService>();
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

IResult ReadyResult(AuthInfrastructureStatusProvider infrastructure)
{
    var status = infrastructure.GetStatus();
    var response = new
    {
        status = !string.IsNullOrWhiteSpace(databaseUrl) && !status.DatabaseReady ? "not_ready" : "ready",
        service = "auth-service",
        architectureOnly = false,
        runtimeScope = "login-session-access-token",
        productionTokenIssuanceEnabled = true,
        oauthRuntimeEnabled = false,
        nextJsCutoverEnabled = false,
        infrastructure = status,
        timestamp = DateTimeOffset.UtcNow
    };

    return !string.IsNullOrWhiteSpace(databaseUrl) && !status.DatabaseReady
        ? Results.Json(response, statusCode: StatusCodes.Status503ServiceUnavailable)
        : Results.Ok(response);
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
    AuthLoginRuntimeService service,
    AuthAccessTokenService tokens,
    LoginEndpointRequest request,
    CancellationToken cancellationToken) =>
{
    var result = await service.LoginAsync(
        new LoginRuntimeRequest(request.LoginId ?? string.Empty, request.Password ?? string.Empty, request.CorrelationId),
        cancellationToken);

    if (!result.Success)
    {
        var failure = new
        {
            success = false,
            error = result.RuntimeUnavailableReason is null ? "Invalid login credentials." : result.RuntimeUnavailableReason,
            failureReason = result.FailureReason,
            correlationId = result.CorrelationId,
            lockoutEnforced = false,
            rateLimitEnforced = false,
            productionLockoutRateLimitReady = false
        };

        return result.RuntimeUnavailableReason is null
            ? Results.Json(failure, statusCode: StatusCodes.Status401Unauthorized)
            : Results.Json(failure, statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    var sessionValidation = await service.ValidateSessionAsync(result.Session!.Id, cancellationToken);
    var accessToken = await tokens.IssueForValidatedSessionAsync(sessionValidation, result.CorrelationId, cancellationToken);
    var refreshToken = await tokens.IssueRefreshTokenForValidatedSessionAsync(sessionValidation, result.CorrelationId, cancellationToken);

    return Results.Ok(new
    {
        success = true,
        session = ToSessionResponse(result.Session!),
        identity = ToIdentityResponse(result.Identity!),
        accessToken = accessToken.AccessToken,
        tokenType = accessToken.TokenType,
        accessTokenExpiresAt = accessToken.ExpiresAt,
        accessTokenKeyId = accessToken.KeyId,
        accessTokenJwtId = accessToken.JwtId,
        issuer = accessToken.Issuer,
        audience = accessToken.Audience,
        refreshToken = refreshToken.RefreshToken,
        refreshTokenId = refreshToken.RefreshTokenId,
        refreshTokenExpiresAt = refreshToken.ExpiresAt,
        correlationId = result.CorrelationId,
        tokenIssued = accessToken.Issued,
        refreshTokenIssued = refreshToken.Issued,
        oauthFlow = false,
        nextJsCutover = false,
        lockoutEnforced = false,
        rateLimitEnforced = false,
        productionLockoutRateLimitReady = false
    });
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
    AuthLoginRuntimeService service,
    CancellationToken cancellationToken) =>
{
    if (!TryReadSessionId(httpRequest, out var sessionId))
    {
        return Results.Json(new { success = false, error = "Session id is required." }, statusCode: StatusCodes.Status401Unauthorized);
    }

    var result = await service.ValidateSessionAsync(sessionId, cancellationToken);
    return result.Valid
        ? Results.Ok(new
        {
            success = true,
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
            error = "Session is invalid.",
            reason = result.Reason
        }, statusCode: StatusCodes.Status401Unauthorized);
});

group.MapPost("/logout", async (
    AuthLoginRuntimeService service,
    AuthAccessTokenService tokens,
    LogoutEndpointRequest request,
    CancellationToken cancellationToken) =>
{
    if (!Guid.TryParse(request.SessionId, out var sessionId))
    {
        return Results.BadRequest(new { success = false, error = "sessionId is required." });
    }

    var result = await service.LogoutAsync(sessionId, request.CorrelationId, cancellationToken);
    var revokedRefreshTokens = result.Success
        ? await tokens.RevokeRefreshTokensForSessionAsync(sessionId, result.CorrelationId, cancellationToken)
        : 0;
    return result.Success
        ? Results.Ok(new
        {
            success = true,
            sessionId = result.SessionId,
            revokedAt = result.RevokedAt,
            revokedRefreshTokens,
            correlationId = result.CorrelationId
        })
        : Results.Json(new
        {
            success = false,
            error = result.FailureReason,
            correlationId = result.CorrelationId
        }, statusCode: StatusCodes.Status503ServiceUnavailable);
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

static bool TryReadSessionId(HttpRequest request, out Guid sessionId)
{
    sessionId = Guid.Empty;

    if (request.Headers.TryGetValue("X-Auth-Session-Id", out var sessionHeader) &&
        Guid.TryParse(sessionHeader.FirstOrDefault(), out sessionId))
    {
        return true;
    }

    if (request.Headers.TryGetValue("Authorization", out var authorizationHeader))
    {
        var value = authorizationHeader.FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(value) &&
            value.StartsWith("Session ", StringComparison.OrdinalIgnoreCase) &&
            Guid.TryParse(value["Session ".Length..], out sessionId))
        {
            return true;
        }
    }

    return false;
}

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

public sealed record LogoutEndpointRequest(string? SessionId, string? CorrelationId);

public sealed record TokenValidationEndpointRequest(string? AccessToken);

public sealed record RefreshEndpointRequest(string? RefreshToken, string? CorrelationId);

public sealed record ServiceTokenEndpointRequest(string? ServiceName, string? ClientSecret, IReadOnlyCollection<string>? Scopes, string? CorrelationId);

public sealed record ServiceTokenValidationEndpointRequest(string? AccessToken, string? RequiredScope);
