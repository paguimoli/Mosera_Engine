namespace GameEngine.Domain.Model;

public enum OutcomeProviderType
{
    CertifiedCsprng,
    ProvablyFair,
    ExternalOfficialResult,
    PhysicalDrawResult,
    SimulationTest
}

public enum OutcomeProviderLifecycleState
{
    Draft,
    Active,
    Suspended,
    Retired,
    Superseded
}

public enum OutcomeProviderFailureMode
{
    FailClosed,
    Disabled
}

public enum OutcomeProviderIdempotencyModel
{
    PerDraw,
    PerWager,
    PerExternalResult,
    PerPhysicalDraw,
    DeterministicSimulation
}

public enum OutcomeProviderCustodyState
{
    Requested,
    Generated,
    Ingested,
    Sealed,
    Certified,
    Superseded,
    Voided,
    Disputed,
    Replayed
}

public sealed record OutcomeProviderCapabilityMarkers(
    bool GeneratesOutcomes,
    bool IngestsExternalOutcomes,
    bool SupportsPlayerVerificationReceipt,
    bool SupportsDeterministicReplay,
    bool SupportsProviderHealthEvidence,
    bool SupportsDisputeHandling,
    bool SupportsExternalSourceEvidence,
    bool SupportsPhysicalDrawEvidence);

public sealed record OutcomeProviderDefinitionV1(
    Guid Id,
    string ProviderId,
    string ProviderVersion,
    OutcomeProviderType ProviderType,
    OutcomeProviderLifecycleState LifecycleState,
    bool ProductionEligible,
    IReadOnlyCollection<OutcomePrimitiveType> SupportedOutcomePrimitiveTypes,
    IReadOnlyDictionary<string, object?> EvidenceRequirements,
    IReadOnlyCollection<string> HealthReadinessCapabilities,
    OutcomeProviderIdempotencyModel IdempotencyModel,
    IReadOnlyCollection<OutcomeProviderCustodyState> CustodySupport,
    IReadOnlyDictionary<string, object?> SigningRequirements,
    bool ReplayabilitySupport,
    OutcomeProviderFailureMode FailureMode,
    OutcomeProviderCapabilityMarkers CapabilityMarkers,
    string ContentHash,
    string? CertificationBinding);

public sealed record OutcomeProviderManifestBinding(
    string ProviderId,
    string ProviderVersion,
    IReadOnlyCollection<OutcomePrimitiveType> ProviderCapabilityRequirements,
    IReadOnlyDictionary<string, object?> ProviderEvidenceRequirements,
    bool PlayerVerificationReceiptRequired,
    IReadOnlyDictionary<string, object?> ProviderEligibilityProfile,
    bool CertificationRequired);

public sealed record OutcomeProviderActivationInput(
    OutcomeProviderManifestBinding? ManifestBinding,
    OutcomeProviderDefinitionV1? Provider,
    bool ProductionMode,
    bool SilentFallbackConfigured,
    bool JurisdictionOmitted,
    bool CertificationOmitted);
