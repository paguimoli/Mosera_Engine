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

        if (!request.HasExactOutcomeProviderBinding)
        {
            blockers.Add("Game Manifest must bind exactly one Outcome Provider version.");
        }

        if (!request.OutcomeProviderActiveAndEligible)
        {
            blockers.Add("Manifest-bound Outcome Provider must be active and eligible.");
        }

        if (!request.OutcomeProviderCapabilitiesSatisfied)
        {
            blockers.Add("Outcome Provider capabilities must satisfy the Game Manifest requirements.");
        }

        if (request.SilentFallbackConfigured)
        {
            blockers.Add("Silent fallback Outcome Providers are not allowed.");
        }

        if (request.UsesSimulationOrTestOutcomeProvider)
        {
            blockers.Add("Simulation/test Outcome Providers cannot be production authority.");
        }

        if (!request.CertifiedCsprngProviderRequirementsSatisfied)
        {
            blockers.Add("Certified CSPRNG provider requirements must be satisfied.");
        }

        if (!request.EntropyProviderProductionEligible)
        {
            blockers.Add("Entropy provider must be production eligible.");
        }

        if (!request.DrbgHealthEvidenceSatisfied)
        {
            blockers.Add("Certified CSPRNG startup, KAT, and continuous health evidence must be present.");
        }

        if (!request.UnbiasedSamplingCapabilitiesSatisfied)
        {
            blockers.Add("Certified CSPRNG provider requires unbiased sampling capabilities.");
        }

        if (!request.NoRawSecretMaterialPersisted)
        {
            blockers.Add("Raw entropy, seed material, and DRBG state must never be persisted.");
        }

        if (!request.ProvablyFairProviderRequirementsSatisfied)
        {
            blockers.Add("Provably Fair provider requirements must be satisfied.");
        }

        if (!request.ProvablyFairCommitAlgorithmDefined)
        {
            blockers.Add("Provably Fair commit algorithm must be defined.");
        }

        if (!request.ProvablyFairVerificationAlgorithmDefined)
        {
            blockers.Add("Provably Fair verification algorithm must be defined.");
        }

        if (!request.ProvablyFairReceiptSupportAvailable)
        {
            blockers.Add("Provably Fair receipt support must be available.");
        }

        if (!request.ProvablyFairNoncePolicyValid)
        {
            blockers.Add("Provably Fair nonce policy must be valid.");
        }

        if (!request.ProvablyFairCommitmentPolicyValid)
        {
            blockers.Add("Provably Fair commitment policy must be valid.");
        }

        if (!request.ProvablyFairNoSeedLeakage)
        {
            blockers.Add("Provably Fair governance must not leak server seed material.");
        }

        if (!request.OutcomeProviderRuntimeReady)
        {
            blockers.Add("Outcome Provider runtime must be ready.");
        }

        if (!request.OutcomeRuntimeIdempotencyConfigured)
        {
            blockers.Add("Outcome runtime durable idempotency must be configured.");
        }

        if (!request.OutcomeRuntimeAdvisoryLockingConfigured)
        {
            blockers.Add("Outcome runtime advisory locking must be configured.");
        }

        if (!request.ProductionOutcomeGenerationDisabled)
        {
            blockers.Add("Production outcome generation must remain disabled until activation is explicitly approved.");
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

        if (!markers.OutcomeProviderRuntimeReady)
        {
            blockers.Add("Outcome Provider runtime marker is missing.");
        }

        if (!markers.OutcomeRuntimeIdempotencyReady)
        {
            blockers.Add("Outcome runtime idempotency marker is missing.");
        }

        if (!markers.OutcomeRuntimeAdvisoryLockingReady)
        {
            blockers.Add("Outcome runtime advisory locking marker is missing.");
        }
    }
}
