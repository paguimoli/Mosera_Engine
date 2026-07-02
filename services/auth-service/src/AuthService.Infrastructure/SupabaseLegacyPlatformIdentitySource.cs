using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using AuthService.Application.Services;

namespace AuthService.Infrastructure;

public sealed class SupabaseLegacyPlatformIdentitySource : ILegacyPlatformIdentitySource
{
    private readonly HttpClient httpClient;
    private readonly string supabaseUrl;
    private readonly string serviceRoleKey;

    public SupabaseLegacyPlatformIdentitySource(HttpClient httpClient)
    {
        this.httpClient = httpClient;
        supabaseUrl = Environment.GetEnvironmentVariable("QA_SUPABASE_URL")
            ?? Environment.GetEnvironmentVariable("SUPABASE_URL")
            ?? Environment.GetEnvironmentVariable("NEXT_PUBLIC_SUPABASE_URL")
            ?? string.Empty;
        serviceRoleKey = Environment.GetEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY") ?? string.Empty;
    }

    public bool Configured => !string.IsNullOrWhiteSpace(supabaseUrl) && !string.IsNullOrWhiteSpace(serviceRoleKey);

    public async Task<LegacyPlatformSnapshot> ReadSnapshotAsync(CancellationToken cancellationToken = default)
    {
        if (!Configured)
        {
            return await new EmptyLegacyPlatformIdentitySource().ReadSnapshotAsync(cancellationToken);
        }

        var users = await GetRowsAsync<PlatformUserRow>("platform_users", cancellationToken);
        var groups = await GetRowsAsync<UserGroupRow>("user_groups", cancellationToken);
        var memberships = await GetRowsAsync<UserGroupMembershipRow>("user_group_memberships", cancellationToken);
        var permissions = await GetRowsAsync<PermissionRow>("permissions", cancellationToken);
        var userGroupPermissions = await GetRowsAsync<UserGroupPermissionRow>("user_group_permissions", cancellationToken);
        var legacyGroupPermissions = await GetRowsAsync<GroupPermissionRow>("group_permissions", cancellationToken);
        var sessions = await GetRowsAsync<UserSessionRow>("user_sessions", cancellationToken);
        var mfaFactors = await GetRowsAsync<MfaFactorRow>("user_mfa_factors", cancellationToken);
        var recoveryCodes = await GetRowsAsync<MfaRecoveryCodeRow>("mfa_recovery_codes", cancellationToken);
        var breakGlassAccounts = await GetRowsAsync<BreakGlassAccountRow>("break_glass_accounts", cancellationToken);
        var accounts = await GetRowsAsync<AccountRow>("accounts", cancellationToken);
        var apiClients = await GetRowsAsync<ApiClientRow>("oauth_clients", cancellationToken);

        var groupById = groups.ToDictionary(group => group.Id, StringComparer.OrdinalIgnoreCase);
        var permissionById = permissions.ToDictionary(permission => permission.Id, StringComparer.OrdinalIgnoreCase);
        var permissionKeysByGroup = BuildPermissionKeysByGroup(userGroupPermissions, legacyGroupPermissions, permissionById);
        var groupIdsByUser = memberships
            .GroupBy(membership => membership.UserId, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.Select(membership => membership.GroupId).ToArray(), StringComparer.OrdinalIgnoreCase);
        var mfaByUser = mfaFactors.GroupBy(factor => factor.UserId, StringComparer.OrdinalIgnoreCase).ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.OrdinalIgnoreCase);
        var recoveryCodeCountsByUser = recoveryCodes.GroupBy(code => code.UserId, StringComparer.OrdinalIgnoreCase).ToDictionary(group => group.Key, group => group.Count(), StringComparer.OrdinalIgnoreCase);
        var breakGlassUserIds = breakGlassAccounts.Select(account => account.UserId).ToHashSet(StringComparer.OrdinalIgnoreCase);

        var identities = new List<LegacyPlatformIdentity>();
        identities.AddRange(users.Select(user => MapUser(user, groupIdsByUser, groupById, permissionKeysByGroup, mfaByUser, recoveryCodeCountsByUser, breakGlassUserIds)));
        identities.AddRange(accounts.Select(MapAccount));
        identities.AddRange(apiClients.Select(MapApiClient));

        return new LegacyPlatformSnapshot(
            Source: "supabase-rest-readonly",
            SourceWired: true,
            CapturedAt: DateTimeOffset.UtcNow,
            Identities: identities.OrderBy(identity => identity.SourceSystem, StringComparer.Ordinal).ThenBy(identity => identity.SourceId, StringComparer.Ordinal).ToArray(),
            Sessions: sessions.Select(MapSession).OrderBy(session => session.SessionId, StringComparer.Ordinal).ToArray(),
            Roles: groups.Select(group => new LegacyRoleMetadata(group.Name, permissionKeysByGroup.GetValueOrDefault(group.Id, []))).ToArray(),
            Permissions: permissions.Select(permission => permission.PermissionKey).Order(StringComparer.Ordinal).ToArray(),
            PlayerAccountCount: accounts.Count(account => string.Equals(account.AccountType, "PLAYER", StringComparison.OrdinalIgnoreCase)),
            AgentAccountCount: accounts.Count(account => !string.Equals(account.AccountType, "PLAYER", StringComparison.OrdinalIgnoreCase)),
            AdminAccountCount: users.Count(user => string.Equals(user.IdentityClass, "PLATFORM_OPERATOR", StringComparison.OrdinalIgnoreCase)),
            ServiceAccountCount: users.Count(user => string.Equals(user.IdentityClass, "SYSTEM_SERVICE", StringComparison.OrdinalIgnoreCase)),
            ApiClientCount: apiClients.Count);
    }

    private async Task<IReadOnlyCollection<T>> GetRowsAsync<T>(string table, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, BuildTableUri(table));
        request.Headers.TryAddWithoutValidation("apikey", serviceRoleKey);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", serviceRoleKey);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        using var response = await httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            return [];
        }

        await using var content = await response.Content.ReadAsStreamAsync(cancellationToken);
        return await JsonSerializer.DeserializeAsync<IReadOnlyCollection<T>>(content, JsonOptions, cancellationToken) ?? [];
    }

    private Uri BuildTableUri(string table)
    {
        var baseUri = supabaseUrl.TrimEnd('/');
        return new Uri($"{baseUri}/rest/v1/{table}?select=*");
    }

    private static Dictionary<string, IReadOnlyCollection<string>> BuildPermissionKeysByGroup(
        IReadOnlyCollection<UserGroupPermissionRow> userGroupPermissions,
        IReadOnlyCollection<GroupPermissionRow> legacyGroupPermissions,
        IReadOnlyDictionary<string, PermissionRow> permissionById)
    {
        var permissions = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var assignment in userGroupPermissions)
        {
            if (!permissionById.TryGetValue(assignment.PermissionId, out var permission))
            {
                continue;
            }

            AddPermission(permissions, assignment.GroupId, permission.PermissionKey);
        }

        foreach (var assignment in legacyGroupPermissions)
        {
            AddPermission(permissions, assignment.GroupId, assignment.PermissionKey);
        }

        return permissions.ToDictionary(
            item => item.Key,
            item => (IReadOnlyCollection<string>)item.Value.Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.Ordinal).ToArray(),
            StringComparer.OrdinalIgnoreCase);
    }

    private static void AddPermission(Dictionary<string, List<string>> permissions, string groupId, string permission)
    {
        if (!permissions.TryGetValue(groupId, out var groupPermissions))
        {
            groupPermissions = [];
            permissions[groupId] = groupPermissions;
        }

        groupPermissions.Add(permission);
    }

    private static LegacyPlatformIdentity MapUser(
        PlatformUserRow user,
        IReadOnlyDictionary<string, string[]> groupIdsByUser,
        IReadOnlyDictionary<string, UserGroupRow> groupById,
        IReadOnlyDictionary<string, IReadOnlyCollection<string>> permissionKeysByGroup,
        IReadOnlyDictionary<string, MfaFactorRow[]> mfaByUser,
        IReadOnlyDictionary<string, int> recoveryCodeCountsByUser,
        IReadOnlySet<string> breakGlassUserIds)
    {
        var groupIds = groupIdsByUser.GetValueOrDefault(user.Id, []);
        var roles = groupIds
            .Where(groupById.ContainsKey)
            .Select(groupId => new LegacyRoleMetadata(groupById[groupId].Name, permissionKeysByGroup.GetValueOrDefault(groupId, [])))
            .ToList();
        var permissionClaims = roles
            .SelectMany(role => role.Permissions)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(permission => new LegacyClaimMetadata("permission", permission, "legacy-platform"))
            .ToList();
        var credentials = new List<LegacyCredentialMetadata>();

        if (!string.IsNullOrWhiteSpace(user.PasswordHash))
        {
            credentials.Add(new LegacyCredentialMetadata(
                "PASSWORD_HASH",
                $"platform_users:{user.Id}:password",
                InferPasswordHashAlgorithm(user.PasswordHash),
                Active: true));
        }

        if (mfaByUser.TryGetValue(user.Id, out var factors))
        {
            credentials.AddRange(factors.Select(factor => new LegacyCredentialMetadata(
                factor.FactorType,
                $"user_mfa_factors:{factor.Id}",
                null,
                factor.IsEnabled)));
        }

        if (recoveryCodeCountsByUser.GetValueOrDefault(user.Id) > 0)
        {
            credentials.Add(new LegacyCredentialMetadata(
                "RECOVERY_CODE",
                $"mfa_recovery_codes:{user.Id}",
                "HASHED",
                Active: true));
        }

        if (breakGlassUserIds.Contains(user.Id))
        {
            roles.Add(new LegacyRoleMetadata("BREAK_GLASS", ["system.admin"]));
        }

        return new LegacyPlatformIdentity(
            SourceSystem: "platform_users",
            SourceId: user.Id,
            AccountType: MapUserAccountType(user.IdentityClass, breakGlassUserIds.Contains(user.Id)),
            IdentityClass: user.IdentityClass,
            LoginId: user.Username,
            Username: user.Username,
            Email: user.Email,
            Status: user.Status,
            LifecycleState: null,
            Roles: roles,
            Claims: permissionClaims,
            Credentials: credentials,
            Memberships: [new LegacyMembershipMetadata("GLOBAL", "platform", roles.Select(role => role.Code).ToArray())]);
    }

    private static LegacyPlatformIdentity MapAccount(AccountRow account)
    {
        return new LegacyPlatformIdentity(
            SourceSystem: "accounts",
            SourceId: account.Id,
            AccountType: account.AccountType,
            IdentityClass: account.AccountType,
            LoginId: account.AccountCode,
            Username: account.AccountCode,
            Email: null,
            Status: account.Status,
            LifecycleState: null,
            Roles: [new LegacyRoleMetadata(account.AccountType, [])],
            Claims: [new LegacyClaimMetadata("account_code", account.AccountCode, "legacy-platform")],
            Credentials: [],
            Memberships:
            [
                new LegacyMembershipMetadata("ACCOUNT", account.Id, [account.AccountType]),
                new LegacyMembershipMetadata("MARKET", account.MarketId, [account.AccountType]),
                new LegacyMembershipMetadata("BRAND", account.BrandId, [account.AccountType])
            ]);
    }

    private static LegacyPlatformIdentity MapApiClient(ApiClientRow client)
    {
        var scopes = ReadStringArray(client.AllowedScopes);
        return new LegacyPlatformIdentity(
            SourceSystem: "oauth_clients",
            SourceId: client.Id,
            AccountType: "API_CLIENT",
            IdentityClass: "API_CLIENT",
            LoginId: client.ClientId,
            Username: client.ClientId,
            Email: null,
            Status: client.Status,
            LifecycleState: null,
            Roles: [new LegacyRoleMetadata("API_CLIENT", scopes)],
            Claims: scopes.Select(scope => new LegacyClaimMetadata("scope", scope, "legacy-platform")).ToArray(),
            Credentials: string.IsNullOrWhiteSpace(client.ClientSecretHash)
                ? []
                : [new LegacyCredentialMetadata("CLIENT_SECRET", $"oauth_clients:{client.Id}:client_secret", "HASHED", Active: true)],
            Memberships: [new LegacyMembershipMetadata("GLOBAL", "platform", ["API_CLIENT"])]);
    }

    private static LegacySessionMetadata MapSession(UserSessionRow session)
    {
        return new LegacySessionMetadata(
            SessionId: session.Id,
            IdentitySourceKey: $"platform_users:{session.UserId}",
            State: string.IsNullOrWhiteSpace(session.RevokedAt) ? "ACTIVE" : "REVOKED",
            ExpiresAt: DateTimeOffset.TryParse(session.ExpiresAt, out var expiresAt) ? expiresAt : DateTimeOffset.MinValue);
    }

    private static string MapUserAccountType(string identityClass, bool breakGlass)
    {
        if (breakGlass)
        {
            return "BREAK_GLASS";
        }

        return identityClass.ToUpperInvariant() switch
        {
            "PLATFORM_OPERATOR" => "ADMIN",
            "PLAYER" => "PLAYER",
            "HIERARCHY_PARTICIPANT" => "AGENT",
            "SYSTEM_SERVICE" => "SERVICE_ACCOUNT",
            _ => identityClass
        };
    }

    private static string InferPasswordHashAlgorithm(string passwordHash)
    {
        if (passwordHash.StartsWith("$argon2", StringComparison.OrdinalIgnoreCase))
        {
            return "ARGON2ID";
        }

        if (passwordHash.StartsWith("$2", StringComparison.Ordinal))
        {
            return "BCRYPT";
        }

        return "UNKNOWN";
    }

    private static IReadOnlyCollection<string> ReadStringArray(JsonElement element)
    {
        return element.ValueKind == JsonValueKind.Array
            ? element.EnumerateArray().Select(item => item.GetString()).Where(item => !string.IsNullOrWhiteSpace(item)).Select(item => item!).ToArray()
            : [];
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private sealed record PlatformUserRow(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("username")] string Username,
        [property: JsonPropertyName("email")] string Email,
        [property: JsonPropertyName("identity_class")] string IdentityClass,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("password_hash")] string? PasswordHash);

    private sealed record UserGroupRow(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("name")] string Name);

    private sealed record UserGroupMembershipRow(
        [property: JsonPropertyName("user_id")] string UserId,
        [property: JsonPropertyName("group_id")] string GroupId);

    private sealed record PermissionRow(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("permission_key")] string PermissionKey);

    private sealed record UserGroupPermissionRow(
        [property: JsonPropertyName("group_id")] string GroupId,
        [property: JsonPropertyName("permission_id")] string PermissionId);

    private sealed record GroupPermissionRow(
        [property: JsonPropertyName("group_id")] string GroupId,
        [property: JsonPropertyName("permission_key")] string PermissionKey);

    private sealed record UserSessionRow(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("user_id")] string UserId,
        [property: JsonPropertyName("expires_at")] string ExpiresAt,
        [property: JsonPropertyName("revoked_at")] string? RevokedAt);

    private sealed record MfaFactorRow(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("user_id")] string UserId,
        [property: JsonPropertyName("factor_type")] string FactorType,
        [property: JsonPropertyName("is_enabled")] bool IsEnabled);

    private sealed record MfaRecoveryCodeRow(
        [property: JsonPropertyName("user_id")] string UserId);

    private sealed record BreakGlassAccountRow(
        [property: JsonPropertyName("user_id")] string UserId);

    private sealed record AccountRow(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("account_type")] string AccountType,
        [property: JsonPropertyName("account_code")] string AccountCode,
        [property: JsonPropertyName("market_id")] string MarketId,
        [property: JsonPropertyName("brand_id")] string BrandId,
        [property: JsonPropertyName("status")] string Status);

    private sealed record ApiClientRow(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("client_id")] string ClientId,
        [property: JsonPropertyName("client_secret_hash")] string? ClientSecretHash,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("allowed_scopes")] JsonElement AllowedScopes);
}
