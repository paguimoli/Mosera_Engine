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

    Task<SettlementInput?> FindTicketDrawAggregateAsync(
        Guid ticketId,
        Guid drawId,
        Guid outcomeCertificateId,
        CancellationToken cancellationToken);

    Task<SettlementInput> SaveTicketDrawAggregateAsync(
        SettlementInput input,
        TicketDrawSettlementAggregateEvidence aggregate,
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

    public async Task<SettlementInput> ConvertTicketDrawAggregateAsync(
        Guid ticketId,
        Guid drawId,
        Guid productVersionId,
        string productVersionHash,
        string currency,
        IReadOnlyList<(Guid TicketItemId, int ItemIndex, long StakeMinor, MathEvaluationResult Evaluation)> evaluations,
        long? effectiveCapMinor,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (ticketId == Guid.Empty || drawId == Guid.Empty || productVersionId == Guid.Empty)
        {
            throw new InvalidOperationException("Ticket, draw, and product version identifiers are required for aggregate SettlementInput.");
        }
        if (evaluations.Count == 0 || evaluations.Select(item => item.TicketItemId).Distinct().Count() != evaluations.Count)
        {
            throw new InvalidOperationException("Aggregate SettlementInput requires a non-empty unique item evaluation set.");
        }
        if (string.IsNullOrWhiteSpace(currency) || currency.Length != 3)
        {
            throw new InvalidOperationException("Aggregate SettlementInput requires an ISO-4217 currency.");
        }

        var ordered = evaluations.OrderBy(item => item.ItemIndex).ThenBy(item => item.TicketItemId).ToArray();
        foreach (var item in ordered) ValidateMathEvaluationResult(item.Evaluation);
        var anchor = ordered[0].Evaluation;
        if (ordered.Any(item =>
                item.StakeMinor <= 0 ||
                item.Evaluation.Certificate.OutcomeCertificateId != anchor.Certificate.OutcomeCertificateId ||
                !string.Equals(item.Evaluation.Certificate.OutcomeCertificateHash, anchor.Certificate.OutcomeCertificateHash, StringComparison.Ordinal) ||
                !string.Equals(item.Evaluation.Certificate.GameManifestHash, anchor.Certificate.GameManifestHash, StringComparison.Ordinal) ||
                !string.Equals(item.Evaluation.Certificate.MathModelHash, anchor.Certificate.MathModelHash, StringComparison.Ordinal) ||
                !string.Equals(item.Evaluation.Certificate.PaytableHash, anchor.Certificate.PaytableHash, StringComparison.Ordinal) ||
                !string.Equals(item.Evaluation.Certificate.EvaluatorVersion, anchor.Certificate.EvaluatorVersion, StringComparison.Ordinal)))
        {
            throw new InvalidOperationException("Aggregate SettlementInput item lineage must be exact and homogeneous.");
        }

        var itemEvidence = ordered.Select(item => BuildItemEvidence(item)).ToArray();
        var totalStake = checked(itemEvidence.Sum(item => item.StakeMinor));
        var preCapGross = checked(itemEvidence.Sum(item => item.GrossReturnMinor));
        var postCapGross = effectiveCapMinor is > 0
            ? Math.Min(preCapGross, effectiveCapMinor.Value)
            : preCapGross;
        var capScope = effectiveCapMinor is > 0 ? "TICKET_DRAW" : "NONE";
        var issuedAt = ordered.Max(item => item.Evaluation.Certificate.IssuedAt);
        var itemPayload = itemEvidence.Select(item => new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["evaluationOutcome"] = item.EvaluationOutcome.ToString(),
            ["grossReturnMinor"] = item.GrossReturnMinor,
            ["itemIndex"] = item.ItemIndex,
            ["lossStakeMinor"] = item.LossStakeMinor,
            ["mathEvaluationCertificateHash"] = item.MathEvaluationCertificateHash,
            ["mathEvaluationCertificateId"] = item.MathEvaluationCertificateId,
            ["mathEvaluationId"] = item.MathEvaluationId,
            ["prizeFactsHash"] = item.PrizeFactsHash,
            ["prizeTier"] = item.PrizeTier,
            ["refundReturnMinor"] = item.RefundReturnMinor,
            ["stakeMinor"] = item.StakeMinor,
            ["ticketItemId"] = item.TicketItemId
        }).ToArray();
        var itemEvidenceJson = JsonSerializer.Serialize(itemPayload);
        var itemEvidenceHash = HashCanonical(itemEvidenceJson);
        var aggregatePayload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["capScope"] = capScope,
            ["captureAmountMinor"] = totalStake,
            ["creditAmountMinor"] = postCapGross,
            ["currency"] = currency.ToUpperInvariant(),
            ["drawId"] = drawId,
            ["effectiveCapMinor"] = effectiveCapMinor,
            ["evaluatorVersion"] = anchor.Certificate.EvaluatorVersion,
            ["gameManifestHash"] = anchor.Certificate.GameManifestHash,
            ["gameManifestId"] = anchor.Certificate.GameManifestId,
            ["gameManifestVersion"] = anchor.Certificate.GameManifestVersion,
            ["itemEvidenceHash"] = itemEvidenceHash,
            ["items"] = itemPayload,
            ["mathModelHash"] = anchor.Certificate.MathModelHash,
            ["mathModelId"] = anchor.Certificate.MathModelId,
            ["mathModelVersion"] = anchor.Certificate.MathModelVersion,
            ["outcomeCertificateHash"] = anchor.Certificate.OutcomeCertificateHash,
            ["outcomeCertificateId"] = anchor.Certificate.OutcomeCertificateId,
            ["paytableHash"] = anchor.Certificate.PaytableHash,
            ["paytableId"] = anchor.Certificate.PaytableId,
            ["paytableVersion"] = anchor.Certificate.PaytableVersion,
            ["postCapGrossReturnMinor"] = postCapGross,
            ["preCapGrossReturnMinor"] = preCapGross,
            ["productVersionHash"] = productVersionHash,
            ["productVersionId"] = productVersionId,
            ["releaseAmountMinor"] = 0L,
            ["ticketId"] = ticketId,
            ["totalReservedStakeMinor"] = totalStake
        };
        var canonicalJson = JsonSerializer.Serialize(aggregatePayload);
        var canonicalHash = HashCanonical(canonicalJson);
        var aggregateOutcome = postCapGross switch
        {
            0 => PrizeOutcome.Loss,
            _ when postCapGross == totalStake => PrizeOutcome.Push,
            _ => PrizeOutcome.Win
        };
        var aggregateFacts = new PrizeFacts(
            aggregateOutcome,
            "TICKET_DRAW_AGGREGATE",
            totalStake == 0 ? 0m : (decimal)postCapGross / totalStake,
            0m,
            new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["capReductionMinor"] = preCapGross - postCapGross,
                ["capScope"] = capScope,
                ["effectiveCapMinor"] = effectiveCapMinor,
                ["itemCount"] = itemEvidence.Length,
                ["itemEvidenceHash"] = itemEvidenceHash,
                ["postCapGrossReturnMinor"] = postCapGross,
                ["preCapGrossReturnMinor"] = preCapGross,
                ["totalReservedStakeMinor"] = totalStake
            },
            EvaluationReasonCode: "TICKET_DRAW_AGGREGATE");
        var aggregateFactsJson = MathEvaluationCanonicalizer.CanonicalizePrizeFacts(aggregateFacts);
        var aggregateFactsHash = MathEvaluationCanonicalizer.HashJson(aggregateFactsJson);
        var inputId = DeterministicGuid($"ticket-draw-aggregate:{ticketId:N}:{drawId:N}:{canonicalHash}");
        var provenance = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["adapterVersion"] = "ticket-draw-settlement-aggregate-1",
            ["authority"] = "MathAuthority",
            ["itemEvidenceHash"] = itemEvidenceHash,
            ["source"] = "MathEvaluationCertificateSet"
        };
        var input = new SettlementInput(
            inputId,
            anchor.Certificate.CertificateId,
            anchor.CanonicalPrizeFactsHash,
            anchor.Certificate.OutcomeCertificateId,
            anchor.Certificate.OutcomeCertificateHash,
            ticketId.ToString(),
            anchor.Certificate.GameManifestId!,
            anchor.Certificate.GameManifestVersion!,
            anchor.Certificate.GameManifestHash!,
            anchor.Certificate.MathModelId,
            anchor.Certificate.MathModelVersion,
            anchor.Certificate.MathModelHash,
            anchor.Certificate.PaytableId,
            anchor.Certificate.PaytableVersion,
            anchor.Certificate.PaytableHash,
            anchor.Certificate.EvaluatorVersion!,
            aggregateOutcome,
            aggregateFacts.PrizeTier,
            aggregateFacts,
            aggregateFactsHash,
            0m,
            aggregateFacts.Multiplier,
            HashCanonical($"{canonicalHash}|{itemEvidenceHash}|{ticketId:N}|{drawId:N}"),
            $"ticket-draw-settlement:{ticketId:N}:{drawId:N}:{anchor.Certificate.OutcomeCertificateId:N}",
            issuedAt,
            provenance,
            canonicalJson,
            canonicalHash,
            "TICKET_DRAW_AGGREGATE");
        var aggregate = new TicketDrawSettlementAggregateEvidence(
            inputId, ticketId, drawId, productVersionId, productVersionHash,
            currency.ToUpperInvariant(), totalStake, preCapGross, effectiveCapMinor,
            capScope, postCapGross, totalStake, 0, postCapGross,
            itemEvidenceHash, canonicalHash, itemEvidence);
        return await repository.SaveTicketDrawAggregateAsync(input, aggregate, cancellationToken);
    }

    private static TicketDrawSettlementItemEvidence BuildItemEvidence(
        (Guid TicketItemId, int ItemIndex, long StakeMinor, MathEvaluationResult Evaluation) item)
    {
        var facts = item.Evaluation.PrizeFacts;
        var gross = facts.Outcome switch
        {
            PrizeOutcome.Win when facts.PayoutUnits > 0m => checked(item.StakeMinor + ToMinor(facts.PayoutUnits)),
            PrizeOutcome.Win when facts.Multiplier > 0m => ToMinor(item.StakeMinor * facts.Multiplier),
            PrizeOutcome.Push when facts.Multiplier > 0m => ToMinor(item.StakeMinor * facts.Multiplier),
            PrizeOutcome.Push => item.StakeMinor,
            PrizeOutcome.Loss => 0,
            _ => throw new InvalidOperationException("Rejected Math evaluation cannot enter aggregate SettlementInput.")
        };
        return new TicketDrawSettlementItemEvidence(
            item.TicketItemId, item.ItemIndex, item.StakeMinor,
            item.Evaluation.MathEvaluationId, item.Evaluation.Certificate.CertificateId,
            item.Evaluation.CanonicalPrizeFactsHash, facts.Outcome, facts.PrizeTier,
            gross, facts.Outcome == PrizeOutcome.Push ? gross : 0,
            facts.Outcome == PrizeOutcome.Loss ? item.StakeMinor : 0,
            item.Evaluation.CanonicalPrizeFactsHash);
    }

    private static long ToMinor(decimal value) =>
        checked((long)Math.Round(value, 0, MidpointRounding.AwayFromZero));

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
            ["prizeFacts"] = JsonSerializer.Deserialize<JsonElement>(prizeFactsJson),
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
    private readonly List<TicketDrawSettlementAggregateEvidence> aggregates = [];
    private readonly object sync = new();

    public IReadOnlyCollection<SettlementInput> Inputs
    {
        get { lock (sync) return inputs.ToArray(); }
    }

    public IReadOnlyCollection<TicketDrawSettlementAggregateEvidence> Aggregates
    {
        get { lock (sync) return aggregates.ToArray(); }
    }

    public Task<SettlementInput?> FindByMathEvaluationCertificateAsync(
        Guid mathEvaluationCertificateId,
        string mathEvaluationCertificateHash,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (sync)
        {
            return Task.FromResult(inputs.LastOrDefault(input =>
                input.MathEvaluationCertificateId == mathEvaluationCertificateId &&
                string.Equals(input.MathEvaluationCertificateHash, mathEvaluationCertificateHash, StringComparison.Ordinal)));
        }
    }

    public Task<SettlementInput?> FindByCanonicalPayloadHashAsync(
        string canonicalPayloadHash,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (sync)
        {
            return Task.FromResult(inputs.LastOrDefault(input =>
                string.Equals(input.CanonicalPayloadHash, canonicalPayloadHash, StringComparison.Ordinal)));
        }
    }

    public Task<SettlementInput> SaveAsync(
        SettlementInput input,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (sync)
        {
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
    }

    public Task<SettlementInput?> FindTicketDrawAggregateAsync(
        Guid ticketId,
        Guid drawId,
        Guid outcomeCertificateId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (sync)
        {
            var aggregate = aggregates.LastOrDefault(item =>
                item.TicketId == ticketId &&
                item.DrawId == drawId);
            if (aggregate is null)
            {
                return Task.FromResult<SettlementInput?>(null);
            }

            return Task.FromResult(inputs.LastOrDefault(input =>
                input.SettlementInputId == aggregate.SettlementInputId &&
                input.OutcomeCertificateId == outcomeCertificateId));
        }
    }

    public Task<SettlementInput> SaveTicketDrawAggregateAsync(
        SettlementInput input,
        TicketDrawSettlementAggregateEvidence aggregate,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (sync)
        {
            var existingAggregate = aggregates.LastOrDefault(item =>
                item.TicketId == aggregate.TicketId &&
                item.DrawId == aggregate.DrawId);
            if (existingAggregate is not null)
            {
                var existingInput = inputs.Single(item =>
                    item.SettlementInputId == existingAggregate.SettlementInputId);
                if (!string.Equals(existingInput.CanonicalPayloadHash, input.CanonicalPayloadHash, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("Conflicting aggregate SettlementInput payload for the same ticket and draw.");
                }

                return Task.FromResult(existingInput);
            }

            if (inputs.Any(item => item.CanonicalPayloadHash == input.CanonicalPayloadHash))
            {
                throw new InvalidOperationException("Duplicate SettlementInput canonical payload hash detected.");
            }

            inputs.Add(input);
            aggregates.Add(aggregate);
            return Task.FromResult(input);
        }
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
