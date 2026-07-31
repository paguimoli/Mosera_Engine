using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public interface ICanonicalOutcomePipelineRepository
{
    Task<CanonicalOutcomeVersion> PublishAsync(
        CanonicalOutcomePublicationCommand command,
        string canonicalRequestHash,
        CancellationToken cancellationToken);

    Task<DrawExecutionManifest?> FindExecutionManifestAsync(
        Guid drawId,
        CancellationToken cancellationToken);

    Task<OutcomeSettlementRequest> EmitSettlementRequestAsync(
        OutcomeSettlementRequestCommand command,
        string canonicalRequestHash,
        CancellationToken cancellationToken);

    Task<CanonicalOutcomeVersion?> FindCurrentAsync(Guid drawId, CancellationToken cancellationToken);

    Task<CanonicalOutcomePipelineReadiness> CheckReadinessAsync(CancellationToken cancellationToken);

    Task<CanonicalOutcomeRecoveryResult> RecoverAsync(int limit, CancellationToken cancellationToken);
}

public sealed class CanonicalDrawOrchestrator(
    ICanonicalOutcomePipelineRepository repository,
    CanonicalOutcomeProviderAuthority providerAuthority)
{
    public async Task<CanonicalOutcomeVersion> PublishAsync(
        CanonicalOutcomePublicationCommand command,
        CancellationToken cancellationToken)
    {
        ValidatePublication(command);
        var manifest = await repository.FindExecutionManifestAsync(command.DrawId, cancellationToken)
            ?? throw new InvalidOperationException("The Draw Instance has no authoritative Execution Manifest.");
        var authoritativeCommand = command with
        {
            EngineName = manifest.EngineName,
            EngineVersion = manifest.EngineVersion
        };
        var providerEvidence = await providerAuthority.AuthorizePublicationAsync(
            manifest,
            authoritativeCommand,
            cancellationToken);
        return await repository.PublishAsync(
            authoritativeCommand,
            HashPublication(authoritativeCommand, manifest, providerEvidence),
            cancellationToken);
    }

    public Task<OutcomeSettlementRequest> EmitSettlementRequestAsync(
        OutcomeSettlementRequestCommand command,
        CancellationToken cancellationToken)
    {
        ValidateSettlementRequest(command);
        return repository.EmitSettlementRequestAsync(command, HashSettlementRequest(command), cancellationToken);
    }

    public Task<CanonicalOutcomeVersion?> FindCurrentAsync(Guid drawId, CancellationToken cancellationToken)
    {
        if (drawId == Guid.Empty)
        {
            throw new ArgumentException("Draw id is required.", nameof(drawId));
        }

        return repository.FindCurrentAsync(drawId, cancellationToken);
    }

    public Task<CanonicalOutcomePipelineReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        return repository.CheckReadinessAsync(cancellationToken);
    }

    public Task<CanonicalOutcomeRecoveryResult> RecoverAsync(
        int limit,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(limit), "Recovery limit must be between 1 and 100.");
        }

        return repository.RecoverAsync(limit, cancellationToken);
    }

    private static string HashPublication(
        CanonicalOutcomePublicationCommand command,
        DrawExecutionManifest manifest,
        OutcomeProviderExecutionEvidence providerEvidence)
    {
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["auditReference"] = command.AuditReference,
            ["authoritativeSource"] = command.AuthoritativeSource,
            ["causationId"] = command.CausationId,
            ["correlationId"] = command.CorrelationId,
            ["drawId"] = command.DrawId,
            ["engineName"] = command.EngineName,
            ["engineVersion"] = command.EngineVersion,
            ["executionManifestHash"] = manifest.CanonicalManifestHash,
            ["executionManifestId"] = manifest.ExecutionManifestId,
            ["outcomeProviderConfigurationVersion"] = manifest.ProviderConfigurationVersion,
            ["providerEvidenceHash"] = providerEvidence.EvidenceHash,
            ["providerResultHash"] = providerEvidence.ResultHash,
            ["outcomeCertificateHash"] = command.OutcomeCertificateHash,
            ["outcomeCertificateId"] = command.OutcomeCertificateId,
            ["previousOutcomeVersionId"] = command.PreviousOutcomeVersionId,
            ["productReference"] = command.ProductReference,
            ["versionKind"] = command.VersionKind.ToString()
        };
        return Hash(JsonSerializer.Serialize(payload));
    }

    private static string HashSettlementRequest(OutcomeSettlementRequestCommand command)
    {
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["auditReference"] = command.AuditReference,
            ["causationId"] = command.CausationId,
            ["correlationId"] = command.CorrelationId,
            ["outcomeVersionId"] = command.OutcomeVersionId,
            ["settlementInputId"] = command.SettlementInputId
        };
        return Hash(JsonSerializer.Serialize(payload));
    }

    private static string Hash(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private static void ValidatePublication(CanonicalOutcomePublicationCommand command)
    {
        Require(command.IdempotencyKey, "Idempotency key");
        Require(command.ProductReference, "Product reference");
        Require(command.EngineName, "Engine name");
        Require(command.EngineVersion, "Engine version");
        Require(command.AuthoritativeSource, "Authoritative source");
        Require(command.CorrelationId, "Correlation id");
        Require(command.CausationId, "Causation id");
        Require(command.AuditReference, "Audit reference");
        RequireHash(command.OutcomeCertificateHash, "Outcome Certificate hash");

        if (command.DrawId == Guid.Empty || command.OutcomeCertificateId == Guid.Empty)
        {
            throw new ArgumentException("Draw id and Outcome Certificate id are required.");
        }

        if (command.VersionKind == CanonicalOutcomeVersionKind.Published && command.PreviousOutcomeVersionId is not null)
        {
            throw new ArgumentException("An initial publication cannot reference a previous outcome version.");
        }

        if (command.VersionKind != CanonicalOutcomeVersionKind.Published && command.PreviousOutcomeVersionId is null)
        {
            throw new ArgumentException("Correction and cancellation require the exact previous outcome version.");
        }
    }

    private static void ValidateSettlementRequest(OutcomeSettlementRequestCommand command)
    {
        Require(command.IdempotencyKey, "Idempotency key");
        Require(command.CorrelationId, "Correlation id");
        Require(command.CausationId, "Causation id");
        Require(command.AuditReference, "Audit reference");
        if (command.OutcomeVersionId == Guid.Empty)
        {
            throw new ArgumentException("Outcome version id is required.");
        }
    }

    private static void Require(string? value, string name)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"{name} is required.");
        }
    }

    private static void RequireHash(string? value, string name)
    {
        if (string.IsNullOrWhiteSpace(value) || !value.StartsWith("sha256:", StringComparison.Ordinal))
        {
            throw new ArgumentException($"{name} must be a canonical sha256 hash.");
        }
    }
}

public sealed class DisabledCanonicalOutcomePipelineRepository : ICanonicalOutcomePipelineRepository
{
    private const string Message = "Canonical Outcome publication requires durable PostgreSQL persistence.";

    public Task<CanonicalOutcomeVersion> PublishAsync(
        CanonicalOutcomePublicationCommand command,
        string canonicalRequestHash,
        CancellationToken cancellationToken) =>
        Task.FromException<CanonicalOutcomeVersion>(new InvalidOperationException(Message));

    public Task<OutcomeSettlementRequest> EmitSettlementRequestAsync(
        OutcomeSettlementRequestCommand command,
        string canonicalRequestHash,
        CancellationToken cancellationToken) =>
        Task.FromException<OutcomeSettlementRequest>(new InvalidOperationException(Message));

    public Task<DrawExecutionManifest?> FindExecutionManifestAsync(
        Guid drawId,
        CancellationToken cancellationToken) =>
        Task.FromResult<DrawExecutionManifest?>(null);

    public Task<CanonicalOutcomeVersion?> FindCurrentAsync(Guid drawId, CancellationToken cancellationToken) =>
        Task.FromResult<CanonicalOutcomeVersion?>(null);

    public Task<CanonicalOutcomePipelineReadiness> CheckReadinessAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new CanonicalOutcomePipelineReadiness(
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            true,
            false,
            [Message]));

    public Task<CanonicalOutcomeRecoveryResult> RecoverAsync(
        int limit,
        CancellationToken cancellationToken) =>
        Task.FromResult(new CanonicalOutcomeRecoveryResult(
            0,
            0,
            0,
            1,
            false,
            [Message],
            DateTimeOffset.UtcNow));
}
