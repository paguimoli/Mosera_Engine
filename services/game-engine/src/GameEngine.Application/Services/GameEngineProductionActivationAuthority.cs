using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public interface IGameEngineProductionActivationRepository
{
    Task<GameEngineProductionActivationTarget?> ResolveTargetAsync(
        string providerId,
        string providerVersion,
        string configurationVersion,
        CancellationToken cancellationToken);

    Task<GameEngineProductionActivationEvent?> FindCurrentAsync(
        string providerId,
        string providerVersion,
        string configurationVersion,
        CancellationToken cancellationToken);

    Task<GameEngineProductionActivationEvent?> FindByIdempotencyAsync(
        string idempotencyKey,
        CancellationToken cancellationToken);

    Task<GameEngineProductionActivationEvent> AppendAsync(
        GameEngineProductionActivationEvent activationEvent,
        CancellationToken cancellationToken);

    Task<SigningProviderDefinition?> FindSigningProviderAsync(
        string providerId,
        string providerVersion,
        CancellationToken cancellationToken);

    Task<bool> CheckPersistenceReadinessAsync(CancellationToken cancellationToken);
}

public interface IGameEngineProductionInfrastructureReadiness
{
    Task<GameEngineProductionInfrastructureReadiness> CheckAsync(CancellationToken cancellationToken);
}

public sealed class GameEngineProductionReadinessAuthority(
    IGameEngineProductionActivationRepository repository,
    IGameEngineProductionInfrastructureReadiness infrastructure,
    CanonicalOutcomeProviderAuthority providerAuthority,
    InternalCsprngOutcomeProvider internalCsprngProvider,
    OfficialResultsProvider officialResultsProvider,
    ManualCertifiedProvider manualCertifiedProvider,
    CanonicalOutcomeAuthority outcomeAuthority,
    CertificateVerificationService certificateVerification,
    GameEngineProductionActivationOptions options)
{
    public async Task<GameEngineProductionActivationReadiness> EvaluateAsync(
        string providerId,
        string providerVersion,
        string configurationVersion,
        CancellationToken cancellationToken)
    {
        var target = await repository.ResolveTargetAsync(
            providerId,
            providerVersion,
            configurationVersion,
            cancellationToken);
        var current = target is null
            ? null
            : await repository.FindCurrentAsync(
                providerId,
                providerVersion,
                configurationVersion,
                cancellationToken);
        var components = new List<GameEngineProductionReadinessComponent>();
        var blockers = new List<string>();

        if (target is null)
        {
            blockers.Add("The requested Outcome Provider version or configuration is not registered.");
        }
        else
        {
            Add(components, "provider registration", true, "Exact provider and configuration version registered.");
            Add(components, "provider eligibility",
                target.ProviderProductionEligible && target.ConfigurationProductionReady && target.FailClosed,
                "Provider must be production eligible, production-ready, and fail closed.");

            var registry = await providerAuthority.CheckReadinessAsync(cancellationToken);
            Add(components, "Outcome Provider Authority",
                registry.ProviderRegistryReady &&
                registry.ProviderRegistered &&
                registry.ProviderVersionResolved &&
                registry.ConfigurationVersionResolved &&
                registry.ProviderEvidencePersistenceReady,
                Join(registry.Blockers, "Canonical provider registry and evidence persistence are ready."));

            var providerReadiness = await CheckProviderAsync(target.ProviderCategory, cancellationToken);
            Add(components, "provider health and self-tests", providerReadiness.Ready, providerReadiness.Message);

            var pipeline = await outcomeAuthority.CheckReadinessAsync(cancellationToken);
            Add(components, "Draw Authority and Draw Orchestrator",
                pipeline.CanonicalDrawOrchestrationReady && pipeline.AdvisoryLockingReady,
                "Canonical draw orchestration, immutable manifests, and execution locking must be ready.");
            Add(components, "Canonical Outcome Authority",
                pipeline.DurablePersistenceReachable &&
                pipeline.ImmutableVersioningReady &&
                pipeline.IdempotencyReady &&
                pipeline.LegacyPublicationDisabled,
                Join(pipeline.Blockers, "Canonical outcome persistence, publication, and idempotency are ready."));
            Add(components, "Outcome Lifecycle Authority",
                pipeline.ReplayProtectionReady && pipeline.MissingRequestRecoveryReady,
                "Replay, correction, cancellation, and recovery evidence must be ready.");
            Add(components, "publication and Settlement handoff",
                pipeline.OutboxReady &&
                pipeline.SettlementRequestEmissionReady &&
                pipeline.OutboxDispatcherReady &&
                pipeline.WorkerRuntimeReady &&
                pipeline.RabbitMqConsumptionReady &&
                pipeline.SettlementRequestConsumptionReady &&
                pipeline.LegacyDirectSettlementPathsResolved,
                "Outbox publication and canonical Settlement consumption must be ready.");
        }

        var persistenceReady = await repository.CheckPersistenceReadinessAsync(cancellationToken);
        Add(components, "activation persistence", persistenceReady,
            "Append-only production activation persistence must be reachable.");
        var dependencyReadiness = await infrastructure.CheckAsync(cancellationToken);
        Add(components, "PostgreSQL", dependencyReadiness.PostgreSqlReady,
            Join(dependencyReadiness.Blockers, "Managed PostgreSQL is reachable."));
        Add(components, "RabbitMQ", dependencyReadiness.RabbitMqReady,
            Join(dependencyReadiness.Blockers, "RabbitMQ is reachable."));

        var signing = await CheckSigningAsync(cancellationToken);
        blockers.AddRange(components.Where(component => !component.Ready).Select(component => component.Message));
        blockers.AddRange(signing.Blockers);
        if (!options.ActivationEnabled)
        {
            blockers.Add("GAME_ENGINE_PRODUCTION_ACTIVATION_ENABLED is not true.");
        }
        if (!options.CanonicalPipelineEnabled)
        {
            blockers.Add("OUTCOME_CANONICAL_PIPELINE_ENABLED is not true.");
        }

        return new GameEngineProductionActivationReadiness(
            target,
            current?.Stage,
            options.ActivationEnabled,
            options.CanonicalPipelineEnabled,
            current?.Stage == GameEngineProductionActivationStage.ProductionActive,
            components,
            signing,
            blockers.Distinct(StringComparer.Ordinal).ToArray(),
            DateTimeOffset.UtcNow);
    }

    private async Task<(bool Ready, string Message)> CheckProviderAsync(
        CanonicalOutcomeProviderCategory category,
        CancellationToken cancellationToken)
    {
        return category switch
        {
            CanonicalOutcomeProviderCategory.InternalCsprng => ToResult(
                await internalCsprngProvider.CheckReadinessAsync(cancellationToken)),
            CanonicalOutcomeProviderCategory.OfficialResults => ToResult(
                await officialResultsProvider.CheckReadinessAsync(cancellationToken)),
            CanonicalOutcomeProviderCategory.ManualCertified => ToResult(
                await manualCertifiedProvider.CheckReadinessAsync(cancellationToken)),
            _ => (false, "Unknown canonical Outcome Provider category.")
        };
    }

    private async Task<ProductionSigningReadiness> CheckSigningAsync(CancellationToken cancellationToken)
    {
        var blockers = new List<string>();
        var provider = string.IsNullOrWhiteSpace(options.SigningProviderId) ||
                       string.IsNullOrWhiteSpace(options.SigningProviderVersion)
            ? null
            : await repository.FindSigningProviderAsync(
                options.SigningProviderId,
                options.SigningProviderVersion,
                cancellationToken);
        if (!options.SigningEnabled)
            blockers.Add("GAME_ENGINE_PRODUCTION_SIGNING_ENABLED is not true.");
        if (provider is null)
            blockers.Add("The configured production signing provider version is unavailable.");

        var verification = provider is null
            ? ["Production signing provider verification cannot be initialized."]
            : certificateVerification.CheckProductionReadiness(provider);
        blockers.AddRange(verification);
        var publicKeyAvailable = provider is not null && verification.Count == 0;
        var keyVersionTracked = provider is not null &&
            !string.IsNullOrWhiteSpace(options.SigningKeyVersion) &&
            string.Equals(provider.KeyIdentifier, options.SigningKeyVersion, StringComparison.Ordinal);
        if (!keyVersionTracked)
            blockers.Add("Configured signing key version does not match the immutable signing provider.");

        return new ProductionSigningReadiness(
            options.SigningEnabled,
            provider is not null,
            provider?.LifecycleState == SigningProviderLifecycleState.Active,
            provider?.ProductionEligible == true,
            provider?.VerificationSupport == true,
            provider?.KeyRotationSupport == true,
            provider?.FailureMode == SigningFailureMode.FailClosed,
            provider is not null && certificateVerification.SupportsProductionAlgorithm(provider),
            publicKeyAvailable,
            keyVersionTracked,
            provider,
            blockers.Distinct(StringComparer.Ordinal).ToArray());
    }

    private static (bool Ready, string Message) ToResult(InternalCsprngReadiness readiness) =>
        (readiness.ProductionReady, Join(readiness.Blockers, "Internal CSPRNG health and self-tests passed."));

    private static (bool Ready, string Message) ToResult(OfficialResultsProviderReadiness readiness) =>
        (readiness.ProductionReady, Join(readiness.Blockers, "Official Results provider health passed."));

    private static (bool Ready, string Message) ToResult(ManualCertifiedProviderReadiness readiness) =>
        (readiness.ProductionReady, Join(readiness.Blockers, "Manual Certified provider health passed."));

    private static void Add(
        ICollection<GameEngineProductionReadinessComponent> components,
        string name,
        bool ready,
        string message) => components.Add(new(name, ready, message));

    private static string Join(IReadOnlyCollection<string> blockers, string readyMessage) =>
        blockers.Count == 0 ? readyMessage : string.Join("; ", blockers);
}

public sealed class GameEngineProductionActivationAuthority(
    IGameEngineProductionActivationRepository repository,
    GameEngineProductionReadinessAuthority readinessAuthority,
    GameEngineProductionActivationOptions options)
{
    public Task<GameEngineProductionActivationReadiness> CheckReadinessAsync(
        string providerId,
        string providerVersion,
        string configurationVersion,
        CancellationToken cancellationToken) =>
        readinessAuthority.EvaluateAsync(providerId, providerVersion, configurationVersion, cancellationToken);

    public async Task<GameEngineProductionActivationEvent> AdvanceAsync(
        GameEngineProductionActivationCommand command,
        CancellationToken cancellationToken)
    {
        Validate(command);
        var requestHash = Hash(JsonSerializer.Serialize(new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["actorReference"] = command.ActorReference,
            ["approvalReference"] = command.ApprovalReference,
            ["configurationVersion"] = command.ConfigurationVersion,
            ["evidenceHash"] = command.EvidenceHash,
            ["providerId"] = command.ProviderId,
            ["providerVersion"] = command.ProviderVersion,
            ["reasonCode"] = command.ReasonCode,
            ["requestedStage"] = command.RequestedStage.ToString()
        }));
        var duplicate = await repository.FindByIdempotencyAsync(command.IdempotencyKey, cancellationToken);
        if (duplicate is not null)
        {
            if (!string.Equals(duplicate.CanonicalRequestHash, requestHash, StringComparison.Ordinal))
                throw new InvalidOperationException("Conflicting production activation idempotency payload.");
            return duplicate;
        }

        var readiness = await readinessAuthority.EvaluateAsync(
            command.ProviderId,
            command.ProviderVersion,
            command.ConfigurationVersion,
            cancellationToken);
        if (readiness.Target is null || readiness.CurrentStage is null)
            throw new InvalidOperationException("Production activation target is not registered.");

        var expected = readiness.CurrentStage switch
        {
            GameEngineProductionActivationStage.Registered => GameEngineProductionActivationStage.Ready,
            GameEngineProductionActivationStage.Ready => GameEngineProductionActivationStage.Approved,
            GameEngineProductionActivationStage.Approved => GameEngineProductionActivationStage.ProductionActive,
            GameEngineProductionActivationStage.ProductionActive =>
                throw new InvalidOperationException("Provider is already production active."),
            _ => throw new InvalidOperationException("Unsupported production activation state.")
        };
        if (command.RequestedStage != expected)
            throw new InvalidOperationException($"Production activation cannot skip {expected}.");
        if (!readiness.TechnicalReadinessPassed)
            throw new InvalidOperationException($"Production readiness failed: {string.Join("; ", readiness.Blockers)}");
        if (command.RequestedStage == GameEngineProductionActivationStage.ProductionActive &&
            !readiness.ActivationAllowed)
            throw new InvalidOperationException($"Production activation is blocked: {string.Join("; ", readiness.Blockers)}");

        var activationEvent = new GameEngineProductionActivationEvent(
            Guid.NewGuid(),
            command.ProviderId,
            command.ProviderVersion,
            command.ConfigurationVersion,
            command.RequestedStage,
            command.ActorReference,
            command.ReasonCode,
            command.ApprovalReference,
            options.SigningProviderId,
            options.SigningProviderVersion,
            options.SigningKeyVersion,
            requestHash,
            command.EvidenceHash,
            command.IdempotencyKey,
            DateTimeOffset.UtcNow);
        return await repository.AppendAsync(activationEvent, cancellationToken);
    }

    private static void Validate(GameEngineProductionActivationCommand command)
    {
        Require(command.ProviderId, "Provider id");
        Require(command.ProviderVersion, "Provider version");
        Require(command.ConfigurationVersion, "Configuration version");
        Require(command.ActorReference, "Actor reference");
        Require(command.ReasonCode, "Reason code");
        Require(command.ApprovalReference, "Approval reference");
        Require(command.IdempotencyKey, "Idempotency key");
        if (!command.EvidenceHash.StartsWith("sha256:", StringComparison.Ordinal))
            throw new ArgumentException("Activation evidence hash must be a canonical sha256 hash.");
        if (command.RequestedStage == GameEngineProductionActivationStage.Registered)
            throw new ArgumentException("Provider registration is established only by immutable configuration persistence.");
    }

    private static void Require(string? value, string name)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException($"{name} is required.");
    }

    private static string Hash(string value) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
}

public sealed class DisabledGameEngineProductionActivationRepository : IGameEngineProductionActivationRepository
{
    private const string Message = "Production activation requires durable PostgreSQL persistence.";

    public Task<GameEngineProductionActivationTarget?> ResolveTargetAsync(string providerId, string providerVersion, string configurationVersion, CancellationToken cancellationToken) => Task.FromResult<GameEngineProductionActivationTarget?>(null);
    public Task<GameEngineProductionActivationEvent?> FindCurrentAsync(string providerId, string providerVersion, string configurationVersion, CancellationToken cancellationToken) => Task.FromResult<GameEngineProductionActivationEvent?>(null);
    public Task<GameEngineProductionActivationEvent?> FindByIdempotencyAsync(string idempotencyKey, CancellationToken cancellationToken) => Task.FromResult<GameEngineProductionActivationEvent?>(null);
    public Task<GameEngineProductionActivationEvent> AppendAsync(GameEngineProductionActivationEvent activationEvent, CancellationToken cancellationToken) => Task.FromException<GameEngineProductionActivationEvent>(new InvalidOperationException(Message));
    public Task<SigningProviderDefinition?> FindSigningProviderAsync(string providerId, string providerVersion, CancellationToken cancellationToken) => Task.FromResult<SigningProviderDefinition?>(null);
    public Task<bool> CheckPersistenceReadinessAsync(CancellationToken cancellationToken) => Task.FromResult(false);
}
