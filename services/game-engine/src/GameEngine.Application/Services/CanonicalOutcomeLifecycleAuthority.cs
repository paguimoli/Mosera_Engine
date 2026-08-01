using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class CanonicalOutcomeLifecycleAuthority(
    ICanonicalOutcomePipelineRepository repository,
    CanonicalOutcomeAuthority outcomeAuthority)
{
    public Task<CanonicalOutcomeVersion> CorrectAsync(
        CanonicalOutcomePublicationCommand command,
        CancellationToken cancellationToken)
    {
        if (command.VersionKind != CanonicalOutcomeVersionKind.Corrected)
        {
            throw new ArgumentException("Correction Authority requires a Corrected lifecycle command.");
        }

        return outcomeAuthority.AppendLifecycleVersionAsync(command, cancellationToken);
    }

    public Task<CanonicalOutcomeVersion> CancelAsync(
        CanonicalOutcomePublicationCommand command,
        CancellationToken cancellationToken)
    {
        if (command.VersionKind != CanonicalOutcomeVersionKind.Cancelled)
        {
            throw new ArgumentException("Cancellation Authority requires a Cancelled lifecycle command.");
        }

        return outcomeAuthority.AppendLifecycleVersionAsync(command, cancellationToken);
    }

    public Task<OutcomeSettlementRequest> EmitSettlementImpactAsync(
        OutcomeSettlementRequestCommand command,
        CancellationToken cancellationToken) =>
        outcomeAuthority.EmitSettlementRequestAsync(command, cancellationToken);

    public Task<CanonicalOutcomeRecoveryResult> RecoverAsync(
        CanonicalOutcomeRecoveryCommand command,
        CancellationToken cancellationToken)
    {
        if (command.Limit is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(command), "Recovery limit must be between 1 and 100.");
        }

        Require(command.ActorReference, "Recovery actor");
        Require(command.ReasonCode, "Recovery reason");
        Require(command.CorrelationId, "Recovery correlation id");
        Require(command.CausationId, "Recovery causation id");
        return repository.RecoverAsync(command, cancellationToken);
    }

    public async Task<CanonicalOutcomeLifecycleEvent> ReplayAsync(
        CanonicalOutcomeReplayCommand command,
        CancellationToken cancellationToken)
    {
        if (command.OutcomeVersionId == Guid.Empty)
        {
            throw new ArgumentException("Outcome version id is required.");
        }

        Require(command.IdempotencyKey, "Replay idempotency key");
        Require(command.ActorReference, "Replay actor");
        Require(command.ReasonCode, "Replay reason");
        Require(command.CorrelationId, "Replay correlation id");
        Require(command.CausationId, "Replay causation id");

        var replay = await repository.LoadReplayEvidenceAsync(
            command.OutcomeVersionId,
            cancellationToken)
            ?? throw new InvalidOperationException("Canonical outcome replay evidence was not found.");
        var requestHash = Hash(JsonSerializer.Serialize(new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["actorReference"] = command.ActorReference,
            ["causationId"] = command.CausationId,
            ["correlationId"] = command.CorrelationId,
            ["outcomeVersionId"] = command.OutcomeVersionId,
            ["reasonCode"] = command.ReasonCode
        }));

        try
        {
            var verified = await outcomeAuthority.VerifyPersistedEvidenceAsync(replay, cancellationToken);
            return await repository.AppendLifecycleEventAsync(
                CreateReplayEvent(command, verified, replay, requestHash,
                    CanonicalOutcomeLifecycleOperation.ReplayVerified),
                cancellationToken);
        }
        catch
        {
            await repository.AppendLifecycleEventAsync(
                CreateReplayEvent(command, replay.Outcome, replay, requestHash,
                    CanonicalOutcomeLifecycleOperation.ReplayRejected),
                cancellationToken);
            throw;
        }
    }

    private static CanonicalOutcomeLifecycleEvent CreateReplayEvent(
        CanonicalOutcomeReplayCommand command,
        CanonicalOutcomeVersion outcome,
        CanonicalOutcomeReplayEvidence replay,
        string requestHash,
        CanonicalOutcomeLifecycleOperation operation)
    {
        var evidenceHash = Hash(string.Join("|",
            operation,
            outcome.OutcomeVersionId.ToString("N"),
            outcome.CanonicalOutcomeHash,
            outcome.ProviderEvidenceHash,
            outcome.CertificateVerificationHash,
            replay.SettlementInputHash ?? "none",
            requestHash));
        return new CanonicalOutcomeLifecycleEvent(
            Guid.NewGuid(),
            operation,
            outcome.OutcomeVersionId,
            outcome.DrawId,
            outcome.OutcomeCertificateId,
            outcome.ProviderEvidenceId,
            outcome.PreviousOutcomeVersionId,
            operation == CanonicalOutcomeLifecycleOperation.ReplayRejected
                ? null
                : replay.SettlementRequestId,
            operation == CanonicalOutcomeLifecycleOperation.ReplayRejected
                ? null
                : replay.SettlementInputId,
            command.ActorReference,
            command.ReasonCode,
            command.CorrelationId,
            command.CausationId,
            requestHash,
            evidenceHash,
            command.IdempotencyKey,
            DateTimeOffset.UtcNow);
    }

    private static string Hash(string value) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";

    private static void Require(string? value, string name)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"{name} is required.");
        }
    }
}
