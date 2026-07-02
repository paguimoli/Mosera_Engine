using AuthService.Domain.Models;

namespace AuthService.Application.Services;

public sealed class ShadowValidationService
{
    private static readonly HashSet<string> KnownRoleCodes = new(StringComparer.OrdinalIgnoreCase)
    {
        "SUPER_ADMIN",
        "OPERATIONS_ADMIN",
        "COMPLIANCE_ADMIN",
        "FINANCE_ADMIN",
        "SUPPORT_ADMIN",
        "RISK_ADMIN",
        "TECHNICAL_ADMIN",
        "MASTER_AGENT",
        "AGENT",
        "PLAYER",
        "SERVICE_ACCOUNT",
        "API_CLIENT",
        "BREAK_GLASS"
    };

    private static readonly HashSet<string> KnownMembershipScopes = new(StringComparer.OrdinalIgnoreCase)
    {
        "GLOBAL",
        "TENANT",
        "BRAND",
        "MARKET",
        "OPERATOR",
        "JURISDICTION",
        "PAM",
        "ACCOUNT"
    };

    private static readonly HashSet<string> KnownAccountTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "ADMIN",
        "PLATFORM_OPERATOR",
        "BREAK_GLASS",
        "PLAYER",
        "AGENT",
        "MASTER_AGENT",
        "SUPER_MASTER",
        "OPERATOR",
        "API_CLIENT",
        "SERVICE_ACCOUNT",
        "PAM_USER"
    };

    public ShadowValidationResult Validate(
        LegacyPlatformSnapshot snapshot,
        IReadOnlyCollection<ShadowIdentityMapping> mappings)
    {
        var issues = new List<ShadowValidationIssue>();
        var mappingBySource = mappings.ToDictionary(
            mapping => $"{mapping.SourceSystem}:{mapping.SourceId}",
            StringComparer.Ordinal);

        AddDuplicateIssues(issues, mappings, mapping => mapping.Username, "DUPLICATE_USERNAME", "Duplicate username.");
        AddDuplicateIssues(issues, mappings, mapping => mapping.Email, "DUPLICATE_EMAIL", "Duplicate email.");
        AddDuplicateIssues(issues, mappings, mapping => mapping.LoginId, "DUPLICATE_LOGIN_ID", "Duplicate login ID.");

        foreach (var source in snapshot.Identities.OrderBy(identity => identity.SourceId, StringComparer.Ordinal))
        {
            var sourceKey = $"{source.SourceSystem}:{source.SourceId}";
            if (!mappingBySource.TryGetValue(sourceKey, out var mapping))
            {
                issues.Add(Error("ORPHAN_IDENTITY", source.SourceId, "Source identity did not produce a mapping."));
                continue;
            }

            if (string.IsNullOrWhiteSpace(source.LoginId) &&
                string.IsNullOrWhiteSpace(source.Username) &&
                string.IsNullOrWhiteSpace(source.Email))
            {
                issues.Add(Error("ORPHAN_IDENTITY", source.SourceId, "Identity has no login, username, or email."));
            }

            if (mapping.Credentials.Count == 0)
            {
                issues.Add(Error("MISSING_CREDENTIALS", source.SourceId, "Identity has no credential metadata."));
            }

            if (source.Credentials.Any(credential => string.IsNullOrWhiteSpace(credential.Type)))
            {
                issues.Add(Error("UNSUPPORTED_CREDENTIAL_TYPE", source.SourceId, "Credential type is missing."));
            }

            foreach (var credential in mapping.Credentials.Where(credential => !credential.Supported))
            {
                issues.Add(Error("UNSUPPORTED_CREDENTIAL_TYPE", source.SourceId, $"Unsupported credential type: {credential.Type}."));
            }

            foreach (var role in mapping.Roles.Where(role => !KnownRoleCodes.Contains(role)))
            {
                issues.Add(Error("INVALID_ROLE_MAPPING", source.SourceId, $"Unknown role mapping: {role}."));
            }

            foreach (var membership in mapping.Memberships)
            {
                if (!KnownMembershipScopes.Contains(membership.ScopeType) || string.IsNullOrWhiteSpace(membership.ScopeId))
                {
                    issues.Add(Error("INVALID_MEMBERSHIP", source.SourceId, $"Invalid membership scope: {membership.ScopeType}."));
                }
            }

            if (string.IsNullOrWhiteSpace(source.LifecycleState) && string.IsNullOrWhiteSpace(source.Status))
            {
                issues.Add(Error("MISSING_LIFECYCLE_STATE", source.SourceId, "Lifecycle state is missing."));
            }

            if (!KnownAccountTypes.Contains(source.AccountType))
            {
                issues.Add(Error("UNKNOWN_ACCOUNT_TYPE", source.SourceId, $"Unknown account type: {source.AccountType}."));
            }
        }

        foreach (var session in snapshot.Sessions.Where(session => !mappingBySource.ContainsKey(session.IdentitySourceKey)))
        {
            issues.Add(Warning("ORPHAN_SESSION", session.IdentitySourceKey, "Session references an identity outside the migration snapshot."));
        }

        return new ShadowValidationResult(
            Issues: issues.OrderBy(issue => issue.Severity.ToString(), StringComparer.Ordinal)
                .ThenBy(issue => issue.Code, StringComparer.Ordinal)
                .ThenBy(issue => issue.SourceId, StringComparer.Ordinal)
                .ThenBy(issue => issue.Message, StringComparer.Ordinal)
                .ToArray(),
            ErrorCount: issues.Count(issue => issue.Severity == ShadowValidationSeverity.Error),
            WarningCount: issues.Count(issue => issue.Severity == ShadowValidationSeverity.Warning));
    }

    private static void AddDuplicateIssues(
        List<ShadowValidationIssue> issues,
        IReadOnlyCollection<ShadowIdentityMapping> mappings,
        Func<ShadowIdentityMapping, string?> selector,
        string code,
        string message)
    {
        foreach (var group in mappings
                     .Select(mapping => new { Mapping = mapping, Value = selector(mapping) })
                     .Where(item => !string.IsNullOrWhiteSpace(item.Value))
                     .GroupBy(item => item.Value!, StringComparer.OrdinalIgnoreCase)
                     .Where(group => group.Count() > 1)
                     .OrderBy(group => group.Key, StringComparer.Ordinal))
        {
            foreach (var item in group.OrderBy(item => item.Mapping.SourceId, StringComparer.Ordinal))
            {
                issues.Add(Error(code, item.Mapping.SourceId, $"{message} Value: {group.Key}."));
            }
        }
    }

    private static ShadowValidationIssue Error(string code, string sourceId, string message)
    {
        return new ShadowValidationIssue(ShadowValidationSeverity.Error, code, sourceId, message);
    }

    private static ShadowValidationIssue Warning(string code, string sourceId, string message)
    {
        return new ShadowValidationIssue(ShadowValidationSeverity.Warning, code, sourceId, message);
    }
}

public sealed record ShadowValidationResult(
    IReadOnlyCollection<ShadowValidationIssue> Issues,
    int ErrorCount,
    int WarningCount);

public sealed record ShadowValidationIssue(
    ShadowValidationSeverity Severity,
    string Code,
    string SourceId,
    string Message);

public enum ShadowValidationSeverity
{
    Error,
    Warning
}
