using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AuthService.Application.Contracts;
using AuthService.Domain.Boundaries;
using AuthService.Domain.Models;

namespace AuthService.Application.Services;

public sealed class AuthAccessTokenService(
    ISigningKeyRepository signingKeys,
    ITokenRepository tokens,
    IRefreshTokenRepository refreshTokens,
    IServiceAccountRepository serviceAccounts,
    IAuthRuntimeStore runtimeStore,
    AuthLoginRuntimeService sessions)
{
    private const string Algorithm = "RS256";
    private static readonly TimeSpan AccessTokenLifetime = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan RefreshTokenLifetime = TimeSpan.FromDays(30);

    public string Issuer { get; } = Environment.GetEnvironmentVariable("AUTH_SERVICE_TOKEN_ISSUER") ?? "lottery-auth-service";
    public string Audience { get; } = Environment.GetEnvironmentVariable("AUTH_SERVICE_TOKEN_AUDIENCE") ?? "lottery-platform";
    public bool TokenIssuanceEnabled { get; } = !string.Equals(Environment.GetEnvironmentVariable("AUTH_SERVICE_ACCESS_TOKENS_ENABLED"), "false", StringComparison.OrdinalIgnoreCase);

    public async Task<CanonicalTokenArtifacts> PrepareCanonicalTokensAsync(
        CanonicalIdentity identity,
        CanonicalSession session,
        IReadOnlyCollection<Role> roles,
        IReadOnlyCollection<string> permissions,
        string correlationId,
        CancellationToken cancellationToken = default)
    {
        if (!TokenIssuanceEnabled) throw new InvalidOperationException("access_token_issuance_disabled");
        var signingKey = await GetOrCreateActiveSigningKey(cancellationToken);
        var issuedAt = DateTimeOffset.UtcNow;
        var expiresAt = issuedAt.Add(AccessTokenLifetime);
        var accessTokenId = Guid.NewGuid();
        var jwtId = accessTokenId.ToString("N");
        var roleCodes = roles.Select(role => role.Code).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var scopes = permissions.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var claims = new Dictionary<string, object?>
        {
            ["iss"] = Issuer,
            ["aud"] = Audience,
            ["sub"] = identity.IdentityId.ToString(),
            ["identity_id"] = identity.IdentityId.ToString(),
            ["tenant_id"] = identity.TenantId.ToString(),
            ["brand_id"] = identity.BrandId?.ToString(),
            ["session_id"] = session.SessionId.ToString(),
            ["jti"] = jwtId,
            ["iat"] = ToUnixTimeSeconds(issuedAt),
            ["nbf"] = ToUnixTimeSeconds(issuedAt),
            ["exp"] = ToUnixTimeSeconds(expiresAt),
            ["roles"] = roleCodes,
            ["groups"] = roleCodes,
            ["permissions"] = scopes,
            ["correlation_id"] = correlationId
        };
        var refreshIssuedAt = issuedAt;
        var refreshToken = GenerateRefreshToken();
        return new CanonicalTokenArtifacts(
            accessTokenId,
            SignJwt(signingKey, claims),
            jwtId,
            signingKey.SigningKeyId,
            signingKey.KeyId,
            Issuer,
            Audience,
            scopes,
            issuedAt,
            expiresAt,
            Guid.NewGuid(),
            Guid.NewGuid(),
            Guid.NewGuid(),
            refreshToken,
            HashRefreshToken(refreshToken),
            refreshIssuedAt,
            refreshIssuedAt.Add(RefreshTokenLifetime));
    }

    public async Task<ServiceTokenIssueResult> IssueServiceTokenAsync(
        string serviceName,
        string clientSecret,
        IReadOnlyCollection<string> requestedScopes,
        string? correlationId,
        CancellationToken cancellationToken = default)
    {
        var normalizedCorrelationId = NormalizeCorrelationId(correlationId);
        var credential = await serviceAccounts.FindServiceCredentialSecret(serviceName, cancellationToken);
        if (credential is null ||
            !PasswordHashVerifier.Verify(clientSecret, credential.SecretHash, credential.HashAlgorithm))
        {
            await AppendTokenAudit(null, Guid.Empty, "SERVICE_TOKEN_FAILURE", normalizedCorrelationId, "invalid_service_credential", cancellationToken);
            return ServiceTokenIssueResult.Failed("invalid_service_credential");
        }

        var scopes = requestedScopes.Count == 0
            ? credential.Scopes
            : requestedScopes.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var unauthorizedScopes = scopes.Except(credential.Scopes, StringComparer.Ordinal).ToArray();
        if (unauthorizedScopes.Length > 0)
        {
            await AppendTokenAudit(credential.IdentityId, Guid.Empty, "SERVICE_TOKEN_FAILURE", normalizedCorrelationId, "unauthorized_scope", cancellationToken);
            return ServiceTokenIssueResult.Failed("unauthorized_scope");
        }

        var signingKey = await GetOrCreateActiveSigningKey(cancellationToken);
        var issuedAt = DateTimeOffset.UtcNow;
        var expiresAt = issuedAt.Add(AccessTokenLifetime);
        var jwtId = Guid.NewGuid().ToString("N");
        var claims = new Dictionary<string, object?>
        {
            ["iss"] = Issuer,
            ["aud"] = Audience,
            ["sub"] = credential.ServiceName,
            ["service_id"] = credential.ServiceAccountId.ToString(),
            ["identity_id"] = credential.IdentityId.ToString(),
            ["service_name"] = credential.ServiceName,
            ["client_id"] = credential.ClientId,
            ["jti"] = jwtId,
            ["iat"] = ToUnixTimeSeconds(issuedAt),
            ["nbf"] = ToUnixTimeSeconds(issuedAt),
            ["exp"] = ToUnixTimeSeconds(expiresAt),
            ["scopes"] = scopes,
            ["permissions"] = scopes,
            ["token_use"] = "service"
        };

        var token = SignJwt(signingKey, claims);
        await tokens.SaveJwtAccessToken(
            Guid.NewGuid(),
            credential.IdentityId,
            Guid.Empty,
            Issuer,
            Audience,
            scopes,
            jwtId,
            signingKey.SigningKeyId,
            issuedAt,
            expiresAt,
            cancellationToken);
        await AppendTokenAudit(credential.IdentityId, Guid.Empty, "SERVICE_TOKEN_ISSUED", normalizedCorrelationId, "client_credentials", cancellationToken);

        return ServiceTokenIssueResult.Issued(token, "Bearer", expiresAt, signingKey.KeyId, jwtId, Issuer, Audience, scopes);
    }

    public async Task<AccessTokenIssueResult> IssueForValidatedSessionAsync(
        SessionValidationResult validation,
        string correlationId,
        CancellationToken cancellationToken = default)
    {
        if (!TokenIssuanceEnabled)
        {
            return AccessTokenIssueResult.Disabled("access_token_issuance_disabled");
        }

        if (!validation.Valid || validation.Identity is null || validation.Session is null)
        {
            return AccessTokenIssueResult.Disabled("session_invalid");
        }

        var signingKey = await GetOrCreateActiveSigningKey(cancellationToken);
        var issuedAt = DateTimeOffset.UtcNow;
        var expiresAt = issuedAt.Add(AccessTokenLifetime);
        var tokenId = Guid.NewGuid();
        var jwtId = tokenId.ToString("N");
        var roles = validation.Roles.Select(role => role.Code).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var permissions = validation.Permissions.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var claims = new Dictionary<string, object?>
        {
            ["iss"] = Issuer,
            ["aud"] = Audience,
            ["sub"] = validation.Identity.Id.ToString(),
            ["identity_id"] = validation.Identity.Id.ToString(),
            ["session_id"] = validation.Session.Id.ToString(),
            ["jti"] = jwtId,
            ["iat"] = ToUnixTimeSeconds(issuedAt),
            ["nbf"] = ToUnixTimeSeconds(issuedAt),
            ["exp"] = ToUnixTimeSeconds(expiresAt),
            ["roles"] = roles,
            ["groups"] = roles,
            ["permissions"] = permissions,
            ["correlation_id"] = correlationId
        };

        var token = SignJwt(signingKey, claims);
        await tokens.SaveJwtAccessToken(
            tokenId,
            validation.Identity.Id,
            validation.Session.Id,
            Issuer,
            Audience,
            permissions,
            jwtId,
            signingKey.SigningKeyId,
            issuedAt,
            expiresAt,
            cancellationToken);

        return AccessTokenIssueResult.CreateIssued(token, "Bearer", expiresAt, signingKey.KeyId, jwtId, Issuer, Audience);
    }

    public async Task<RefreshTokenIssueResult> IssueRefreshTokenForValidatedSessionAsync(
        SessionValidationResult validation,
        string correlationId,
        CancellationToken cancellationToken = default)
    {
        if (!validation.Valid || validation.Identity is null || validation.Session is null)
        {
            return RefreshTokenIssueResult.NotIssued("session_invalid");
        }

        var now = DateTimeOffset.UtcNow;
        var rawRefreshToken = GenerateRefreshToken();
        var refreshTokenId = Guid.NewGuid();
        await refreshTokens.SaveRefreshToken(
            refreshTokenId,
            validation.Identity.Id,
            validation.Session.Id,
            Guid.NewGuid(),
            Guid.NewGuid(),
            rotationCounter: 0,
            previousRefreshTokenId: null,
            referenceHash: HashRefreshToken(rawRefreshToken),
            issuedAt: now,
            expiresAt: now.Add(RefreshTokenLifetime),
            cancellationToken);
        await AppendTokenAudit(validation.Identity.Id, validation.Session.Id, "REFRESH_TOKEN_ISSUED", correlationId, "login", cancellationToken);

        return RefreshTokenIssueResult.CreateIssued(rawRefreshToken, refreshTokenId, now.Add(RefreshTokenLifetime));
    }

    public async Task<TokenRefreshResult> RefreshAsync(
        string refreshToken,
        string? correlationId,
        CancellationToken cancellationToken = default)
    {
        var normalizedCorrelationId = NormalizeCorrelationId(correlationId);
        if (string.IsNullOrWhiteSpace(refreshToken))
        {
            return TokenRefreshResult.Failed("refresh_token_required");
        }

        var existing = await refreshTokens.FindRefreshTokenByHash(HashRefreshToken(refreshToken), cancellationToken);
        if (existing is null)
        {
            return TokenRefreshResult.Failed("refresh_token_not_found");
        }

        if (existing.RevokedAt is not null || existing.RotatedAt is not null)
        {
            var replayedAt = DateTimeOffset.UtcNow;
            await refreshTokens.RevokeRefreshTokenFamily(existing.FamilyId, replayedAt, "replay_detected", cancellationToken);
            await sessions.LogoutAsync(existing.SessionId, normalizedCorrelationId, cancellationToken);
            await AppendTokenAudit(existing.IdentityId, existing.SessionId, "REFRESH_TOKEN_REPLAY", normalizedCorrelationId, "family_and_session_revoked", cancellationToken);
            return TokenRefreshResult.CreateReplayDetected("refresh_token_replay_detected");
        }

        if (existing.ExpiresAt <= DateTimeOffset.UtcNow)
        {
            await AppendTokenAudit(existing.IdentityId, existing.SessionId, "REFRESH_TOKEN_EXPIRED", normalizedCorrelationId, "expired", cancellationToken);
            return TokenRefreshResult.Failed("refresh_token_expired");
        }

        var sessionValidation = await sessions.ValidateSessionAsync(existing.SessionId, cancellationToken);
        if (!sessionValidation.Valid)
        {
            return TokenRefreshResult.Failed(sessionValidation.Reason);
        }

        var rotatedAt = DateTimeOffset.UtcNow;
        await refreshTokens.MarkRefreshTokenRotated(existing.RefreshTokenId, rotatedAt, cancellationToken);
        var accessToken = await IssueForValidatedSessionAsync(sessionValidation, normalizedCorrelationId, cancellationToken);
        var rawRefreshToken = GenerateRefreshToken();
        var newRefreshTokenId = Guid.NewGuid();
        var newExpiresAt = rotatedAt.Add(RefreshTokenLifetime);
        await refreshTokens.SaveRefreshToken(
            newRefreshTokenId,
            existing.IdentityId,
            existing.SessionId,
            Guid.NewGuid(),
            existing.FamilyId,
            existing.RotationCounter + 1,
            existing.RefreshTokenId,
            HashRefreshToken(rawRefreshToken),
            rotatedAt,
            newExpiresAt,
            cancellationToken);
        await AppendTokenAudit(existing.IdentityId, existing.SessionId, "REFRESH_TOKEN_ROTATED", normalizedCorrelationId, "rotation_success", cancellationToken);

        return TokenRefreshResult.Refreshed(accessToken, rawRefreshToken, newRefreshTokenId, newExpiresAt);
    }

    public async Task<int> RevokeRefreshTokensForSessionAsync(
        Guid sessionId,
        string correlationId,
        CancellationToken cancellationToken = default)
    {
        var revokedAt = DateTimeOffset.UtcNow;
        var revokedCount = await refreshTokens.RevokeRefreshTokensForSession(sessionId, revokedAt, "logout", cancellationToken);
        await AppendTokenAudit(null, sessionId, "REFRESH_TOKEN_REVOKED", correlationId, "logout", cancellationToken);
        return revokedCount;
    }

    public async Task<AccessTokenValidationResult> ValidateAsync(
        string accessToken,
        CancellationToken cancellationToken = default)
    {
        var parts = accessToken.Split('.');
        if (parts.Length != 3)
        {
            return AccessTokenValidationResult.Invalid("malformed_token");
        }

        Dictionary<string, JsonElement> header;
        Dictionary<string, JsonElement> payload;
        try
        {
            header = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(Encoding.UTF8.GetString(Base64UrlDecode(parts[0]))) ?? [];
            payload = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(Encoding.UTF8.GetString(Base64UrlDecode(parts[1]))) ?? [];
        }
        catch
        {
            return AccessTokenValidationResult.Invalid("malformed_token");
        }

        if (!TryGetString(header, "kid", out var keyId) ||
            !TryGetString(header, "alg", out var alg) ||
            !alg.Equals(Algorithm, StringComparison.Ordinal))
        {
            return AccessTokenValidationResult.Invalid("unsupported_header");
        }

        var jwks = await signingKeys.ListPublicJwks(cancellationToken);
        var jwk = jwks.FirstOrDefault(key => key.KeyId == keyId);
        if (jwk is null ||
            !jwk.PublicParameters.TryGetValue("n", out var modulus) ||
            !jwk.PublicParameters.TryGetValue("e", out var exponent))
        {
            return AccessTokenValidationResult.Invalid("signing_key_not_found");
        }

        using var rsa = RSA.Create();
        rsa.ImportParameters(new RSAParameters
        {
            Modulus = Base64UrlDecode(modulus),
            Exponent = Base64UrlDecode(exponent)
        });

        var signedPayload = Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}");
        var signature = Base64UrlDecode(parts[2]);
        if (!rsa.VerifyData(signedPayload, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
        {
            return AccessTokenValidationResult.Invalid("signature_invalid");
        }

        if (!TryGetString(payload, "iss", out var issuer) || issuer != Issuer ||
            !TryGetString(payload, "aud", out var audience) || audience != Audience)
        {
            return AccessTokenValidationResult.Invalid("issuer_or_audience_invalid");
        }

        if (!TryGetLong(payload, "exp", out var expiresAt) ||
            DateTimeOffset.UtcNow >= DateTimeOffset.FromUnixTimeSeconds(expiresAt))
        {
            return AccessTokenValidationResult.Invalid("token_expired");
        }

        if (TryGetString(payload, "service_id", out _))
        {
            return AccessTokenValidationResult.CreateValid(payload);
        }

        if (!TryGetString(payload, "session_id", out var sessionIdValue) ||
            !Guid.TryParse(sessionIdValue, out var sessionId))
        {
            return AccessTokenValidationResult.Invalid("session_missing");
        }

        var sessionValidation = await sessions.ValidateSessionAsync(sessionId, cancellationToken);
        if (!sessionValidation.Valid)
        {
            return AccessTokenValidationResult.Invalid(sessionValidation.Reason);
        }

        return AccessTokenValidationResult.CreateValid(payload);
    }

    public async Task<ServiceTokenValidationResult> ValidateServiceTokenAsync(
        string accessToken,
        string? requiredScope,
        CancellationToken cancellationToken = default)
    {
        var validation = await ValidateAsync(accessToken, cancellationToken);
        if (!validation.Valid)
        {
            return ServiceTokenValidationResult.Invalid(validation.Reason);
        }

        if (!validation.Claims.TryGetValue("service_id", out var serviceId) ||
            serviceId.ValueKind != JsonValueKind.String)
        {
            return ServiceTokenValidationResult.Invalid("not_service_token");
        }

        var scopes = validation.Claims.TryGetValue("scopes", out var scopesElement) && scopesElement.ValueKind == JsonValueKind.Array
            ? scopesElement.EnumerateArray().Select(item => item.GetString()).Where(item => !string.IsNullOrWhiteSpace(item)).Cast<string>().ToArray()
            : [];
        if (!string.IsNullOrWhiteSpace(requiredScope) && !scopes.Contains(requiredScope, StringComparer.Ordinal))
        {
            return ServiceTokenValidationResult.Invalid("insufficient_scope");
        }

        return ServiceTokenValidationResult.CreateValid(scopes);
    }

    public async Task<IReadOnlyCollection<JwksKeyDescriptor>> GetJwksAsync(CancellationToken cancellationToken = default)
    {
        await GetOrCreateActiveSigningKey(cancellationToken);
        return await signingKeys.ListPublicJwks(cancellationToken);
    }

    private async Task<SigningKeyMaterial> GetOrCreateActiveSigningKey(CancellationToken cancellationToken)
    {
        var active = await signingKeys.FindActiveSigningKey(cancellationToken);
        if (active is not null)
        {
            return active;
        }

        using var rsa = RSA.Create(2048);
        var parameters = rsa.ExportParameters(includePrivateParameters: false);
        var now = DateTimeOffset.UtcNow;
        return await signingKeys.SaveSigningKey(new SigningKeyMaterial(
            Guid.NewGuid(),
            $"auth-local-{now:yyyyMMddHHmmss}-{Guid.NewGuid():N}"[..38],
            Algorithm,
            Version: 1,
            Status: "ACTIVE",
            PublicParameters: new Dictionary<string, string>
            {
                ["kty"] = "RSA",
                ["n"] = Base64UrlEncode(parameters.Modulus ?? []),
                ["e"] = Base64UrlEncode(parameters.Exponent ?? []),
                ["alg"] = Algorithm,
                ["use"] = "sig"
            },
            PrivateKeyPem: rsa.ExportPkcs8PrivateKeyPem(),
            ActivatesAt: now,
            ExpiresAt: null,
            RetiredAt: null), cancellationToken);
    }

    private static string SignJwt(SigningKeyMaterial signingKey, IReadOnlyDictionary<string, object?> claims)
    {
        var header = new Dictionary<string, object?>
        {
            ["typ"] = "JWT",
            ["alg"] = Algorithm,
            ["kid"] = signingKey.KeyId
        };
        var encodedHeader = Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(header));
        var encodedPayload = Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(claims));
        var signedPayload = Encoding.ASCII.GetBytes($"{encodedHeader}.{encodedPayload}");

        using var rsa = RSA.Create();
        rsa.ImportFromPem(signingKey.PrivateKeyPem);
        var signature = rsa.SignData(signedPayload, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{encodedHeader}.{encodedPayload}.{Base64UrlEncode(signature)}";
    }

    private static bool TryGetString(IReadOnlyDictionary<string, JsonElement> values, string key, out string value)
    {
        value = string.Empty;
        if (!values.TryGetValue(key, out var element) || element.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        value = element.GetString() ?? string.Empty;
        return !string.IsNullOrWhiteSpace(value);
    }

    private static bool TryGetLong(IReadOnlyDictionary<string, JsonElement> values, string key, out long value)
    {
        value = 0;
        if (!values.TryGetValue(key, out var element))
        {
            return false;
        }

        return element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out value);
    }

    private static long ToUnixTimeSeconds(DateTimeOffset value) => value.ToUnixTimeSeconds();

    private static string NormalizeCorrelationId(string? correlationId)
    {
        return string.IsNullOrWhiteSpace(correlationId) ? Guid.NewGuid().ToString("N") : correlationId.Trim();
    }

    private static string GenerateRefreshToken()
    {
        return $"rt_{Base64UrlEncode(RandomNumberGenerator.GetBytes(32))}";
    }

    private static string HashRefreshToken(string refreshToken)
    {
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(refreshToken))).ToLowerInvariant();
    }

    private async Task AppendTokenAudit(
        Guid? identityId,
        Guid sessionId,
        string action,
        string correlationId,
        string reason,
        CancellationToken cancellationToken)
    {
        await runtimeStore.AppendAuditEvent(new AuditEvent(
            Guid.NewGuid(),
            AuditEventCategory.Token,
            ActorIdentityId: identityId,
            SubjectIdentityId: identityId,
            Action: action,
            CorrelationId: correlationId,
            Metadata: new Dictionary<string, string>
            {
                ["sessionId"] = sessionId.ToString(),
                ["reason"] = reason
            },
            CreatedAt: DateTimeOffset.UtcNow), cancellationToken);
    }

    private static string Base64UrlEncode(byte[] bytes)
    {
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static byte[] Base64UrlDecode(string value)
    {
        var base64 = value.Replace('-', '+').Replace('_', '/');
        base64 = base64.PadRight(base64.Length + (4 - base64.Length % 4) % 4, '=');
        return Convert.FromBase64String(base64);
    }
}

public sealed record RefreshTokenIssueResult(
    bool Issued,
    string? RefreshToken,
    Guid? RefreshTokenId,
    DateTimeOffset? ExpiresAt,
    string? Reason)
{
    public static RefreshTokenIssueResult CreateIssued(string refreshToken, Guid refreshTokenId, DateTimeOffset expiresAt)
    {
        return new RefreshTokenIssueResult(true, refreshToken, refreshTokenId, expiresAt, null);
    }

    public static RefreshTokenIssueResult NotIssued(string reason)
    {
        return new RefreshTokenIssueResult(false, null, null, null, reason);
    }
}

public sealed record TokenRefreshResult(
    bool Success,
    bool ReplayDetected,
    AccessTokenIssueResult? AccessToken,
    string? RefreshToken,
    Guid? RefreshTokenId,
    DateTimeOffset? RefreshTokenExpiresAt,
    string Reason)
{
    public static TokenRefreshResult Refreshed(
        AccessTokenIssueResult accessToken,
        string refreshToken,
        Guid refreshTokenId,
        DateTimeOffset refreshTokenExpiresAt)
    {
        return new TokenRefreshResult(true, false, accessToken, refreshToken, refreshTokenId, refreshTokenExpiresAt, "refreshed");
    }

    public static TokenRefreshResult Failed(string reason)
    {
        return new TokenRefreshResult(false, false, null, null, null, null, reason);
    }

    public static TokenRefreshResult CreateReplayDetected(string reason)
    {
        return new TokenRefreshResult(false, true, null, null, null, null, reason);
    }
}

public sealed record ServiceTokenIssueResult(
    bool Success,
    string? AccessToken,
    string TokenType,
    DateTimeOffset? ExpiresAt,
    string? KeyId,
    string? JwtId,
    string? Issuer,
    string? Audience,
    IReadOnlyCollection<string> Scopes,
    string? Reason)
{
    public static ServiceTokenIssueResult Issued(
        string accessToken,
        string tokenType,
        DateTimeOffset expiresAt,
        string keyId,
        string jwtId,
        string issuer,
        string audience,
        IReadOnlyCollection<string> scopes)
    {
        return new ServiceTokenIssueResult(true, accessToken, tokenType, expiresAt, keyId, jwtId, issuer, audience, scopes, null);
    }

    public static ServiceTokenIssueResult Failed(string reason)
    {
        return new ServiceTokenIssueResult(false, null, "Bearer", null, null, null, null, null, [], reason);
    }
}

public sealed record ServiceTokenValidationResult(
    bool Valid,
    string Reason,
    IReadOnlyCollection<string> Scopes)
{
    public static ServiceTokenValidationResult CreateValid(IReadOnlyCollection<string> scopes)
    {
        return new ServiceTokenValidationResult(true, "valid", scopes);
    }

    public static ServiceTokenValidationResult Invalid(string reason)
    {
        return new ServiceTokenValidationResult(false, reason, []);
    }
}

public sealed record AccessTokenIssueResult(
    bool Issued,
    string? AccessToken,
    string TokenType,
    DateTimeOffset? ExpiresAt,
    string? KeyId,
    string? JwtId,
    string? Issuer,
    string? Audience,
    string? Reason)
{
    public static AccessTokenIssueResult CreateIssued(string token, string tokenType, DateTimeOffset expiresAt, string keyId, string jwtId, string issuer, string audience)
    {
        return new AccessTokenIssueResult(true, token, tokenType, expiresAt, keyId, jwtId, issuer, audience, null);
    }

    public static AccessTokenIssueResult Disabled(string reason)
    {
        return new AccessTokenIssueResult(false, null, "Bearer", null, null, null, null, null, reason);
    }
}

public sealed record AccessTokenValidationResult(
    bool Valid,
    string Reason,
    IReadOnlyDictionary<string, JsonElement> Claims)
{
    public static AccessTokenValidationResult CreateValid(IReadOnlyDictionary<string, JsonElement> claims)
    {
        return new AccessTokenValidationResult(true, "valid", claims);
    }

    public static AccessTokenValidationResult Invalid(string reason)
    {
        return new AccessTokenValidationResult(false, reason, new Dictionary<string, JsonElement>());
    }
}
