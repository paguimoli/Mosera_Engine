using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class OutcomeAuthorityActivationGuardrailService
{
    public OutcomeAuthorityActivationGuardrailResult Evaluate(OutcomeAuthorityActivationRequest request)
    {
        var blockers = new List<string>();
        var warnings = new List<string>();

        AddMissingMarkers(request.ReadinessMarkers, blockers);

        if (!request.ProductionOutcomeAuthorityEnabled)
        {
            blockers.Add("Production Outcome Authority is disabled by configuration.");
        }

        if (!request.ProductionRngProviderEligible)
        {
            blockers.Add("Production RNG provider must be production eligible.");
        }

        if (!request.SigningProviderProductionEligible)
        {
            blockers.Add("Signing provider must be production eligible.");
        }

        if (!request.CertificationPackReady)
        {
            blockers.Add("Certification pack must be certification-ready.");
        }

        if (request.UsesSimulationOrTestProvider)
        {
            blockers.Add("Simulation and test providers cannot be production authority.");
        }

        if (request.ManifestRequiresCertification && request.CertificationOmitted)
        {
            blockers.Add("Certification is required by the manifest and cannot be omitted.");
        }

        if (request.HasFailedOrInconclusiveStatisticalValidation)
        {
            blockers.Add("Failed or inconclusive statistical validation blocks activation.");
        }

        if (request.HasActiveEmergencyDisable)
        {
            blockers.Add("Active emergency disable control blocks activation.");
        }

        if (request.JurisdictionOmitted)
        {
            warnings.Add("Jurisdiction is omitted and treated as an optional policy overlay.");
        }

        if (!request.ManifestRequiresCertification && request.CertificationOmitted)
        {
            warnings.Add("Certification is omitted because the manifest does not require it.");
        }

        return new OutcomeAuthorityActivationGuardrailResult(blockers.Count == 0, blockers, warnings);
    }

    private static void AddMissingMarkers(OutcomeAuthorityReadinessMarkers markers, ICollection<string> blockers)
    {
        if (!markers.GameManifestSchemaReady)
        {
            blockers.Add("Game manifest schema marker is missing.");
        }

        if (!markers.AuthorityCertificateChainReady)
        {
            blockers.Add("Authority certificate chain marker is missing.");
        }

        if (!markers.OutcomeDslReady)
        {
            blockers.Add("Outcome DSL marker is missing.");
        }

        if (!markers.MathRtpGovernanceReady)
        {
            blockers.Add("Math/RTP governance marker is missing.");
        }

        if (!markers.RngProviderGovernanceReady)
        {
            blockers.Add("RNG provider governance marker is missing.");
        }

        if (!markers.OutcomeDryRunPipelineReady)
        {
            blockers.Add("Outcome dry-run pipeline marker is missing.");
        }

        if (!markers.MathEvaluationDryRunReady)
        {
            blockers.Add("Math evaluation dry-run marker is missing.");
        }

        if (!markers.CertificationPackReady)
        {
            blockers.Add("Certification pack marker is missing.");
        }

        if (!markers.CertificateSigningFrameworkReady)
        {
            blockers.Add("Certificate signing framework marker is missing.");
        }

        if (!markers.StatisticalValidationReady)
        {
            blockers.Add("Statistical validation marker is missing.");
        }

        if (!markers.OperationalControlsReady)
        {
            blockers.Add("Operational controls marker is missing.");
        }
    }
}
