using System.Security.Cryptography;
using System.Text;
using AuthService.Domain.Models;

namespace AuthService.Application.Services;

public sealed class IdentityMappingService
{
    private static readonly HashSet<string> SupportedCredentialTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "PASSWORD_HASH",
        "TOTP",
        "WEBAUTHN",
        "API_KEY",
        "CLIENT_SECRET",
        "CERTIFICATE",
        "OAUTH_FEDERATION",
        "PAM_FEDERATION"
    };

    public ShadowIdentityMapping Map(LegacyPlatformIdentity source)
    {
        var identityId = CreateDeterministicGuid($"identity:{source.SourceSystem}:{source.SourceId}");
        var loginId = NormalizeLoginId(source.LoginId ?? source.Username ?? source.Email ?? source.SourceId);
        var identityType = MapIdentityType(source.AccountType, source.IdentityClass);
        var lifecycleState = MapLifecycleState(source.LifecycleState, source.Status);
        var roles = source.Roles
            .Select(role => NormalizeCode(role.Code))
            .Where(role => role.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var claims = source.Claims
            .Select(claim => new ShadowClaimMapping(NormalizeCode(claim.Type), claim.Value.Trim(), claim.Issuer.Trim()))
            .Where(claim => claim.Type.Length > 0 && claim.Value.Length > 0)
            .Distinct()
            .OrderBy(claim => claim.Type, StringComparer.Ordinal)
            .ThenBy(claim => claim.Value, StringComparer.Ordinal)
            .ThenBy(claim => claim.Issuer, StringComparer.Ordinal)
            .ToArray();
        var memberships = source.Memberships
            .Select(membership => new ShadowMembershipMapping(
                CreateDeterministicGuid($"membership:{source.SourceSystem}:{source.SourceId}:{membership.ScopeType}:{membership.ScopeId}"),
                NormalizeCode(membership.ScopeType),
                membership.ScopeId.Trim(),
                membership.RoleCodes.Select(NormalizeCode).Where(role => role.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.Ordinal).ToArray()))
            .Where(membership => membership.ScopeType.Length > 0 && membership.ScopeId.Length > 0)
            .Distinct()
            .OrderBy(membership => membership.ScopeType, StringComparer.Ordinal)
            .ThenBy(membership => membership.ScopeId, StringComparer.Ordinal)
            .ToArray();
        var credentials = source.Credentials
            .Select(credential => MapCredential(source, identityId, credential))
            .OrderBy(credential => credential.Type, StringComparer.Ordinal)
            .ThenBy(credential => credential.PublicReference, StringComparer.Ordinal)
            .ToArray();

        return new ShadowIdentityMapping(
            SourceSystem: source.SourceSystem,
            SourceId: source.SourceId,
            IdentityId: identityId,
            LoginId: loginId,
            Username: NormalizeNullable(source.Username),
            Email: NormalizeNullable(source.Email),
            IdentityType: identityType,
            LifecycleState: lifecycleState,
            Roles: roles,
            Claims: claims,
            Memberships: memberships,
            Credentials: credentials,
            SupportedCredentialTypes: SupportedCredentialTypes.Order(StringComparer.Ordinal).ToArray());
    }

    public IReadOnlyCollection<ShadowIdentityMapping> MapAll(LegacyPlatformSnapshot snapshot)
    {
        return snapshot.Identities
            .OrderBy(identity => identity.SourceSystem, StringComparer.Ordinal)
            .ThenBy(identity => identity.SourceId, StringComparer.Ordinal)
            .Select(Map)
            .ToArray();
    }

    private static ShadowCredentialMapping MapCredential(
        LegacyPlatformIdentity source,
        Guid identityId,
        LegacyCredentialMetadata credential)
    {
        var credentialType = NormalizeCode(credential.Type);
        var publicReference = string.IsNullOrWhiteSpace(credential.PublicReference)
            ? $"{source.SourceSystem}:{source.SourceId}:{credentialType}".ToLowerInvariant()
            : credential.PublicReference.Trim();

        return new ShadowCredentialMapping(
            CredentialId: CreateDeterministicGuid($"credential:{identityId}:{credentialType}:{publicReference}"),
            Type: credentialType,
            PublicReference: publicReference,
            HashAlgorithm: NormalizeNullable(credential.HashAlgorithm),
            Active: credential.Active,
            Supported: SupportedCredentialTypes.Contains(credentialType));
    }

    private static string NormalizeLoginId(string value)
    {
        return value.Trim().ToLowerInvariant();
    }

    private static string? NormalizeNullable(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim().ToLowerInvariant();
    }

    private static string NormalizeCode(string value)
    {
        return value.Trim().Replace(' ', '_').Replace('-', '_').ToUpperInvariant();
    }

    private static IdentityType MapIdentityType(string accountType, string? identityClass)
    {
        var normalized = NormalizeCode(accountType.Length > 0 ? accountType : identityClass ?? string.Empty);
        return normalized switch
        {
            "ADMIN" or "PLATFORM_OPERATOR" or "BREAK_GLASS" => IdentityType.Admin,
            "PLAYER" => IdentityType.Player,
            "AGENT" or "MASTER_AGENT" or "SUPER_MASTER" => IdentityType.Agent,
            "OPERATOR" => IdentityType.Operator,
            "API_CLIENT" => IdentityType.ApiClient,
            "SERVICE_ACCOUNT" => IdentityType.ServiceAccount,
            "PAM_USER" => IdentityType.PamUser,
            _ => IdentityType.PamUser
        };
    }

    private static IdentityLifecycleState MapLifecycleState(string? lifecycleState, string? status)
    {
        var normalized = NormalizeCode(lifecycleState ?? status ?? string.Empty);
        return normalized switch
        {
            "CREATED" => IdentityLifecycleState.Created,
            "PENDING" or "PENDING_ACTIVATION" => IdentityLifecycleState.PendingActivation,
            "ACTIVE" or "ENABLED" => IdentityLifecycleState.Active,
            "SUSPENDED" => IdentityLifecycleState.Suspended,
            "LOCKED" => IdentityLifecycleState.Locked,
            "DISABLED" or "INACTIVE" => IdentityLifecycleState.Disabled,
            "ARCHIVED" => IdentityLifecycleState.Archived,
            "DELETED" => IdentityLifecycleState.Deleted,
            _ => IdentityLifecycleState.Created
        };
    }

    private static Guid CreateDeterministicGuid(string value)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        Span<byte> bytes = stackalloc byte[16];
        hash.AsSpan(0, 16).CopyTo(bytes);
        bytes[7] = (byte)((bytes[7] & 0x0F) | 0x50);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);
        return new Guid(bytes);
    }
}

public sealed record ShadowIdentityMapping(
    string SourceSystem,
    string SourceId,
    Guid IdentityId,
    string LoginId,
    string? Username,
    string? Email,
    IdentityType IdentityType,
    IdentityLifecycleState LifecycleState,
    IReadOnlyCollection<string> Roles,
    IReadOnlyCollection<ShadowClaimMapping> Claims,
    IReadOnlyCollection<ShadowMembershipMapping> Memberships,
    IReadOnlyCollection<ShadowCredentialMapping> Credentials,
    IReadOnlyCollection<string> SupportedCredentialTypes);

public sealed record ShadowCredentialMapping(
    Guid CredentialId,
    string Type,
    string PublicReference,
    string? HashAlgorithm,
    bool Active,
    bool Supported);

public sealed record ShadowClaimMapping(string Type, string Value, string Issuer);

public sealed record ShadowMembershipMapping(
    Guid MembershipId,
    string ScopeType,
    string ScopeId,
    IReadOnlyCollection<string> Roles);
