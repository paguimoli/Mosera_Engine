using GameEngine.Domain.DrawAuthorities;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class DrawAuthorityApprovalGate : IDrawAuthorityApprovalGate
{
    public ValidationResult ValidateProductionUse(DrawAuthorityAssignmentValidationRequest request)
    {
        var errors = new List<ValidationError>();
        var warnings = new List<ValidationWarning>();
        var authority = request.Authority;

        if (authority.Status == DrawAuthorityStatus.Retired)
        {
            errors.Add(Error("status", "Retired draw authorities cannot be assigned."));
        }

        if (request.ProductionBinding)
        {
            var productionStatusAllowed = authority.Status == DrawAuthorityStatus.Production
                || (authority.Status == DrawAuthorityStatus.ExternallyCertified && request.ExternallyCertifiedSufficient);
            if (!productionStatusAllowed)
            {
                errors.Add(Error("status", "Production binding requires Production status or sufficient external certification."));
            }

            if (authority.AuthorityType == DrawAuthorityType.InternalTestPrng)
            {
                errors.Add(Error("authorityType", "Internal Test PRNG authorities can never be assigned to production."));
            }

            if (authority.AuthorityType == DrawAuthorityType.InternalProductionPrng
                && authority.ApprovalStatus != DrawAuthorityApprovalStatus.ProductionApproved)
            {
                errors.Add(Error("approvalStatus", "Internal Production PRNG requires production approval metadata."));
            }

            if (authority.ApprovalStatus == DrawAuthorityApprovalStatus.NotApproved)
            {
                errors.Add(Error("approvalStatus", "Draw Authority approval metadata is required for production use."));
            }
        }
        else if (authority.AuthorityType != DrawAuthorityType.InternalTestPrng)
        {
            warnings.Add(new ValidationWarning(ValidationCode.None, "assignment", "Non-production assignment is prospective only."));
        }

        if (request.ProviderHealth.Status is DrawAuthorityHealthStatus.Unknown or DrawAuthorityHealthStatus.Unhealthy)
        {
            errors.Add(Error("providerHealth", "Provider health must be valid for assignment."));
        }

        if (string.IsNullOrWhiteSpace(request.Version.Metadata.Version)
            || string.IsNullOrWhiteSpace(request.Version.Metadata.ProviderVersion))
        {
            errors.Add(Error("versionMetadata", "Version metadata is required."));
        }

        foreach (var capability in request.RequiredCapabilities)
        {
            if (!authority.Capabilities.Contains(capability))
            {
                errors.Add(Error("capabilities", $"Required capability {capability} is missing."));
            }
        }

        return errors.Count == 0 ? ValidationResult.Success(warnings) : new ValidationResult(false, errors, warnings);
    }

    private static ValidationError Error(string field, string message)
    {
        return new ValidationError(ValidationCode.InvalidConfiguration, field, message, ValidationSeverity.Error);
    }
}

public sealed class DrawAuthorityAssignmentValidator(IDrawAuthorityApprovalGate approvalGate) : IDrawAuthorityAssignmentValidator
{
    public DrawAuthorityAssignmentDefinition ValidateAssignment(DrawAuthorityAssignmentValidationRequest request, Guid gameBindingId)
    {
        var validation = approvalGate.ValidateProductionUse(request);
        return new DrawAuthorityAssignmentDefinition(
            Guid.NewGuid(),
            request.Authority.Id,
            request.Version.Id,
            gameBindingId,
            request.ProductionBinding,
            validation.IsValid
                ? request.ProductionBinding ? DrawAuthorityAssignmentStatus.Validated : DrawAuthorityAssignmentStatus.TestingOnly
                : DrawAuthorityAssignmentStatus.Rejected,
            validation,
            DateTimeOffset.UtcNow,
            null);
    }
}

public sealed class DrawCertificationService(
    IReadOnlyCollection<DrawAuthorityRegistryEntry> authorities,
    IReadOnlyCollection<DrawResultSubmissionDefinition> submissions) : IDrawCertificationService
{
    private readonly List<OfficialCertifiedDrawResultDefinition> officialResults = [];

    public IReadOnlyCollection<OfficialCertifiedDrawResultDefinition> GetOfficialResults() => officialResults.ToArray();

    public OfficialCertifiedDrawResultDefinition CertifyResult(DrawCertificationDecision decision)
    {
        if (officialResults.Any(result => result.DrawScheduleId == decision.DrawScheduleId && result.Status == DrawCertificationStatus.Approved))
        {
            throw new InvalidOperationException("An Official Certified Result already exists for this draw.");
        }

        var authority = authorities.FirstOrDefault(entry => entry.Authority.Id == decision.DrawAuthorityId)
            ?? throw new InvalidOperationException("Draw Authority is not registered.");
        var submission = submissions.FirstOrDefault(entry => entry.Id == decision.DrawResultSubmissionId)
            ?? throw new InvalidOperationException("Draw result submission is not registered.");

        if (!authority.Authority.Capabilities.Contains(DrawAuthorityCapability.CanCertifyOfficialResult))
        {
            throw new InvalidOperationException("Draw Authority cannot certify official results.");
        }

        if (authority.Authority.Capabilities.Contains(DrawAuthorityCapability.RequiresOperatorCertification)
            && !decision.OperatorCertificationMetadataPresent)
        {
            throw new InvalidOperationException("Manual certified result requires operator certification metadata.");
        }

        var official = new OfficialCertifiedDrawResultDefinition(
            Guid.NewGuid(),
            decision.DrawScheduleId,
            submission.Id,
            authority.Authority.Id,
            submission.ResultHash,
            DrawCertificationStatus.Approved,
            submission.Evidence,
            decision.DecidedAt);
        officialResults.Add(official);
        return official;
    }
}
