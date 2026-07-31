using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public interface ICanonicalOutcomeProviderRepository
{
    Task<CanonicalOutcomeProviderRegistration?> ResolveRegistrationAsync(
        DrawExecutionManifest manifest,
        CancellationToken cancellationToken);

    Task<OutcomeProviderClaimResult> ClaimExecutionAsync(
        OutcomeProviderExecutionClaim claim,
        CancellationToken cancellationToken);

    Task AppendAttemptAsync(
        OutcomeProviderExecutionAttempt attempt,
        CancellationToken cancellationToken);

    Task AppendEvidenceAsync(
        OutcomeProviderExecutionEvidence evidence,
        CancellationToken cancellationToken);

    Task CompleteExecutionAsync(
        OutcomeProviderExecutionAttempt attempt,
        OutcomeProviderExecutionEvidence evidence,
        CancellationToken cancellationToken);

    Task<OutcomeProviderExecutionEvidence?> FindGeneratedEvidenceAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken);

    Task<OutcomeProviderExecutionEvidence?> FindAuthoritativeEvidenceAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken);

    Task<IReadOnlyCollection<OutcomeProviderExecutionClaim>> FindIncompleteExecutionsAsync(
        int limit,
        CancellationToken cancellationToken);

    Task<CanonicalOutcomeProviderReadiness> CheckReadinessAsync(
        CancellationToken cancellationToken);
}

public sealed class CanonicalOutcomeProviderAuthority(ICanonicalOutcomeProviderRepository repository)
{
    public async Task<CanonicalOutcomeProviderRegistration> ResolveAsync(
        DrawExecutionManifest manifest,
        CancellationToken cancellationToken)
    {
        var registration = await repository.ResolveRegistrationAsync(manifest, cancellationToken)
            ?? throw new InvalidOperationException(
                "Execution Manifest references an unknown Outcome Provider version or configuration version.");

        if (!string.Equals(registration.ProviderId, manifest.OutcomeProviderId, StringComparison.Ordinal) ||
            !string.Equals(registration.ProviderVersion, manifest.OutcomeProviderVersion, StringComparison.Ordinal) ||
            !string.Equals(
                registration.ConfigurationVersion,
                manifest.ProviderConfigurationVersion,
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Outcome Provider resolution did not match the exact immutable Execution Manifest binding.");
        }

        if (registration.ActivationState != OutcomeProviderActivationState.Enabled)
        {
            throw new InvalidOperationException("The manifest-bound Outcome Provider is disabled.");
        }

        if (!registration.ProductionEligible || !registration.ProductionReady)
        {
            throw new InvalidOperationException("The manifest-bound Outcome Provider is not production-ready.");
        }

        if (!registration.FailClosed)
        {
            throw new InvalidOperationException("The manifest-bound Outcome Provider does not fail closed.");
        }

        return registration;
    }

    public async Task<OutcomeProviderClaimResult> ClaimExecutionAsync(
        DrawExecutionManifest manifest,
        string idempotencyKey,
        string canonicalRequestHash,
        CancellationToken cancellationToken)
    {
        Require(idempotencyKey, "Provider execution idempotency key");
        RequireHash(canonicalRequestHash, "Provider execution request hash");
        var registration = await ResolveAsync(manifest, cancellationToken);
        var claim = new OutcomeProviderExecutionClaim(
            Guid.NewGuid(),
            manifest.ExecutionManifestId,
            registration.ProviderId,
            registration.ProviderVersion,
            registration.ConfigurationVersion,
            idempotencyKey,
            canonicalRequestHash,
            DateTimeOffset.UtcNow);
        return await repository.ClaimExecutionAsync(claim, cancellationToken);
    }

    public async Task AppendAttemptAsync(
        OutcomeProviderExecutionAttempt attempt,
        CancellationToken cancellationToken)
    {
        if (attempt.AttemptNumber < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(attempt), "Execution attempt number must be positive.");
        }

        RequireHash(attempt.RequestHash, "Provider execution request hash");
        RequireHash(attempt.AttemptHash, "Provider execution attempt hash");
        await repository.AppendAttemptAsync(attempt, cancellationToken);
    }

    public async Task AppendAuthoritativeEvidenceAsync(
        OutcomeProviderExecutionEvidence evidence,
        CancellationToken cancellationToken)
    {
        RequireHash(evidence.RequestHash, "Provider request hash");
        RequireHash(evidence.ResultHash, "Provider result hash");
        RequireHash(evidence.EvidenceHash, "Provider evidence hash");
        if (evidence.Stage != OutcomeProviderEvidenceStage.Authoritative ||
            evidence.OutcomeCertificateId is null)
        {
            throw new ArgumentException(
                "Authoritative provider evidence requires an Outcome Certificate.");
        }

        RequireHash(evidence.OutcomeCertificateHash, "Outcome Certificate hash");
        await repository.AppendEvidenceAsync(evidence, cancellationToken);
    }

    public async Task AppendGeneratedEvidenceAsync(
        OutcomeProviderExecutionEvidence evidence,
        CancellationToken cancellationToken)
    {
        RequireHash(evidence.RequestHash, "Provider request hash");
        RequireHash(evidence.ResultHash, "Provider result hash");
        RequireHash(evidence.EvidenceHash, "Provider evidence hash");
        if (evidence.Stage != OutcomeProviderEvidenceStage.Generated ||
            evidence.OutcomeCertificateId is not null ||
            evidence.OutcomeCertificateHash is not null)
        {
            throw new ArgumentException(
                "Generated provider evidence cannot contain an Outcome Certificate.");
        }

        if (string.IsNullOrWhiteSpace(evidence.ProviderEvidenceJson))
        {
            throw new ArgumentException("Provider evidence payload is required.");
        }

        await repository.AppendEvidenceAsync(evidence, cancellationToken);
    }

    public async Task CompleteGeneratedExecutionAsync(
        OutcomeProviderExecutionAttempt attempt,
        OutcomeProviderExecutionEvidence evidence,
        CancellationToken cancellationToken)
    {
        if (attempt.Status != OutcomeProviderExecutionStatus.Completed ||
            attempt.FailureClassification != OutcomeProviderFailureClassification.None)
        {
            throw new ArgumentException(
                "Generated provider evidence requires a successful completed attempt.");
        }

        RequireHash(attempt.RequestHash, "Provider execution request hash");
        RequireHash(attempt.AttemptHash, "Provider execution attempt hash");
        RequireHash(evidence.RequestHash, "Provider request hash");
        RequireHash(evidence.ResultHash, "Provider result hash");
        RequireHash(evidence.EvidenceHash, "Provider evidence hash");
        if (evidence.Stage != OutcomeProviderEvidenceStage.Generated ||
            evidence.ExecutionId != attempt.ExecutionId ||
            evidence.ExecutionAttempt != attempt.AttemptNumber ||
            !string.Equals(
                evidence.RequestHash,
                attempt.RequestHash,
                StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "Completed attempt and generated provider evidence do not match.");
        }

        await repository.CompleteExecutionAsync(attempt, evidence, cancellationToken);
    }

    public Task<OutcomeProviderExecutionEvidence?> FindGeneratedEvidenceAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken) =>
        repository.FindGeneratedEvidenceAsync(executionManifestId, cancellationToken);

    public async Task<OutcomeProviderExecutionEvidence> AuthorizePublicationAsync(
        DrawExecutionManifest manifest,
        CanonicalOutcomePublicationCommand command,
        CancellationToken cancellationToken)
    {
        await ResolveAsync(manifest, cancellationToken);
        var evidence = await repository.FindAuthoritativeEvidenceAsync(
            manifest.ExecutionManifestId,
            cancellationToken)
            ?? throw new InvalidOperationException(
                "Canonical Outcome publication requires persisted authoritative provider result evidence.");

        if (evidence.DrawId != manifest.DrawId ||
            !string.Equals(evidence.ProviderId, manifest.OutcomeProviderId, StringComparison.Ordinal) ||
            !string.Equals(evidence.ProviderVersion, manifest.OutcomeProviderVersion, StringComparison.Ordinal) ||
            !string.Equals(
                evidence.ConfigurationVersion,
                manifest.ProviderConfigurationVersion,
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Provider result evidence does not match the immutable Execution Manifest.");
        }

        if (evidence.OutcomeCertificateId != command.OutcomeCertificateId ||
            !string.Equals(
                evidence.OutcomeCertificateHash,
                command.OutcomeCertificateHash,
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Provider result evidence does not match the Outcome Certificate selected for publication.");
        }

        return evidence;
    }

    public Task<IReadOnlyCollection<OutcomeProviderExecutionClaim>> FindIncompleteExecutionsAsync(
        int limit,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(limit), "Recovery limit must be between 1 and 100.");
        }

        return repository.FindIncompleteExecutionsAsync(limit, cancellationToken);
    }

    public Task<CanonicalOutcomeProviderReadiness> CheckReadinessAsync(
        CancellationToken cancellationToken) =>
        repository.CheckReadinessAsync(cancellationToken);

    private static void Require(string? value, string name)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"{name} is required.");
        }
    }

    private static void RequireHash(string? value, string name)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            !value.StartsWith("sha256:", StringComparison.Ordinal))
        {
            throw new ArgumentException($"{name} must be a canonical sha256 hash.");
        }
    }
}

public sealed class DisabledCanonicalOutcomeProviderRepository : ICanonicalOutcomeProviderRepository
{
    private const string Message =
        "Canonical Outcome Provider Authority requires durable PostgreSQL persistence.";

    public Task<CanonicalOutcomeProviderRegistration?> ResolveRegistrationAsync(
        DrawExecutionManifest manifest,
        CancellationToken cancellationToken) =>
        Task.FromResult<CanonicalOutcomeProviderRegistration?>(null);

    public Task<OutcomeProviderClaimResult> ClaimExecutionAsync(
        OutcomeProviderExecutionClaim claim,
        CancellationToken cancellationToken) =>
        Task.FromException<OutcomeProviderClaimResult>(new InvalidOperationException(Message));

    public Task AppendAttemptAsync(
        OutcomeProviderExecutionAttempt attempt,
        CancellationToken cancellationToken) =>
        Task.FromException(new InvalidOperationException(Message));

    public Task AppendEvidenceAsync(
        OutcomeProviderExecutionEvidence evidence,
        CancellationToken cancellationToken) =>
        Task.FromException(new InvalidOperationException(Message));

    public Task CompleteExecutionAsync(
        OutcomeProviderExecutionAttempt attempt,
        OutcomeProviderExecutionEvidence evidence,
        CancellationToken cancellationToken) =>
        Task.FromException(new InvalidOperationException(Message));

    public Task<OutcomeProviderExecutionEvidence?> FindGeneratedEvidenceAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken) =>
        Task.FromResult<OutcomeProviderExecutionEvidence?>(null);

    public Task<OutcomeProviderExecutionEvidence?> FindAuthoritativeEvidenceAsync(
        Guid executionManifestId,
        CancellationToken cancellationToken) =>
        Task.FromResult<OutcomeProviderExecutionEvidence?>(null);

    public Task<IReadOnlyCollection<OutcomeProviderExecutionClaim>> FindIncompleteExecutionsAsync(
        int limit,
        CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyCollection<OutcomeProviderExecutionClaim>>([]);

    public Task<CanonicalOutcomeProviderReadiness> CheckReadinessAsync(
        CancellationToken cancellationToken) =>
        Task.FromResult(new CanonicalOutcomeProviderReadiness(
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            true,
            [Message]));
}
