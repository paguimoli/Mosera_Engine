namespace AuthService.Application.Services;

public sealed class ShadowIdentityImportService
{
    private readonly ILegacyPlatformIdentitySource legacySource;
    private readonly IdentityMappingService mappingService;
    private readonly ShadowValidationService validationService;

    public ShadowIdentityImportService(
        ILegacyPlatformIdentitySource legacySource,
        IdentityMappingService mappingService,
        ShadowValidationService validationService)
    {
        this.legacySource = legacySource;
        this.mappingService = mappingService;
        this.validationService = validationService;
    }

    public async Task<ShadowImportRun> RunAsync(CancellationToken cancellationToken = default)
    {
        var snapshot = await legacySource.ReadSnapshotAsync(cancellationToken);
        var mappings = mappingService.MapAll(snapshot);
        var validation = validationService.Validate(snapshot, mappings);
        var identities = mappings
            .Select(mapping => new ShadowImportedIdentity(
                mapping.IdentityId,
                mapping.LoginId,
                mapping.IdentityType.ToString(),
                mapping.LifecycleState.ToString(),
                mapping.Memberships,
                mapping.Roles,
                mapping.Claims,
                mapping.Credentials))
            .OrderBy(identity => identity.LoginId, StringComparer.Ordinal)
            .ToArray();

        return new ShadowImportRun(
            RunId: CreateRunId(snapshot),
            Source: snapshot.Source,
            SourceWired: snapshot.SourceWired,
            CapturedAt: snapshot.CapturedAt,
            ImportedIdentities: identities,
            Validation: validation,
            ReadOnly: true,
            Persisted: false,
            Authenticated: false,
            SessionsCreated: false,
            TokensIssued: false,
            LegacyAuthChanged: false,
            WriteOperationsAttempted: 0);
    }

    public async Task<ShadowImportStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        var run = await RunAsync(cancellationToken);
        return new ShadowImportStatus(
            Status: run.Validation.ErrorCount == 0 ? "READY_FOR_MIGRATION_REVIEW" : "BLOCKED",
            Source: run.Source,
            SourceWired: run.SourceWired,
            ReadOnly: run.ReadOnly,
            Persisted: run.Persisted,
            WriteOperationsAttempted: run.WriteOperationsAttempted,
            IdentitiesDiscovered: run.ImportedIdentities.Count,
            Errors: run.Validation.ErrorCount,
            Warnings: run.Validation.WarningCount,
            LastRunId: run.RunId);
    }

    private static string CreateRunId(LegacyPlatformSnapshot snapshot)
    {
        return $"shadow-import-{snapshot.Source}-{snapshot.CapturedAt:yyyyMMddHHmmss}";
    }
}

public interface ILegacyPlatformIdentitySource
{
    Task<LegacyPlatformSnapshot> ReadSnapshotAsync(CancellationToken cancellationToken = default);
}

public sealed class EmptyLegacyPlatformIdentitySource : ILegacyPlatformIdentitySource
{
    private static readonly DateTimeOffset CapturedAt = new(2026, 7, 1, 0, 0, 0, TimeSpan.Zero);

    public Task<LegacyPlatformSnapshot> ReadSnapshotAsync(CancellationToken cancellationToken = default)
    {
        return Task.FromResult(new LegacyPlatformSnapshot(
            Source: "legacy-platform-unwired",
            SourceWired: false,
            CapturedAt: CapturedAt,
            Identities: [],
            Sessions: [],
            Roles: [],
            Permissions: [],
            PlayerAccountCount: 0,
            AgentAccountCount: 0,
            AdminAccountCount: 0,
            ServiceAccountCount: 0,
            ApiClientCount: 0));
    }
}

public sealed record LegacyPlatformSnapshot(
    string Source,
    bool SourceWired,
    DateTimeOffset CapturedAt,
    IReadOnlyCollection<LegacyPlatformIdentity> Identities,
    IReadOnlyCollection<LegacySessionMetadata> Sessions,
    IReadOnlyCollection<LegacyRoleMetadata> Roles,
    IReadOnlyCollection<string> Permissions,
    int PlayerAccountCount,
    int AgentAccountCount,
    int AdminAccountCount,
    int ServiceAccountCount,
    int ApiClientCount);

public sealed record LegacyPlatformIdentity(
    string SourceSystem,
    string SourceId,
    string AccountType,
    string? IdentityClass,
    string? LoginId,
    string? Username,
    string? Email,
    string? Status,
    string? LifecycleState,
    IReadOnlyCollection<LegacyRoleMetadata> Roles,
    IReadOnlyCollection<LegacyClaimMetadata> Claims,
    IReadOnlyCollection<LegacyCredentialMetadata> Credentials,
    IReadOnlyCollection<LegacyMembershipMetadata> Memberships);

public sealed record LegacyRoleMetadata(
    string Code,
    IReadOnlyCollection<string> Permissions);

public sealed record LegacyClaimMetadata(
    string Type,
    string Value,
    string Issuer);

public sealed record LegacyCredentialMetadata(
    string Type,
    string PublicReference,
    string? HashAlgorithm,
    bool Active);

public sealed record LegacyMembershipMetadata(
    string ScopeType,
    string ScopeId,
    IReadOnlyCollection<string> RoleCodes);

public sealed record LegacySessionMetadata(
    string SessionId,
    string IdentitySourceKey,
    string State,
    DateTimeOffset ExpiresAt);

public sealed record ShadowImportRun(
    string RunId,
    string Source,
    bool SourceWired,
    DateTimeOffset CapturedAt,
    IReadOnlyCollection<ShadowImportedIdentity> ImportedIdentities,
    ShadowValidationResult Validation,
    bool ReadOnly,
    bool Persisted,
    bool Authenticated,
    bool SessionsCreated,
    bool TokensIssued,
    bool LegacyAuthChanged,
    int WriteOperationsAttempted);

public sealed record ShadowImportedIdentity(
    Guid IdentityId,
    string LoginId,
    string IdentityType,
    string LifecycleState,
    IReadOnlyCollection<ShadowMembershipMapping> Memberships,
    IReadOnlyCollection<string> Roles,
    IReadOnlyCollection<ShadowClaimMapping> Claims,
    IReadOnlyCollection<ShadowCredentialMapping> Credentials);

public sealed record ShadowImportStatus(
    string Status,
    string Source,
    bool SourceWired,
    bool ReadOnly,
    bool Persisted,
    int WriteOperationsAttempted,
    int IdentitiesDiscovered,
    int Errors,
    int Warnings,
    string LastRunId);
