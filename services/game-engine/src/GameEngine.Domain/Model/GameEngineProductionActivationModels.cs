namespace GameEngine.Domain.Model;

public enum GameEngineProductionActivationStage
{
    Registered,
    Ready,
    Approved,
    ProductionActive
}

public sealed record GameEngineProductionActivationTarget(
    string ProviderId,
    string ProviderVersion,
    string ConfigurationVersion,
    CanonicalOutcomeProviderCategory ProviderCategory,
    string ProviderContentHash,
    string ConfigurationHash,
    bool ProviderProductionEligible,
    bool ConfigurationProductionReady,
    bool FailClosed);

public sealed record GameEngineProductionActivationEvent(
    Guid ActivationEventId,
    string ProviderId,
    string ProviderVersion,
    string ConfigurationVersion,
    GameEngineProductionActivationStage Stage,
    string ActorReference,
    string ReasonCode,
    string ApprovalReference,
    string SigningProviderId,
    string SigningProviderVersion,
    string SigningKeyVersion,
    string CanonicalRequestHash,
    string EvidenceHash,
    string IdempotencyKey,
    DateTimeOffset CreatedAt);

public sealed record GameEngineProductionActivationCommand(
    string ProviderId,
    string ProviderVersion,
    string ConfigurationVersion,
    GameEngineProductionActivationStage RequestedStage,
    string ActorReference,
    string ReasonCode,
    string ApprovalReference,
    string IdempotencyKey,
    string EvidenceHash);

public sealed record GameEngineProductionReadinessComponent(
    string Name,
    bool Ready,
    string Message);

public sealed record ProductionSigningReadiness(
    bool SigningEnabled,
    bool ProviderConfigured,
    bool ProviderActive,
    bool ProviderProductionEligible,
    bool VerificationSupported,
    bool RotationSupported,
    bool FailClosed,
    bool AlgorithmSupported,
    bool PublicKeyAvailable,
    bool KeyVersionTracked,
    SigningProviderDefinition? Provider,
    IReadOnlyCollection<string> Blockers)
{
    public bool Ready => Blockers.Count == 0;
}

public sealed record GameEngineProductionActivationReadiness(
    GameEngineProductionActivationTarget? Target,
    GameEngineProductionActivationStage? CurrentStage,
    bool ActivationExplicitlyEnabled,
    bool CanonicalPipelineEnabled,
    bool ProductionActive,
    IReadOnlyCollection<GameEngineProductionReadinessComponent> Components,
    ProductionSigningReadiness Signing,
    IReadOnlyCollection<string> Blockers,
    DateTimeOffset EvaluatedAt)
{
    public bool TechnicalReadinessPassed => Components.All(component => component.Ready) && Signing.Ready;
    public bool ActivationAllowed =>
        Target is not null &&
        CurrentStage == GameEngineProductionActivationStage.Approved &&
        ActivationExplicitlyEnabled &&
        CanonicalPipelineEnabled &&
        TechnicalReadinessPassed;
}

public sealed record GameEngineProductionActivationOptions(
    bool ActivationEnabled,
    bool CanonicalPipelineEnabled,
    bool SigningEnabled,
    string SigningProviderId,
    string SigningProviderVersion,
    string SigningKeyVersion,
    string SigningPublicKeyPem);

public sealed record GameEngineProductionInfrastructureReadiness(
    bool PostgreSqlReady,
    bool RabbitMqReady,
    IReadOnlyCollection<string> Blockers);
