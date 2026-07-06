namespace GameEngine.Domain.Model;

public enum MathGovernanceLifecycleState
{
    Draft,
    InternalReview,
    SimulationCertified,
    CertificationPending,
    Certified,
    GovernanceApproved,
    ProductionActive,
    Suspended,
    Retired,
    Superseded
}

public enum MathCertificationBindingState
{
    None,
    InternalVerified,
    LabSubmitted,
    Certified
}

public sealed record PrizeMatrixRow(
    string RowId,
    string WagerSchema,
    string PrizeCode,
    decimal Multiplier,
    decimal PayoutValue,
    decimal? MaxPayout,
    IReadOnlyDictionary<string, object?> Conditions);

public sealed record MathModelDefinitionV1(
    Guid Id,
    string MathModelId,
    string Version,
    IReadOnlyCollection<string> GameFamilyCompatibility,
    IReadOnlyCollection<string> SupportedWagerSchemas,
    decimal ExpectedRtp,
    decimal ExpectedValue,
    string VolatilityProfile,
    decimal HitFrequency,
    IReadOnlyDictionary<string, object?> PrizeLiabilityProfile,
    IReadOnlyDictionary<string, object?> JackpotContributionModel,
    IReadOnlyDictionary<string, object?> RoundingPolicy,
    IReadOnlyDictionary<string, object?> CurrencyMinorUnitPolicy,
    IReadOnlyCollection<string>? JurisdictionProfileReferences,
    IReadOnlyDictionary<string, object?>? RtpPolicyConstraints,
    MathGovernanceLifecycleState LifecycleState,
    string ContentHash,
    MathCertificationBindingState CertificationBindingState,
    SignatureMetadata? SignatureMetadata);

public sealed record PaytableDefinitionV1(
    Guid Id,
    string PaytableId,
    string Version,
    string MathModelId,
    string MathModelVersion,
    IReadOnlyCollection<PrizeMatrixRow> PrizeMatrixRows,
    IReadOnlyCollection<PrizeMatrixRow> BonusSideBetRows,
    IReadOnlyDictionary<string, object?> Caps,
    IReadOnlyCollection<string>? JurisdictionProfileReferences,
    MathGovernanceLifecycleState LifecycleState,
    string ContentHash,
    MathCertificationBindingState CertificationBindingState,
    SignatureMetadata? SignatureMetadata);
