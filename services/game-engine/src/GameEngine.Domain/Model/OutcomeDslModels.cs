namespace GameEngine.Domain.Model;

public enum OutcomePrimitiveType
{
    UniqueNumberSet,
    OrderedNumberSequence,
    UniqueSymbolSet,
    OrderedSymbolSequence,
    WeightedSelection,
    ShufflePermutation,
    DrawFromUrnDeckBag,
    CompositeOutcomeGraph,
    ConstraintValidation
}

public enum OutcomeStrategyLifecycleState
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

public sealed record WeightedOutcomeOption(
    string Symbol,
    decimal Weight);

public sealed record OutcomeDslPrimitive(
    string NodeId,
    OutcomePrimitiveType PrimitiveType,
    IReadOnlyCollection<string> DependsOn,
    int? MinNumber,
    int? MaxNumber,
    int? Count,
    IReadOnlyCollection<int> Numbers,
    IReadOnlyCollection<string> Symbols,
    IReadOnlyCollection<WeightedOutcomeOption> WeightedOptions,
    IReadOnlyDictionary<string, object?> Parameters);

public sealed record OutcomeStrategyDefinitionV1(
    Guid Id,
    string StrategyId,
    string StrategyVersion,
    IReadOnlyCollection<OutcomeDslPrimitive> PrimitiveGraph,
    IReadOnlyDictionary<string, object?> InputSchema,
    IReadOnlyDictionary<string, object?> OutputSchema,
    IReadOnlyDictionary<string, object?> Constraints,
    IReadOnlyCollection<string> JurisdictionProfileReferences,
    OutcomeStrategyLifecycleState LifecycleState,
    string ContentHash,
    string? CertificationBindingPlaceholder,
    SignatureMetadata? SignatureMetadata);
