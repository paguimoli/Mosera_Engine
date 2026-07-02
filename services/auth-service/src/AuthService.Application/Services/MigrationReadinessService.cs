namespace AuthService.Application.Services;

public sealed class MigrationReadinessService
{
    private readonly ShadowIdentityImportService shadowImportService;

    public MigrationReadinessService(ShadowIdentityImportService shadowImportService)
    {
        this.shadowImportService = shadowImportService;
    }

    public async Task<MigrationValidationResponse> ValidateAsync(CancellationToken cancellationToken = default)
    {
        var run = await shadowImportService.RunAsync(cancellationToken);
        return new MigrationValidationResponse(
            RunId: run.RunId,
            Source: run.Source,
            SourceWired: run.SourceWired,
            ReadOnly: run.ReadOnly,
            Persisted: run.Persisted,
            WriteOperationsAttempted: run.WriteOperationsAttempted,
            Errors: run.Validation.Issues.Where(issue => issue.Severity == ShadowValidationSeverity.Error).ToArray(),
            Warnings: run.Validation.Issues.Where(issue => issue.Severity == ShadowValidationSeverity.Warning).ToArray(),
            Blockers: BuildBlockers(run).ToArray(),
            LegacyAuthChanged: run.LegacyAuthChanged);
    }

    public async Task<MigrationReadinessReport> BuildReportAsync(CancellationToken cancellationToken = default)
    {
        var run = await shadowImportService.RunAsync(cancellationToken);
        var identityTypes = run.ImportedIdentities
            .GroupBy(identity => identity.IdentityType, StringComparer.Ordinal)
            .OrderBy(group => group.Key, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Count(), StringComparer.Ordinal);
        var blockers = BuildBlockers(run).ToArray();
        var conflicts = run.Validation.Issues
            .Where(issue => issue.Code.StartsWith("DUPLICATE_", StringComparison.Ordinal))
            .ToArray();
        var readinessScore = CalculateReadinessScore(run, blockers.Length);

        return new MigrationReadinessReport(
            Summary: new MigrationSummary(
                Status: blockers.Length == 0 ? "READY_FOR_OPERATOR_REVIEW" : "BLOCKED",
                CanMigrateToday: blockers.Length == 0,
                IdentitiesDiscovered: run.ImportedIdentities.Count,
                Source: run.Source,
                SourceWired: run.SourceWired,
                ReadOnly: run.ReadOnly,
                NoWrites: run.WriteOperationsAttempted == 0 && !run.Persisted,
                LegacyAuthUnchanged: !run.LegacyAuthChanged),
            IdentityTypes: identityTypes,
            Conflicts: conflicts,
            Warnings: run.Validation.Issues.Where(issue => issue.Severity == ShadowValidationSeverity.Warning).ToArray(),
            Errors: run.Validation.Issues.Where(issue => issue.Severity == ShadowValidationSeverity.Error).ToArray(),
            MigrationBlockers: blockers,
            EstimatedMigrationDuration: EstimateDuration(run.ImportedIdentities.Count),
            ReadinessScore: readinessScore,
            ShadowImportedIdentities: run.ImportedIdentities,
            ExportableJsonReport: true,
            GeneratedAt: run.CapturedAt);
    }

    private static IEnumerable<MigrationBlocker> BuildBlockers(ShadowImportRun run)
    {
        if (!run.SourceWired)
        {
            yield return new MigrationBlocker(
                "LEGACY_SOURCE_NOT_WIRED",
                "Legacy platform database adapter is not wired for this Auth Service runtime.");
        }

        foreach (var issue in run.Validation.Issues.Where(issue => issue.Severity == ShadowValidationSeverity.Error))
        {
            yield return new MigrationBlocker(issue.Code, issue.Message);
        }
    }

    private static int CalculateReadinessScore(ShadowImportRun run, int blockerCount)
    {
        var score = 100;
        score -= blockerCount * 15;
        score -= run.Validation.WarningCount * 3;
        if (!run.SourceWired)
        {
            score -= 20;
        }

        if (run.WriteOperationsAttempted > 0 || run.Persisted || run.LegacyAuthChanged)
        {
            score = 0;
        }

        return Math.Clamp(score, 0, 100);
    }

    private static string EstimateDuration(int identityCount)
    {
        var minutes = Math.Max(5, (int)Math.Ceiling(identityCount / 500.0));
        return $"PT{minutes}M";
    }
}

public sealed record MigrationValidationResponse(
    string RunId,
    string Source,
    bool SourceWired,
    bool ReadOnly,
    bool Persisted,
    int WriteOperationsAttempted,
    IReadOnlyCollection<ShadowValidationIssue> Errors,
    IReadOnlyCollection<ShadowValidationIssue> Warnings,
    IReadOnlyCollection<MigrationBlocker> Blockers,
    bool LegacyAuthChanged);

public sealed record MigrationReadinessReport(
    MigrationSummary Summary,
    IReadOnlyDictionary<string, int> IdentityTypes,
    IReadOnlyCollection<ShadowValidationIssue> Conflicts,
    IReadOnlyCollection<ShadowValidationIssue> Warnings,
    IReadOnlyCollection<ShadowValidationIssue> Errors,
    IReadOnlyCollection<MigrationBlocker> MigrationBlockers,
    string EstimatedMigrationDuration,
    int ReadinessScore,
    IReadOnlyCollection<ShadowImportedIdentity> ShadowImportedIdentities,
    bool ExportableJsonReport,
    DateTimeOffset GeneratedAt);

public sealed record MigrationSummary(
    string Status,
    bool CanMigrateToday,
    int IdentitiesDiscovered,
    string Source,
    bool SourceWired,
    bool ReadOnly,
    bool NoWrites,
    bool LegacyAuthUnchanged);

public sealed record MigrationBlocker(string Code, string Description);
