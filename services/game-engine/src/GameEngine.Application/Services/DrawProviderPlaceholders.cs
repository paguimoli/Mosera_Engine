using GameEngine.Domain.DrawAuthorities;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public abstract class DrawProviderPlaceholderBase : IDrawProvider, IDrawResultProvider, IDrawResultVerifier
{
    public abstract DrawProviderMetadata GetProviderMetadata();

    public virtual DrawProviderHealth GetHealth()
    {
        return new DrawProviderHealth(
            DrawAuthorityHealthStatus.Healthy,
            ["Placeholder provider only; no production draw generation or external integration is implemented."],
            DateTimeOffset.UtcNow);
    }

    public abstract IReadOnlyCollection<DrawAuthorityCapability> GetCapabilities();

    public virtual ValidationResult ValidateAuthorityConfiguration(DrawAuthorityConfigurationValidationRequest request)
    {
        return ValidationResult.Success([
            new ValidationWarning(ValidationCode.None, "provider", "Provider is a Phase 22.6D placeholder.")
        ]);
    }

    public virtual ValidationResult ValidateResultSubmission(DrawResultSubmissionValidationRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Evidence.EvidenceHash))
        {
            return ValidationResult.Failure(new ValidationError(
                ValidationCode.InvalidDrawResult,
                "evidence.evidenceHash",
                "Draw result evidence hash is required.",
                ValidationSeverity.Error));
        }

        return ValidationResult.Success();
    }

    public virtual bool CanSubmitResult(DrawAuthorityDefinition authority)
    {
        return GetCapabilities().Any(capability => capability is
            DrawAuthorityCapability.CanAcceptManualResults or
            DrawAuthorityCapability.CanImportExternalResults or
            DrawAuthorityCapability.CanSubmitEvidenceOnly or
            DrawAuthorityCapability.CanGenerateInternalResults);
    }

    public virtual bool CanCertifyResult(DrawAuthorityDefinition authority)
    {
        return GetCapabilities().Contains(DrawAuthorityCapability.CanCertifyOfficialResult);
    }
}

public sealed class ManualCertifiedResultProvider : DrawProviderPlaceholderBase, IManualCertifiedResultProvider
{
    public override DrawProviderMetadata GetProviderMetadata()
    {
        return new DrawProviderMetadata(
            "manual-certified-result",
            "Manual Certified Result Provider",
            DrawProviderType.ManualCertifiedEntry,
            "0.0.0-placeholder",
            ProductionRngImplemented: false,
            "manual_certification_placeholder");
    }

    public override IReadOnlyCollection<DrawAuthorityCapability> GetCapabilities()
    {
        return
        [
            DrawAuthorityCapability.CanAcceptManualResults,
            DrawAuthorityCapability.CanSubmitEvidenceOnly,
            DrawAuthorityCapability.CanCertifyOfficialResult,
            DrawAuthorityCapability.RequiresOperatorCertification
        ];
    }
}

public sealed class OfficialFeedProvider : DrawProviderPlaceholderBase, IOfficialFeedProvider
{
    public override DrawProviderMetadata GetProviderMetadata()
    {
        return new DrawProviderMetadata(
            "official-feed-placeholder",
            "Official Feed Provider Placeholder",
            DrawProviderType.OfficialFeed,
            "0.0.0-placeholder",
            ProductionRngImplemented: false,
            "external_feed_not_implemented");
    }

    public override IReadOnlyCollection<DrawAuthorityCapability> GetCapabilities()
    {
        return
        [
            DrawAuthorityCapability.CanImportExternalResults,
            DrawAuthorityCapability.CanSubmitEvidenceOnly,
            DrawAuthorityCapability.CanCertifyOfficialResult
        ];
    }
}

public sealed class ExternalRngProviderPlaceholder : DrawProviderPlaceholderBase
{
    public override DrawProviderMetadata GetProviderMetadata()
    {
        return new DrawProviderMetadata(
            "external-rng-placeholder",
            "External RNG Provider Placeholder",
            DrawProviderType.ExternalRngProvider,
            "0.0.0-placeholder",
            ProductionRngImplemented: false,
            "external_rng_not_implemented");
    }

    public override IReadOnlyCollection<DrawAuthorityCapability> GetCapabilities()
    {
        return
        [
            DrawAuthorityCapability.CanImportExternalResults,
            DrawAuthorityCapability.CanSubmitEvidenceOnly
        ];
    }
}

public sealed class InternalProductionPrngProvider : DrawProviderPlaceholderBase, IInternalPrngProvider
{
    public bool ProductionRngImplemented => false;

    public override DrawProviderMetadata GetProviderMetadata()
    {
        return new DrawProviderMetadata(
            "internal-production-prng-placeholder",
            "Internal Production PRNG Placeholder",
            DrawProviderType.InternalProductionPrng,
            "0.0.0-placeholder",
            ProductionRngImplemented,
            "production_prng_not_implemented");
    }

    public override DrawProviderHealth GetHealth()
    {
        return new DrawProviderHealth(
            DrawAuthorityHealthStatus.Warning,
            ["Production PRNG provider is not implemented and cannot be production assigned without approval evidence."],
            DateTimeOffset.UtcNow);
    }

    public override IReadOnlyCollection<DrawAuthorityCapability> GetCapabilities()
    {
        return
        [
            DrawAuthorityCapability.CanGenerateInternalResults,
            DrawAuthorityCapability.CanSubmitEvidenceOnly
        ];
    }
}

public sealed class InternalTestPrngProvider : DrawProviderPlaceholderBase, IInternalPrngProvider
{
    public bool ProductionRngImplemented => false;

    public override DrawProviderMetadata GetProviderMetadata()
    {
        return new DrawProviderMetadata(
            "internal-test-prng-placeholder",
            "Internal Test PRNG Placeholder",
            DrawProviderType.InternalTestPrng,
            "0.0.0-placeholder",
            ProductionRngImplemented,
            "deterministic_test_only_placeholder");
    }

    public override IReadOnlyCollection<DrawAuthorityCapability> GetCapabilities()
    {
        return
        [
            DrawAuthorityCapability.CanGenerateInternalResults,
            DrawAuthorityCapability.CanSubmitEvidenceOnly
        ];
    }
}
