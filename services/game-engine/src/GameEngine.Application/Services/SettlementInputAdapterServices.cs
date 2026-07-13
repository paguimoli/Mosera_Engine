using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed record SettlementInputReadiness(
    bool SettlementHandoffReady,
    bool AdapterReady,
    bool CertificateValidationReady,
    bool CanonicalPayloadReady,
    bool ReplayReady,
    bool RepositoryConfigured,
    bool RepositoryReachable,
    bool ProductionActivationDisabled,
    IReadOnlyCollection<string> Blockers);

public interface ISettlementInputRepository
{
    Task<SettlementInput?> FindByMathEvaluationCertificateAsync(
        Guid mathEvaluationCertificateId,
        string mathEvaluationCertificateHash,
        CancellationToken cancellationToken);

    Task<SettlementInput?> FindByCanonicalPayloadHashAsync(
        string canonicalPayloadHash,
        CancellationToken cancellationToken);

    Task<SettlementInput> SaveAsync(
        SettlementInput input,
        CancellationToken cancellationToken);

    Task<SettlementInputReadiness> CheckReadinessAsync(CancellationToken cancellationToken);
}

public sealed class SettlementInputAdapter(ISettlementInputRepository repository)
{
    private static readonly string[] ForbiddenFields =
    [
        "balance",
        "wallet",
        "ledger",
        "commission",
        "tax",
        "cashier",
        "accountId",
        "walletId",
        "ledgerEntryId",
        "transactionId"
    ];

    public async Task<SettlementInput> ConvertAsync(
        MathEvaluationResult result,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateMathEvaluationResult(result);

        var input = BuildSettlementInput(result);
        var existing = await repository.FindByMathEvaluationCertificateAsync(
            input.MathEvaluationCertificateId,
            input.MathEvaluationCertificateHash,
            cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.CanonicalPayloadHash, input.CanonicalPayloadHash, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Conflicting SettlementInput payload for the same Math Evaluation Certificate.");
            }

            return existing;
        }

        return await repository.SaveAsync(input, cancellationToken);
    }

    public async Task<SettlementInput> ReplayAsync(
        MathEvaluationResult result,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var existing = await repository.FindByMathEvaluationCertificateAsync(
            result.Certificate.CertificateId,
            result.CanonicalPrizeFactsHash,
            cancellationToken)
            ?? throw new InvalidOperationException("SettlementInput record was not found for replay.");

        var regenerated = BuildSettlementInput(result);
        if (!string.Equals(existing.CanonicalPayloadHash, regenerated.CanonicalPayloadHash, StringComparison.Ordinal) ||
            !string.Equals(existing.ReplayHash, regenerated.ReplayHash, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("SettlementInput replay mismatch detected.");
        }

        return existing;
    }

    public Task<SettlementInput?> FindByMathEvaluationCertificateAsync(
        Guid mathEvaluationCertificateId,
        string mathEvaluationCertificateHash,
        CancellationToken cancellationToken)
    {
        return repository.FindByMathEvaluationCertificateAsync(
            mathEvaluationCertificateId,
            mathEvaluationCertificateHash,
            cancellationToken);
    }

    public Task<SettlementInput?> FindByCanonicalPayloadHashAsync(
        string canonicalPayloadHash,
        CancellationToken cancellationToken)
    {
        return repository.FindByCanonicalPayloadHashAsync(canonicalPayloadHash, cancellationToken);
    }

    public Task<SettlementInputReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        return repository.CheckReadinessAsync(cancellationToken);
    }

    public static SettlementInput BuildSettlementInput(MathEvaluationResult result)
    {
        ValidateMathEvaluationResult(result);

        var certificate = result.Certificate;
        var prizeFactsJson = MathEvaluationCanonicalizer.CanonicalizePrizeFacts(result.PrizeFacts);
        var provenance = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["authority"] = "MathAuthority",
            ["source"] = "MathEvaluationCertificate",
            ["adapterVersion"] = "settlement-input-adapter-1"
        };
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["evaluatorVersion"] = certificate.EvaluatorVersion,
            ["evaluationOutcome"] = result.PrizeFacts.Outcome.ToString(),
            ["gameManifestHash"] = certificate.GameManifestHash,
            ["gameManifestId"] = certificate.GameManifestId,
            ["gameManifestVersion"] = certificate.GameManifestVersion,
            ["idempotencyKey"] = result.IdempotencyKey,
            ["issuedAt"] = certificate.IssuedAt.ToUniversalTime().ToString("O"),
            ["mathEvaluationCertificateHash"] = result.CanonicalPrizeFactsHash,
            ["mathEvaluationCertificateId"] = certificate.CertificateId,
            ["mathModelHash"] = certificate.MathModelHash,
            ["mathModelId"] = certificate.MathModelId,
            ["mathModelVersion"] = certificate.MathModelVersion,
            ["multiplier"] = result.PrizeFacts.Multiplier,
            ["outcomeCertificateHash"] = certificate.OutcomeCertificateHash,
            ["outcomeCertificateId"] = certificate.OutcomeCertificateId,
            ["paytableHash"] = certificate.PaytableHash,
            ["paytableId"] = certificate.PaytableId,
            ["paytableVersion"] = certificate.PaytableVersion,
            ["payoutUnits"] = result.PrizeFacts.PayoutUnits,
            ["prizeFacts"] = result.PrizeFacts,
            ["prizeFactsHash"] = result.CanonicalPrizeFactsHash,
            ["prizeTier"] = result.PrizeFacts.PrizeTier,
            ["provenance"] = provenance,
            ["ticketReference"] = certificate.TicketReference
        };
        var canonicalPayloadJson = JsonSerializer.Serialize(payload);
        var canonicalPayloadHash = HashCanonical(canonicalPayloadJson);
        var replayHash = HashCanonical($"{canonicalPayloadHash}|{result.CanonicalPrizeFactsHash}|{certificate.CertificateId:N}");

        EnsureNoForbiddenReferences(canonicalPayloadJson, "SettlementInput payload");

        return new SettlementInput(
            DeterministicGuid($"{certificate.CertificateId:N}:settlement-input:{canonicalPayloadHash}"),
            certificate.CertificateId,
            result.CanonicalPrizeFactsHash,
            certificate.OutcomeCertificateId,
            certificate.OutcomeCertificateHash,
            certificate.TicketReference,
            certificate.GameManifestId ?? throw new InvalidOperationException("Math Evaluation Certificate is missing Game Manifest id."),
            certificate.GameManifestVersion ?? throw new InvalidOperationException("Math Evaluation Certificate is missing Game Manifest version."),
            certificate.GameManifestHash ?? throw new InvalidOperationException("Math Evaluation Certificate is missing Game Manifest hash."),
            certificate.MathModelId,
            certificate.MathModelVersion,
            certificate.MathModelHash,
            certificate.PaytableId,
            certificate.PaytableVersion,
            certificate.PaytableHash,
            certificate.EvaluatorVersion ?? throw new InvalidOperationException("Math Evaluation Certificate is missing evaluator version."),
            result.PrizeFacts.Outcome,
            result.PrizeFacts.PrizeTier,
            result.PrizeFacts,
            result.CanonicalPrizeFactsHash,
            result.PrizeFacts.PayoutUnits,
            result.PrizeFacts.Multiplier,
            replayHash,
            result.IdempotencyKey,
            certificate.IssuedAt,
            provenance,
            canonicalPayloadJson,
            canonicalPayloadHash);
    }

    private static void ValidateMathEvaluationResult(MathEvaluationResult result)
    {
        if (result.Certificate.CertificateId == Guid.Empty)
        {
            throw new InvalidOperationException("Math Evaluation Certificate id is required.");
        }

        if (result.Certificate.OutcomeCertificateId == Guid.Empty)
        {
            throw new InvalidOperationException("Outcome Certificate reference is required.");
        }

        RequireHash(result.CanonicalPrizeFactsHash, "Math Evaluation Certificate hash");
        RequireHash(result.Certificate.OutcomeCertificateHash, "Outcome Certificate hash");
        RequireHash(result.Certificate.MathModelHash, "Math Model hash");
        RequireHash(result.Certificate.PaytableHash, "Paytable hash");
        RequireHash(result.Certificate.GameManifestHash, "Game Manifest hash");

        var prizeFactsJson = MathEvaluationCanonicalizer.CanonicalizePrizeFacts(result.PrizeFacts);
        var prizeFactsHash = MathEvaluationCanonicalizer.HashJson(prizeFactsJson);
        if (!string.Equals(prizeFactsHash, result.CanonicalPrizeFactsHash, StringComparison.Ordinal) ||
            !string.Equals(result.CanonicalPrizeFactsHash, result.Certificate.CanonicalPrizeFactsHash, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("PrizeFacts hash mismatch detected for Math Evaluation Certificate.");
        }

        if (result.PrizeFacts.Outcome == PrizeOutcome.Rejected)
        {
            throw new InvalidOperationException("Rejected Math Evaluation outcomes cannot be handed off to Settlement.");
        }

        if (!string.Equals(
            result.Certificate.RtpMathMetadataReference,
            $"math-model:{result.Certificate.MathModelId}:{result.Certificate.MathModelVersion}:{result.Certificate.MathModelHash}",
            StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Math Evaluation Certificate Math Model reference mismatch detected.");
        }

        RequireText(result.Certificate.MathModelId, "Math Model id");
        RequireText(result.Certificate.MathModelVersion, "Math Model version");
        RequireText(result.Certificate.PaytableId, "Paytable id");
        RequireText(result.Certificate.PaytableVersion, "Paytable version");
        RequireText(result.Certificate.TicketReference, "ticket/wager reference");
        RequireText(result.Certificate.EvaluatorVersion, "evaluator version");
        RequireText(result.Certificate.GameManifestId, "Game Manifest id");
        RequireText(result.Certificate.GameManifestVersion, "Game Manifest version");
        RequireText(result.IdempotencyKey, "idempotency key");

        EnsureNoForbiddenReferences(prizeFactsJson, "PrizeFacts");
    }

    private static void RequireText(string? value, string field)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException($"{field} is required.");
        }
    }

    private static void RequireHash(string? value, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || !value.StartsWith("sha256:", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"{field} must be a sha256 hash.");
        }
    }

    private static void EnsureNoForbiddenReferences(string json, string field)
    {
        foreach (var forbidden in ForbiddenFields)
        {
            if (json.Contains(forbidden, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"{field} cannot contain financial or settlement-side reference '{forbidden}'.");
            }
        }
    }

    private static string HashCanonical(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private static Guid DeterministicGuid(string value)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(hash[..16]);
    }
}

public sealed class InMemorySettlementInputRepository : ISettlementInputRepository
{
    private readonly List<SettlementInput> inputs = [];

    public IReadOnlyCollection<SettlementInput> Inputs => inputs;

    public Task<SettlementInput?> FindByMathEvaluationCertificateAsync(
        Guid mathEvaluationCertificateId,
        string mathEvaluationCertificateHash,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(inputs.LastOrDefault(input =>
            input.MathEvaluationCertificateId == mathEvaluationCertificateId &&
            string.Equals(input.MathEvaluationCertificateHash, mathEvaluationCertificateHash, StringComparison.Ordinal)));
    }

    public Task<SettlementInput?> FindByCanonicalPayloadHashAsync(
        string canonicalPayloadHash,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(inputs.LastOrDefault(input =>
            string.Equals(input.CanonicalPayloadHash, canonicalPayloadHash, StringComparison.Ordinal)));
    }

    public Task<SettlementInput> SaveAsync(
        SettlementInput input,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var existing = inputs.LastOrDefault(item =>
            item.MathEvaluationCertificateId == input.MathEvaluationCertificateId &&
            item.MathEvaluationCertificateHash == input.MathEvaluationCertificateHash);
        if (existing is not null)
        {
            if (!string.Equals(existing.CanonicalPayloadHash, input.CanonicalPayloadHash, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Conflicting SettlementInput payload for the same Math Evaluation Certificate.");
            }

            return Task.FromResult(existing);
        }

        if (inputs.Any(item => item.CanonicalPayloadHash == input.CanonicalPayloadHash))
        {
            throw new InvalidOperationException("Duplicate SettlementInput canonical payload hash detected.");
        }

        inputs.Add(input);
        return Task.FromResult(input);
    }

    public Task<SettlementInputReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new SettlementInputReadiness(
            SettlementHandoffReady: true,
            AdapterReady: true,
            CertificateValidationReady: true,
            CanonicalPayloadReady: true,
            ReplayReady: true,
            RepositoryConfigured: false,
            RepositoryReachable: false,
            ProductionActivationDisabled: true,
            Blockers: ["SettlementInput persistence is using non-production in-memory storage."]));
    }
}
