using GameEngine.Domain.DrawAuthorities;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class DrawAuthorityRegistry : IDrawAuthorityRegistry
{
    private readonly List<IDrawProvider> providers;
    private readonly List<DrawAuthorityRegistryEntry> registeredAuthorities = [];
    private readonly List<DrawAuthorityRegistryEntry> invalidAuthorities = [];
    private readonly List<DrawResultSubmissionDefinition> submissions = [];
    private readonly DrawAuthorityApprovalGate approvalGate = new();

    public DrawAuthorityRegistry()
    {
        providers =
        [
            new ManualCertifiedResultProvider(),
            new OfficialFeedProvider(),
            new InternalProductionPrngProvider(),
            new InternalTestPrngProvider(),
            new ExternalRngProviderPlaceholder()
        ];

        RegisterSeedAuthorities();
        SeedResultSubmissions();
    }

    public IReadOnlyCollection<DrawProviderMetadata> GetProviders()
    {
        return providers.Select(provider => provider.GetProviderMetadata()).ToArray();
    }

    public IReadOnlyCollection<DrawAuthorityRegistryEntry> GetRegisteredAuthorities() => registeredAuthorities.ToArray();

    public IReadOnlyCollection<DrawAuthorityRegistryEntry> GetInvalidAuthorities() => invalidAuthorities.ToArray();

    public IReadOnlyCollection<DrawAuthorityRegistryEntry> GetActiveAuthorities()
    {
        return registeredAuthorities
            .Where(entry => entry.Authority.Status is DrawAuthorityStatus.Production or DrawAuthorityStatus.ExternallyCertified or DrawAuthorityStatus.InternallyApproved)
            .ToArray();
    }

    public IReadOnlyCollection<DrawAuthorityRegistryEntry> GetRetiredAuthorities()
    {
        return registeredAuthorities.Where(entry => entry.Authority.Status == DrawAuthorityStatus.Retired).ToArray();
    }

    public IReadOnlyCollection<DrawAuthorityRegistryEntry> GetProductionReadyAuthorities()
    {
        return registeredAuthorities.Where(entry => entry.ProductionReady).ToArray();
    }

    public DrawAuthorityRegistryEntry? GetAuthority(Guid id)
    {
        return registeredAuthorities.Concat(invalidAuthorities).FirstOrDefault(entry => entry.Authority.Id == id);
    }

    public IReadOnlyCollection<DrawAuthorityVersionDefinition> GetAuthorityVersions(Guid id)
    {
        return registeredAuthorities
            .Concat(invalidAuthorities)
            .Where(entry => entry.Authority.Id == id)
            .Select(entry => entry.Version)
            .ToArray();
    }

    public DrawAuthorityRegistryStatus GetRegistryStatus()
    {
        var reasons = new List<string>();
        if (invalidAuthorities.Count > 0)
        {
            reasons.Add("One or more Draw Authorities are invalid.");
        }

        if (GetProductionReadyAuthorities().Count == 0)
        {
            reasons.Add("No Draw Authority is currently production-ready.");
        }

        reasons.Add("Production RNG and external feed integrations are placeholders only.");

        return new DrawAuthorityRegistryStatus(
            GameModuleRegistryHealth.Warning,
            registeredAuthorities.Count,
            GetActiveAuthorities().Count,
            GetRetiredAuthorities().Count,
            GetProductionReadyAuthorities().Count,
            invalidAuthorities.Count,
            providers.Count,
            reasons,
            DateTimeOffset.UtcNow);
    }

    public DrawAuthorityAssignmentDefinition ValidateAssignment(
        Guid authorityId,
        Guid gameBindingId,
        bool productionBinding,
        IReadOnlyCollection<DrawAuthorityCapability> requiredCapabilities,
        bool externallyCertifiedSufficient = true)
    {
        var entry = GetAuthority(authorityId) ?? throw new InvalidOperationException("Draw Authority not found.");
        var request = new DrawAuthorityAssignmentValidationRequest(
            entry.Authority,
            entry.Version,
            entry.ProviderMetadata,
            entry.ProviderHealth,
            requiredCapabilities,
            productionBinding,
            externallyCertifiedSufficient);
        return new DrawAuthorityAssignmentValidator(approvalGate).ValidateAssignment(request, gameBindingId);
    }

    public IReadOnlyCollection<DrawResultSubmissionDefinition> GetResultSubmissions() => submissions.ToArray();

    public IReadOnlyCollection<OfficialCertifiedDrawResultDefinition> GetOfficialCertifiedResults()
    {
        return CreateCertificationService().GetOfficialResults();
    }

    public OfficialCertifiedDrawResultDefinition CertifyResult(DrawCertificationDecision decision)
    {
        return CreateCertificationService().CertifyResult(decision);
    }

    private DrawCertificationService CreateCertificationService()
    {
        return new DrawCertificationService(registeredAuthorities, submissions);
    }

    private void RegisterSeedAuthorities()
    {
        RegisterAuthority(
            "manual-certified-entry",
            "Manual Certified Entry",
            DrawAuthorityType.ManualCertifiedEntry,
            DrawProviderType.ManualCertifiedEntry,
            DrawAuthorityStatus.Testing,
            DrawAuthorityApprovalStatus.InternallyApproved,
            providers.OfType<ManualCertifiedResultProvider>().Single());

        RegisterAuthority(
            "official-feed-placeholder",
            "Official Feed Placeholder",
            DrawAuthorityType.OfficialFeed,
            DrawProviderType.OfficialFeed,
            DrawAuthorityStatus.Testing,
            DrawAuthorityApprovalStatus.NotApproved,
            providers.OfType<OfficialFeedProvider>().Single());

        RegisterAuthority(
            "internal-production-prng",
            "Internal Production PRNG",
            DrawAuthorityType.InternalProductionPrng,
            DrawProviderType.InternalProductionPrng,
            DrawAuthorityStatus.Draft,
            DrawAuthorityApprovalStatus.NotApproved,
            providers.OfType<InternalProductionPrngProvider>().Single());

        RegisterAuthority(
            "internal-test-prng",
            "Internal Test PRNG",
            DrawAuthorityType.InternalTestPrng,
            DrawProviderType.InternalTestPrng,
            DrawAuthorityStatus.Testing,
            DrawAuthorityApprovalStatus.InternallyApproved,
            providers.OfType<InternalTestPrngProvider>().Single());

        RegisterAuthority(
            "external-rng-placeholder",
            "External RNG Placeholder",
            DrawAuthorityType.ExternalRngProvider,
            DrawProviderType.ExternalRngProvider,
            DrawAuthorityStatus.Draft,
            DrawAuthorityApprovalStatus.NotApproved,
            providers.OfType<ExternalRngProviderPlaceholder>().Single());
    }

    private void RegisterAuthority(
        string code,
        string displayName,
        DrawAuthorityType authorityType,
        DrawProviderType providerType,
        DrawAuthorityStatus status,
        DrawAuthorityApprovalStatus approvalStatus,
        IDrawProvider provider)
    {
        var authorityId = StableGuid(code);
        var versionId = StableGuid($"{code}:0.0.0-placeholder");
        var metadata = provider.GetProviderMetadata();
        var health = provider.GetHealth();
        var authority = new DrawAuthorityDefinition(
            authorityId,
            code,
            displayName,
            authorityType,
            providerType,
            status,
            approvalStatus,
            provider.GetCapabilities(),
            versionId,
            DateTimeOffset.UnixEpoch);
        var version = new DrawAuthorityVersionDefinition(
            versionId,
            authorityId,
            "0.0.0-placeholder",
            new DrawAuthorityVersionMetadata(
                "0.0.0-placeholder",
                metadata.ProviderVersion,
                "draw-authority-config-0",
                approvalStatus == DrawAuthorityApprovalStatus.NotApproved ? "" : "placeholder-approval-reference",
                "placeholder-evidence-hash",
                DateTimeOffset.UnixEpoch),
            new Dictionary<string, object?>(),
            ValidationResult.Success(),
            DateTimeOffset.UnixEpoch);
        var configurationValidation = provider.ValidateAuthorityConfiguration(new DrawAuthorityConfigurationValidationRequest(authority, version));
        var productionReady = approvalGate.ValidateProductionUse(new DrawAuthorityAssignmentValidationRequest(
            authority,
            version,
            metadata,
            health,
            [DrawAuthorityCapability.CanCertifyOfficialResult],
            ProductionBinding: true,
            ExternallyCertifiedSufficient: true)).IsValid;
        var entry = new DrawAuthorityRegistryEntry(
            authority,
            version,
            metadata,
            health,
            productionReady,
            configurationValidation,
            DateTimeOffset.UtcNow);

        if (configurationValidation.IsValid)
        {
            registeredAuthorities.Add(entry);
        }
        else
        {
            invalidAuthorities.Add(entry);
        }
    }

    private void SeedResultSubmissions()
    {
        var manual = registeredAuthorities.Single(entry => entry.Authority.Code == "manual-certified-entry");
        var drawScheduleId = StableGuid("manual-certified-entry:sample-draw");
        submissions.Add(new DrawResultSubmissionDefinition(
            StableGuid("manual-certified-entry:sample-draw:submission-1"),
            drawScheduleId,
            manual.Authority.Id,
            manual.Version.Id,
            "manual-result-hash-1",
            new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3 } },
            new DrawResultEvidence(
                "manual-placeholder",
                "manual-evidence-hash-1",
                "operator-placeholder",
                DateTimeOffset.UnixEpoch,
                new Dictionary<string, object?> { ["operatorCertificationRequired"] = true }),
            DrawResultSubmissionStatus.Submitted,
            DateTimeOffset.UnixEpoch));

        submissions.Add(new DrawResultSubmissionDefinition(
            StableGuid("manual-certified-entry:sample-draw:submission-2"),
            drawScheduleId,
            manual.Authority.Id,
            manual.Version.Id,
            "manual-result-hash-2",
            new Dictionary<string, object?> { ["numbers"] = new[] { 4, 5, 6 } },
            new DrawResultEvidence(
                "manual-placeholder",
                "manual-evidence-hash-2",
                "operator-placeholder",
                DateTimeOffset.UnixEpoch,
                new Dictionary<string, object?> { ["operatorCertificationRequired"] = true }),
            DrawResultSubmissionStatus.Submitted,
            DateTimeOffset.UnixEpoch));
    }

    private static Guid StableGuid(string value)
    {
        var bytes = System.Security.Cryptography.MD5.HashData(System.Text.Encoding.UTF8.GetBytes(value));
        return new Guid(bytes);
    }
}
