using GameEngine.Domain.Model;

namespace GameEngine.Domain.DrawAuthorities;

public sealed record DrawAuthorityConfigurationValidationRequest(
    DrawAuthorityDefinition Authority,
    DrawAuthorityVersionDefinition Version);

public sealed record DrawResultSubmissionValidationRequest(
    DrawAuthorityDefinition Authority,
    DrawAuthorityVersionDefinition Version,
    Guid DrawScheduleId,
    IReadOnlyDictionary<string, object?> Payload,
    DrawResultEvidence Evidence);

public sealed record DrawAuthorityAssignmentValidationRequest(
    DrawAuthorityDefinition Authority,
    DrawAuthorityVersionDefinition Version,
    DrawProviderMetadata ProviderMetadata,
    DrawProviderHealth ProviderHealth,
    IReadOnlyCollection<DrawAuthorityCapability> RequiredCapabilities,
    bool ProductionBinding,
    bool ExternallyCertifiedSufficient);

public interface IDrawAuthorityRegistry
{
    IReadOnlyCollection<DrawAuthorityRegistryEntry> GetRegisteredAuthorities();

    IReadOnlyCollection<DrawAuthorityRegistryEntry> GetActiveAuthorities();

    IReadOnlyCollection<DrawAuthorityRegistryEntry> GetRetiredAuthorities();

    IReadOnlyCollection<DrawAuthorityRegistryEntry> GetProductionReadyAuthorities();

    DrawAuthorityRegistryEntry? GetAuthority(Guid id);

    IReadOnlyCollection<DrawAuthorityVersionDefinition> GetAuthorityVersions(Guid id);

    DrawAuthorityRegistryStatus GetRegistryStatus();
}

public interface IDrawProvider
{
    DrawProviderMetadata GetProviderMetadata();

    DrawProviderHealth GetHealth();

    IReadOnlyCollection<DrawAuthorityCapability> GetCapabilities();

    ValidationResult ValidateAuthorityConfiguration(DrawAuthorityConfigurationValidationRequest request);
}

public interface IDrawResultProvider
{
    ValidationResult ValidateResultSubmission(DrawResultSubmissionValidationRequest request);

    bool CanSubmitResult(DrawAuthorityDefinition authority);
}

public interface IDrawResultVerifier
{
    bool CanCertifyResult(DrawAuthorityDefinition authority);
}

public interface IDrawCertificationService
{
    OfficialCertifiedDrawResultDefinition CertifyResult(DrawCertificationDecision decision);
}

public interface IDrawAuthorityApprovalGate
{
    ValidationResult ValidateProductionUse(DrawAuthorityAssignmentValidationRequest request);
}

public interface IDrawAuthorityAssignmentValidator
{
    DrawAuthorityAssignmentDefinition ValidateAssignment(DrawAuthorityAssignmentValidationRequest request, Guid gameBindingId);
}

public interface IManualCertifiedResultProvider : IDrawProvider, IDrawResultProvider, IDrawResultVerifier
{
}

public interface IOfficialFeedProvider : IDrawProvider, IDrawResultProvider, IDrawResultVerifier
{
}

public interface IInternalPrngProvider : IDrawProvider, IDrawResultProvider, IDrawResultVerifier
{
    bool ProductionRngImplemented { get; }
}
