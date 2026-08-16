using System.Security.Cryptography;
using System.Text;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class CanonicalDrawExecutionAuthority(
    ICanonicalOutcomePipelineRepository repository,
    IGameEngineProductionActivationRepository activationRepository,
    CanonicalOutcomeProviderAuthority providerAuthority,
    InternalCsprngOutcomeProvider internalCsprngProvider,
    CanonicalOutcomeAuthority outcomeAuthority,
    GameEngineProductionActivationOptions options)
{
    public async Task<CanonicalDrawExecutionResult> ExecuteAsync(
        CanonicalDrawExecutionCommand command,
        CancellationToken cancellationToken)
    {
        Validate(command);
        if (!options.ActivationEnabled || !options.CanonicalPipelineEnabled)
        {
            throw new InvalidOperationException("Canonical production draw execution is disabled by configuration.");
        }

        var manifest = await repository.FindExecutionManifestAsync(command.DrawId, cancellationToken)
            ?? throw new InvalidOperationException("The Draw Instance has no authoritative Execution Manifest.");
        var registration = await providerAuthority.ResolveAsync(manifest, cancellationToken);
        var activation = await activationRepository.FindCurrentAsync(
            manifest.OutcomeProviderId,
            manifest.OutcomeProviderVersion,
            manifest.ProviderConfigurationVersion,
            cancellationToken);
        if (activation?.Stage != GameEngineProductionActivationStage.ProductionActive)
        {
            throw new InvalidOperationException("The manifest-bound Outcome Provider is not production active.");
        }

        var current = await outcomeAuthority.FindCurrentAsync(command.DrawId, cancellationToken);
        if (current is not null)
        {
            return await CompleteSettlementHandoffAsync(command, current, registration, cancellationToken);
        }

        var state = await repository.FindDrawExecutionStateAsync(command.DrawId, cancellationToken)
            ?? throw new InvalidOperationException("The authoritative Draw Instance was not found.");
        ValidateLifecycle(state);

        OutcomeProviderExecutionEvidence generated;
        var duplicate = false;
        switch (registration.ProviderCategory)
        {
            case CanonicalOutcomeProviderCategory.InternalCsprng:
                var result = await internalCsprngProvider.GenerateAsync(
                    manifest,
                    new InternalCsprngExecutionRequest(
                        DeterministicGuid($"canonical-draw:{manifest.ExecutionManifestId:N}"),
                        $"canonical-draw:{manifest.ExecutionManifestId:N}",
                        $"canonical-draw:{manifest.ExecutionManifestId:N}"),
                    cancellationToken);
                generated = await providerAuthority.FindGeneratedEvidenceAsync(
                    manifest.ExecutionManifestId,
                    cancellationToken) ?? throw new InvalidOperationException(
                    "Internal CSPRNG completed without durable generated evidence.");
                duplicate = result.Duplicate;
                break;
            case CanonicalOutcomeProviderCategory.OfficialResults:
            case CanonicalOutcomeProviderCategory.ManualCertified:
                generated = await providerAuthority.FindGeneratedEvidenceAsync(
                    manifest.ExecutionManifestId,
                    cancellationToken) ?? throw new InvalidOperationException(
                    "The manifest-bound ingestion provider has no submitted result. No fallback is permitted.");
                duplicate = true;
                break;
            default:
                throw new InvalidOperationException("The manifest-bound Outcome Provider category is unsupported.");
        }

        if (command.OutcomeCertificateId is null)
        {
            return new CanonicalDrawExecutionResult(
                CanonicalDrawExecutionStatus.AwaitingCertification,
                command.DrawId,
                manifest.ExecutionManifestId,
                registration.ProviderCategory,
                generated.ExecutionId,
                generated.ResultHash,
                generated.EvidenceHash,
                duplicate,
                null,
                null);
        }

        var certificate = await repository.FindCertificateEvidenceAsync(
            command.OutcomeCertificateId.Value,
            generated.ResultHash,
            cancellationToken) ?? throw new InvalidOperationException(
            "The supplied Outcome Certificate is unavailable, unverified, or does not bind the generated result hash.");
        if (certificate.DrawId != command.DrawId)
        {
            throw new InvalidOperationException("The supplied Outcome Certificate belongs to another draw.");
        }
        if (!string.Equals(certificate.SigningProvider.ProviderId, activation.SigningProviderId, StringComparison.Ordinal) ||
            !string.Equals(certificate.SigningProvider.ProviderVersion, activation.SigningProviderVersion, StringComparison.Ordinal) ||
            !string.Equals(certificate.SigningProvider.KeyIdentifier, activation.SigningKeyVersion, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "The Outcome Certificate signature does not match the exact production activation signing provider and key version.");
        }

        if (registration.ProviderCategory != CanonicalOutcomeProviderCategory.InternalCsprng)
        {
            throw new InvalidOperationException(
                "Ingestion provider certification must resume through its governed provider authority.");
        }

        await internalCsprngProvider.BindOutcomeCertificateAsync(
            manifest,
            command.OutcomeCertificateId.Value,
            generated.ResultHash,
            cancellationToken);
        var published = await outcomeAuthority.PublishAsync(
            new CanonicalOutcomePublicationCommand(
                $"canonical-draw-publication:{manifest.ExecutionManifestId:N}",
                command.DrawId,
                command.ProductReference,
                manifest.EngineName,
                manifest.EngineVersion,
                command.OutcomeCertificateId.Value,
                generated.ResultHash,
                CanonicalOutcomeVersionKind.Published,
                null,
                $"OutcomeProvider:{registration.ProviderCategory}",
                command.CorrelationId,
                command.CausationId,
                command.AuditReference,
                command.ActorReference,
                command.ReasonCode,
                generated.EvidenceHash),
            cancellationToken);
        return await CompleteSettlementHandoffAsync(
            command, published, registration, cancellationToken, generated, duplicate);
    }

    private async Task<CanonicalDrawExecutionResult> CompleteSettlementHandoffAsync(
        CanonicalDrawExecutionCommand command,
        CanonicalOutcomeVersion outcome,
        CanonicalOutcomeProviderRegistration registration,
        CancellationToken cancellationToken,
        OutcomeProviderExecutionEvidence? generated = null,
        bool duplicate = true)
    {
        OutcomeSettlementRequest? settlement = null;
        if (command.SettlementInputId is not null)
        {
            settlement = await outcomeAuthority.EmitSettlementRequestAsync(
                new OutcomeSettlementRequestCommand(
                    $"canonical-draw-settlement:{outcome.OutcomeVersionId:N}",
                    outcome.OutcomeVersionId,
                    command.SettlementInputId,
                    command.CorrelationId,
                    command.CausationId,
                    command.AuditReference),
                cancellationToken);
        }

        return new CanonicalDrawExecutionResult(
            settlement is null ? CanonicalDrawExecutionStatus.Published : CanonicalDrawExecutionStatus.SettlementRequested,
            command.DrawId,
            outcome.ExecutionManifestId,
            registration.ProviderCategory,
            generated?.ExecutionId ?? outcome.ProviderExecutionId,
            generated?.ResultHash ?? outcome.OutcomeCertificateHash,
            generated?.EvidenceHash ?? outcome.ProviderEvidenceHash,
            duplicate,
            outcome,
            settlement);
    }

    private static void ValidateLifecycle(CanonicalDrawExecutionState state)
    {
        if (state.LifecycleStatus is "Cancelled" or "Failed" or "Voided" or "ManualReviewRequired")
        {
            throw new InvalidOperationException($"Draw lifecycle state {state.LifecycleStatus} forbids ordinary outcome generation.");
        }
        if (state.LifecycleStatus is not ("SalesClosed" or "AwaitingResult" or "ResultSubmitted" or "Certified"))
        {
            throw new InvalidOperationException("The draw is not eligible for authoritative outcome generation.");
        }
        if (DateTimeOffset.UtcNow < state.SalesCloseAt || DateTimeOffset.UtcNow < state.ScheduledExecutionAt)
        {
            throw new InvalidOperationException("The authoritative draw-close and scheduled-execution fence has not passed.");
        }
    }

    private static void Validate(CanonicalDrawExecutionCommand command)
    {
        if (command.DrawId == Guid.Empty) throw new ArgumentException("Draw id is required.");
        foreach (var (value, name) in new[]
        {
            (command.ProductReference, "Product reference"),
            (command.IdempotencyKey, "Idempotency key"),
            (command.CorrelationId, "Correlation id"),
            (command.CausationId, "Causation id"),
            (command.AuditReference, "Audit reference"),
            (command.ActorReference, "Actor reference"),
            (command.ReasonCode, "Reason code")
        })
        {
            if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException($"{name} is required.");
        }
    }

    private static Guid DeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes.AsSpan(0, 16));
    }
}
