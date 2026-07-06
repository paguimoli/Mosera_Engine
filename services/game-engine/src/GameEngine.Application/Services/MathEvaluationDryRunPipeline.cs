using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class MathEvaluationDryRunPipeline
{
    private readonly Dictionary<string, MathEvaluationResult> idempotencyCache = new(StringComparer.Ordinal);

    public MathEvaluationResult Evaluate(
        MathEvaluationRequest request,
        OutcomeCertificate outcomeCertificate,
        MathModelDefinitionV1 mathModel,
        PaytableDefinitionV1 paytable,
        IReadOnlyDictionary<string, object?> outcomePayload)
    {
        ValidateRequest(request, outcomeCertificate, mathModel, paytable);

        if (idempotencyCache.TryGetValue(request.IdempotencyKey, out var existing))
        {
            return existing;
        }

        var evaluatedAt = DateTimeOffset.UtcNow;
        var prizeFacts = EvaluatePrizeFacts(request.WagerPayload, outcomePayload, paytable);
        var canonicalPrizeFacts = CanonicalizePrizeFacts(prizeFacts);
        var prizeFactsHash = $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalPrizeFacts))).ToLowerInvariant()}";
        var evaluationId = DeterministicGuid($"{request.IdempotencyKey}:math-evaluation:{prizeFactsHash}");
        var certificateId = DeterministicGuid($"{request.IdempotencyKey}:math-evaluation-certificate:{prizeFactsHash}");

        var certificate = new MathEvaluationCertificate(
            certificateId,
            evaluationId,
            outcomeCertificate.CertificateId,
            request.OutcomeCertificateHash,
            mathModel.MathModelId,
            mathModel.Version,
            mathModel.ContentHash,
            paytable.PaytableId,
            paytable.Version,
            paytable.ContentHash,
            request.TicketReference,
            prizeFactsHash,
            $"math-model:{mathModel.MathModelId}:{mathModel.Version}:{mathModel.ContentHash}",
            new SignatureMetadata(
                "placeholder-signing-key",
                "sha256-v1",
                "placeholder-signature-v1",
                "placeholder-signature",
                evaluatedAt),
            evaluatedAt);

        var result = new MathEvaluationResult(
            evaluationId,
            request.RequestId,
            request.IdempotencyKey,
            request.Mode,
            prizeFacts,
            canonicalPrizeFacts,
            prizeFactsHash,
            certificate,
            evaluatedAt);

        idempotencyCache.Add(request.IdempotencyKey, result);
        return result;
    }

    private static void ValidateRequest(
        MathEvaluationRequest request,
        OutcomeCertificate outcomeCertificate,
        MathModelDefinitionV1 mathModel,
        PaytableDefinitionV1 paytable)
    {
        RequireText(request.GameManifestReference, nameof(request.GameManifestReference));
        RequireText(request.MathModelId, nameof(request.MathModelId));
        RequireText(request.MathModelVersion, nameof(request.MathModelVersion));
        RequireText(request.MathModelHash, nameof(request.MathModelHash));
        RequireText(request.PaytableId, nameof(request.PaytableId));
        RequireText(request.PaytableVersion, nameof(request.PaytableVersion));
        RequireText(request.PaytableHash, nameof(request.PaytableHash));
        RequireText(request.TicketReference, nameof(request.TicketReference));
        RequireText(request.IdempotencyKey, nameof(request.IdempotencyKey));

        if (request.Mode == MathEvaluationMode.ProductionDisabled)
        {
            throw new InvalidOperationException("Production Math Authority evaluation is disabled for this phase.");
        }

        if (outcomeCertificate.CertificateId != request.OutcomeCertificateId ||
            outcomeCertificate.CanonicalOutcomeHash != request.OutcomeCertificateHash)
        {
            throw new InvalidOperationException("Outcome certificate reference does not match the request.");
        }

        if (mathModel.MathModelId != request.MathModelId ||
            mathModel.Version != request.MathModelVersion ||
            mathModel.ContentHash != request.MathModelHash)
        {
            throw new InvalidOperationException("Math model reference does not match the request.");
        }

        if (paytable.PaytableId != request.PaytableId ||
            paytable.Version != request.PaytableVersion ||
            paytable.ContentHash != request.PaytableHash ||
            paytable.MathModelId != mathModel.MathModelId ||
            paytable.MathModelVersion != mathModel.Version)
        {
            throw new InvalidOperationException("Paytable reference does not match the request.");
        }

        if (!MathGovernanceValidator.Validate(mathModel).IsValid)
        {
            throw new InvalidOperationException("Math model is invalid.");
        }

        if (!MathGovernanceValidator.Validate(paytable).IsValid)
        {
            throw new InvalidOperationException("Paytable is invalid.");
        }
    }

    private static PrizeFacts EvaluatePrizeFacts(
        IReadOnlyDictionary<string, object?> wagerPayload,
        IReadOnlyDictionary<string, object?> outcomePayload,
        PaytableDefinitionV1 paytable)
    {
        var selectedNumbers = ReadIntegerSet(wagerPayload, "numbers");
        var drawnNumbers = ReadIntegerSet(outcomePayload, "numbers");
        var matchCount = selectedNumbers.Intersect(drawnNumbers).Count();
        var prizeRow = paytable.PrizeMatrixRows
            .OrderByDescending(row => ReadConditionInteger(row.Conditions, "matchCount") ?? -1)
            .FirstOrDefault(row => ReadConditionInteger(row.Conditions, "matchCount") == matchCount);

        if (prizeRow is null)
        {
            return new PrizeFacts(
                PrizeOutcome.Loss,
                "NO_PRIZE",
                0m,
                0m,
                new SortedDictionary<string, object?>
                {
                    ["matchCount"] = matchCount,
                    ["selectedNumbers"] = selectedNumbers,
                    ["drawnNumbers"] = drawnNumbers
                });
        }

        return new PrizeFacts(
            PrizeOutcome.Win,
            prizeRow.PrizeCode,
            prizeRow.Multiplier,
            prizeRow.PayoutValue,
            new SortedDictionary<string, object?>
            {
                ["matchCount"] = matchCount,
                ["selectedNumbers"] = selectedNumbers,
                ["drawnNumbers"] = drawnNumbers
            });
    }

    private static string CanonicalizePrizeFacts(PrizeFacts prizeFacts)
    {
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["multiplier"] = prizeFacts.Multiplier,
            ["outcome"] = prizeFacts.Outcome.ToString(),
            ["outcomeDerivedFacts"] = prizeFacts.OutcomeDerivedFacts,
            ["payoutUnits"] = prizeFacts.PayoutUnits,
            ["prizeTier"] = prizeFacts.PrizeTier
        };

        return JsonSerializer.Serialize(payload);
    }

    private static IReadOnlyCollection<int> ReadIntegerSet(IReadOnlyDictionary<string, object?> payload, string key)
    {
        if (!payload.TryGetValue(key, out var value) || value is null)
        {
            return [];
        }

        if (value is int[] intArray)
        {
            return intArray;
        }

        if (value is IReadOnlyCollection<int> intCollection)
        {
            return intCollection;
        }

        if (value is IEnumerable<object> objectValues)
        {
            return objectValues.Select(Convert.ToInt32).ToArray();
        }

        return [];
    }

    private static int? ReadConditionInteger(IReadOnlyDictionary<string, object?> conditions, string key)
    {
        return conditions.TryGetValue(key, out var value) && value is not null
            ? Convert.ToInt32(value)
            : null;
    }

    private static Guid DeterministicGuid(string value)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(hash[..16]);
    }

    private static void RequireText(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"{field} is required.", field);
        }
    }
}
