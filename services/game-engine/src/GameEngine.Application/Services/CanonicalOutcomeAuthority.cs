using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Application.Interfaces;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public interface ICanonicalOutcomePipelineRepository
{
    Task<CanonicalOutcomeVersion> PublishAsync(
        CanonicalOutcomePublicationCommand command,
        CanonicalOutcomeAuthorityContext context,
        string canonicalRequestHash,
        CancellationToken cancellationToken);

    Task<DrawExecutionManifest?> FindExecutionManifestAsync(
        Guid drawId,
        CancellationToken cancellationToken);

    Task<CanonicalOutcomeCertificateVerificationEvidence?> FindCertificateEvidenceAsync(
        Guid certificateId,
        string certificateHash,
        CancellationToken cancellationToken);

    Task<OutcomeSettlementRequest> EmitSettlementRequestAsync(
        OutcomeSettlementRequestCommand command,
        string canonicalRequestHash,
        CancellationToken cancellationToken);

    Task<CanonicalOutcomeVersion?> FindCurrentAsync(Guid drawId, CancellationToken cancellationToken);

    Task<CanonicalOutcomePipelineReadiness> CheckReadinessAsync(CancellationToken cancellationToken);

    Task<CanonicalOutcomeRecoveryResult> RecoverAsync(int limit, CancellationToken cancellationToken);
}

public sealed class CanonicalOutcomeAuthority(
    ICanonicalOutcomePipelineRepository repository,
    CanonicalOutcomeProviderAuthority providerAuthority,
    IGameDefinitionVersionRepository gameDefinitionVersions,
    CertificateVerificationService certificateVerification)
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
        var provider = await providerAuthority.AuthorizePublicationAsync(
            manifest,
            authoritativeCommand,
            cancellationToken);
        authoritativeCommand = authoritativeCommand with
        {
            AuthoritativeSource = $"OutcomeProvider:{provider.Registration.ProviderCategory}"
        };
        var definitionVersion = await gameDefinitionVersions.GetAsync(
            manifest.GameDefinitionVersionId,
            cancellationToken)
            ?? throw new InvalidOperationException(
                "Execution Manifest references an unknown Game Definition version.");
        var validatedResult = ValidateProviderResult(
            manifest,
            definitionVersion,
            provider.Evidence);
        var certificateEvidence = await repository.FindCertificateEvidenceAsync(
            authoritativeCommand.OutcomeCertificateId,
            authoritativeCommand.OutcomeCertificateHash,
            cancellationToken)
            ?? throw new InvalidOperationException(
                "Canonical Outcome publication requires one verified Outcome Certificate signature.");
        ValidateCertificate(
            authoritativeCommand,
            provider.Evidence,
            certificateEvidence);
        var context = new CanonicalOutcomeAuthorityContext(
            manifest,
            provider,
            definitionVersion,
            validatedResult,
            provider.Evidence.CanonicalResultJson!,
            provider.Evidence.CanonicalResultHash!,
            certificateEvidence);
        return await repository.PublishAsync(
            authoritativeCommand,
            context,
            HashPublication(authoritativeCommand, context),
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
        CanonicalOutcomeAuthorityContext context)
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
            ["actorReference"] = command.ActorReference,
            ["executionManifestHash"] = context.Manifest.CanonicalManifestHash,
            ["executionManifestId"] = context.Manifest.ExecutionManifestId,
            ["gameDefinitionHash"] = context.GameDefinitionVersion.DefinitionHash,
            ["gameDefinitionVersionId"] = context.GameDefinitionVersion.Id,
            ["lifecycleEvidenceHash"] = command.LifecycleEvidenceHash,
            ["outcomeProviderConfigurationVersion"] = context.Manifest.ProviderConfigurationVersion,
            ["providerCategory"] = context.Provider.Registration.ProviderCategory.ToString(),
            ["providerEvidenceHash"] = context.Provider.Evidence.EvidenceHash,
            ["providerEvidenceId"] = context.Provider.Evidence.EvidenceId,
            ["providerResultHash"] = context.Provider.Evidence.ResultHash,
            ["outcomeCertificateHash"] = command.OutcomeCertificateHash,
            ["outcomeCertificateId"] = command.OutcomeCertificateId,
            ["certificateSignatureId"] = context.CertificateEvidence.SignatureId,
            ["certificateVerificationHash"] = context.CertificateEvidence.VerificationEvidenceHash,
            ["previousOutcomeVersionId"] = command.PreviousOutcomeVersionId,
            ["productReference"] = command.ProductReference,
            ["reasonCode"] = command.ReasonCode,
            ["validatedOutcomeHash"] = context.ValidatedResultHash,
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
        Require(command.ActorReference, "Actor reference");
        Require(command.ReasonCode, "Reason code");
        RequireHash(command.OutcomeCertificateHash, "Outcome Certificate hash");
        RequireHash(command.LifecycleEvidenceHash, "Lifecycle evidence hash");

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

    private static CanonicalProviderOutcomeResult ValidateProviderResult(
        DrawExecutionManifest manifest,
        GameDefinitionVersion definitionVersion,
        OutcomeProviderExecutionEvidence evidence)
    {
        var result = CanonicalProviderOutcomeFactory.Parse(evidence.CanonicalResultJson!);
        if (result.SchemaVersion != "mosera.canonical-provider-result.v1" ||
            result.DrawId != manifest.DrawId ||
            result.ExecutionManifestId != manifest.ExecutionManifestId ||
            result.GameDefinitionVersionId != manifest.GameDefinitionVersionId ||
            result.GameDefinitionHash != definitionVersion.DefinitionHash ||
            result.EvaluatorVersion != manifest.EvaluatorVersion ||
            result.SourceResultHash != evidence.ResultHash)
        {
            throw new InvalidOperationException(
                "Canonical provider result does not match the immutable Execution Manifest, Game Definition, evaluator, or source result.");
        }

        var rules = definitionVersion.OutcomeGenerationDefinition
            ?? throw new InvalidOperationException(
                "Game Definition version has no immutable outcome validation rules.");
        ValidateNumbers("primary", result.PrimaryNumbers, rules.NumberUniverse, rules.NumbersRequired,
            rules.Unique, rules.WithReplacement, rules.Ordering);
        if (rules.BonusNumbers is null)
        {
            if (result.BonusNumbers.Count != 0 || result.BonusOrdering is not null)
            {
                throw new InvalidOperationException(
                    "Canonical provider result contains bonus values not allowed by the Game Definition.");
            }
        }
        else
        {
            ValidateNumbers("bonus", result.BonusNumbers, rules.BonusNumbers.NumberUniverse,
                rules.BonusNumbers.NumbersRequired, rules.BonusNumbers.Unique,
                rules.BonusNumbers.WithReplacement, rules.BonusNumbers.Ordering);
            if (result.BonusOrdering != rules.BonusNumbers.Ordering ||
                (!rules.BonusNumbers.MayOverlapPrimary &&
                 result.BonusNumbers.Intersect(result.PrimaryNumbers).Any()))
            {
                throw new InvalidOperationException(
                    "Canonical bonus result violates immutable ordering or overlap rules.");
            }
        }

        return result;
    }

    private void ValidateCertificate(
        CanonicalOutcomePublicationCommand command,
        OutcomeProviderExecutionEvidence providerEvidence,
        CanonicalOutcomeCertificateVerificationEvidence certificateEvidence)
    {
        if (certificateEvidence.DrawId != command.DrawId ||
            certificateEvidence.OutcomeHash != command.OutcomeCertificateHash ||
            providerEvidence.ResultHash != command.OutcomeCertificateHash ||
            certificateEvidence.Signature.VerificationStatus != SignatureVerificationStatus.Verified)
        {
            throw new InvalidOperationException(
                "Outcome Certificate, provider result, draw, or stored verification status does not match.");
        }

        var verification = certificateVerification.Verify(new CertificateVerificationRequest(
            "OutcomeCertificate",
            command.OutcomeCertificateId,
            command.OutcomeCertificateHash,
            certificateEvidence.OutcomePayloadJson,
            certificateEvidence.Signature,
            certificateEvidence.SigningProvider,
            certificateEvidence.PreviousCertificates,
            CertificateVerificationMode.DryRun));
        if (!verification.IsValid)
        {
            throw new InvalidOperationException(
                $"Outcome Certificate verification failed: {string.Join("; ", verification.Errors)}");
        }
    }

    private static void ValidateNumbers(
        string name,
        IReadOnlyList<int> values,
        IReadOnlyList<int> universe,
        int required,
        bool unique,
        bool withReplacement,
        OutcomeNumberOrdering ordering)
    {
        if (values.Count != required || values.Any(value => !universe.Contains(value)))
        {
            throw new InvalidOperationException(
                $"Canonical {name} result violates the immutable count or universe.");
        }

        if ((unique || !withReplacement) && values.Distinct().Count() != values.Count)
        {
            throw new InvalidOperationException(
                $"Canonical {name} result violates immutable uniqueness or replacement rules.");
        }

        if (ordering == OutcomeNumberOrdering.Ascending && !values.SequenceEqual(values.Order()))
        {
            throw new InvalidOperationException(
                $"Canonical {name} result violates immutable ascending ordering.");
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
        CanonicalOutcomeAuthorityContext context,
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

    public Task<CanonicalOutcomeCertificateVerificationEvidence?> FindCertificateEvidenceAsync(
        Guid certificateId,
        string certificateHash,
        CancellationToken cancellationToken) =>
        Task.FromResult<CanonicalOutcomeCertificateVerificationEvidence?>(null);

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
