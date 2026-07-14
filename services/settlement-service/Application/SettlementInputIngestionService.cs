using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SettlementService.Contracts;
using SettlementService.Infrastructure;

namespace SettlementService.Application;

public sealed record SettlementInputIngestionClaim(
    SettlementInputIngestionRequest Request,
    string CanonicalRequestHash,
    StoredSettlementInputDto StoredSettlementInput);

public sealed class SettlementInputIngestionService(SettlementInputIngestionRepository repository)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    private static readonly HashSet<string> SupportedOutcomes = new(StringComparer.OrdinalIgnoreCase)
    {
        "WIN",
        "LOSS",
        "PUSH",
        "VOID",
        "REJECTED",
        "Win",
        "Loss",
        "Push",
        "Void",
        "Rejected"
    };

    public async Task<SettlementIngestionResult> IngestAsync(
        SettlementInputIngestionRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var storedInput = await repository.GetSettlementInputAsync(
            request.SettlementInputId,
            cancellationToken)
            ?? throw new SettlementInputIngestionValidationException(["SettlementInput was not found."]);
        var validation = Validate(request, storedInput);
        if (!validation.IsValid)
        {
            throw new SettlementInputIngestionValidationException(validation.Errors);
        }

        var canonicalRequestHash = BuildCanonicalRequestHash(request);
        var claim = new SettlementInputIngestionClaim(request, canonicalRequestHash, storedInput);
        var result = await repository.ClaimAsync(claim, correlationId, cancellationToken);
        return result;
    }

    public Task<SettlementIngestionReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        return repository.CheckReadinessAsync(cancellationToken);
    }

    public SettlementIngestionValidationResult Validate(
        SettlementInputIngestionRequest request,
        StoredSettlementInputDto storedInput)
    {
        var errors = new List<string>();
        RequireText(request.IdempotencyKey, "idempotencyKey", errors);
        RequireText(request.TicketId, "ticketId", errors);
        RequireText(request.TicketLineId, "ticketLineId", errors);
        RequireText(request.PlayerAccountReference, "playerAccountReference", errors);
        RequireText(request.AcceptedWagerFinancialContextReference, "acceptedWagerFinancialContextReference", errors);
        RequireText(request.RoundingPolicyReference, "roundingPolicyReference", errors);
        RequireText(request.SettlementPolicyVersion, "settlementPolicyVersion", errors);
        RequireHash(request.SettlementInputHash, "settlementInputHash", errors);
        RequireHash(request.MathEvaluationCertificateHash, "mathEvaluationCertificateHash", errors);
        RequireHash(request.OutcomeCertificateHash, "outcomeCertificateHash", errors);

        if (request.Mode != SettlementIngestionMode.DryRun)
        {
            errors.Add("Production settlement ingestion is disabled; mode must be DryRun.");
        }

        if (request.AcceptedWagerFinancialContext is null)
        {
            errors.Add("acceptedWagerFinancialContext is required.");
            return new SettlementIngestionValidationResult(false, errors);
        }

        if (request.SettlementPolicy is null)
        {
            errors.Add("settlementPolicy is required.");
            return new SettlementIngestionValidationResult(false, errors);
        }

        if (request.AcceptedStakeAmountMinor < 0)
        {
            errors.Add("acceptedStakeAmountMinor must be non-negative.");
        }

        if (!IsValidCurrency(request.Currency))
        {
            errors.Add("currency must be a three-letter uppercase ISO-4217 code.");
        }

        if (request.MinorUnitPrecision is < 0 or > 6)
        {
            errors.Add("minorUnitPrecision must be between 0 and 6.");
        }

        if (!IsVersionedReference(request.RoundingPolicyReference))
        {
            errors.Add("roundingPolicyReference must be versioned.");
        }

        if (!IsVersionedReference(request.SettlementPolicyVersion))
        {
            errors.Add("settlementPolicyVersion must be explicit and versioned.");
        }

        ValidateStoredSettlementInput(request, storedInput, errors);
        ValidateFinancialContext(request, errors);

        return new SettlementIngestionValidationResult(errors.Count == 0, errors);
    }

    public static string BuildCanonicalRequestHash(SettlementInputIngestionRequest request)
    {
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["acceptedStakeAmountMinor"] = request.AcceptedStakeAmountMinor,
            ["acceptedWagerFinancialContextReference"] = request.AcceptedWagerFinancialContextReference,
            ["creditReservationReference"] = request.CreditReservationReference,
            ["currency"] = request.Currency,
            ["mode"] = request.Mode.ToString(),
            ["minorUnitPrecision"] = request.MinorUnitPrecision,
            ["playerAccountReference"] = request.PlayerAccountReference,
            ["roundingPolicyReference"] = request.RoundingPolicyReference,
            ["settlementInputHash"] = request.SettlementInputHash,
            ["settlementInputId"] = request.SettlementInputId,
            ["settlementPolicyVersion"] = request.SettlementPolicyVersion,
            ["ticketId"] = request.TicketId,
            ["ticketLineId"] = request.TicketLineId
        };

        return HashCanonical(JsonSerializer.Serialize(payload, JsonOptions));
    }

    public static string HashCanonical(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private static void ValidateStoredSettlementInput(
        SettlementInputIngestionRequest request,
        StoredSettlementInputDto storedInput,
        List<string> errors)
    {
        if (!string.Equals(storedInput.SettlementInputHash, request.SettlementInputHash, StringComparison.Ordinal))
        {
            errors.Add("SettlementInput hash mismatch.");
        }

        if (storedInput.MathEvaluationCertificateId != request.MathEvaluationCertificateId ||
            !string.Equals(storedInput.MathEvaluationCertificateHash, request.MathEvaluationCertificateHash, StringComparison.Ordinal))
        {
            errors.Add("Math Evaluation Certificate reference/hash mismatch.");
        }

        if (storedInput.OutcomeCertificateId != request.OutcomeCertificateId ||
            !string.Equals(storedInput.OutcomeCertificateHash, request.OutcomeCertificateHash, StringComparison.Ordinal))
        {
            errors.Add("Outcome Certificate reference/hash mismatch.");
        }

        RequireHash(storedInput.GameManifestHash, "stored Game Manifest hash", errors);
        RequireHash(storedInput.MathModelHash, "stored Math Model hash", errors);
        RequireHash(storedInput.PaytableHash, "stored Paytable hash", errors);
        RequireHash(storedInput.PrizeFactsHash, "stored PrizeFacts hash", errors);
        RequireText(storedInput.EvaluatorVersion, "stored evaluatorVersion", errors);

        if (!SupportedOutcomes.Contains(storedInput.EvaluationOutcome))
        {
            errors.Add("SettlementInput evaluation outcome is not supported.");
        }

        if (!TicketReferenceMatches(storedInput.TicketReference, request.TicketId, request.TicketLineId))
        {
            errors.Add("SettlementInput ticket/wager reference does not match the accepted financial context.");
        }
    }

    private static void ValidateFinancialContext(
        SettlementInputIngestionRequest request,
        List<string> errors)
    {
        var context = request.AcceptedWagerFinancialContext;
        if (!string.Equals(context.ContextReference, request.AcceptedWagerFinancialContextReference, StringComparison.Ordinal))
        {
            errors.Add("acceptedWagerFinancialContext.reference mismatch.");
        }

        if (!string.Equals(context.TicketId, request.TicketId, StringComparison.Ordinal))
        {
            errors.Add("acceptedWagerFinancialContext.ticketId mismatch.");
        }

        if (!string.Equals(context.TicketLineId, request.TicketLineId, StringComparison.Ordinal))
        {
            errors.Add("acceptedWagerFinancialContext.ticketLineId mismatch.");
        }

        if (!string.Equals(context.PlayerAccountReference, request.PlayerAccountReference, StringComparison.Ordinal))
        {
            errors.Add("acceptedWagerFinancialContext.playerAccountReference mismatch.");
        }

        if (context.AcceptedStakeAmountMinor != request.AcceptedStakeAmountMinor)
        {
            errors.Add("acceptedWagerFinancialContext.acceptedStakeAmountMinor mismatch.");
        }

        if (!string.Equals(context.Currency, request.Currency, StringComparison.Ordinal))
        {
            errors.Add("acceptedWagerFinancialContext.currency mismatch.");
        }

        if (context.MinorUnitPrecision != request.MinorUnitPrecision)
        {
            errors.Add("acceptedWagerFinancialContext.minorUnitPrecision mismatch.");
        }

        if (!string.Equals(context.RoundingPolicyReference, request.RoundingPolicyReference, StringComparison.Ordinal))
        {
            errors.Add("acceptedWagerFinancialContext.roundingPolicyReference mismatch.");
        }

        if (context.AcceptedAt != request.AcceptedAt)
        {
            errors.Add("acceptedWagerFinancialContext.acceptedAt mismatch.");
        }

        var contextReservation = context.CreditReservationReference;
        if (contextReservation is null && !string.IsNullOrWhiteSpace(request.CreditReservationReference))
        {
            errors.Add("creditReservationReference was supplied without matching accepted context reservation.");
        }

        if (contextReservation is not null)
        {
            if (!string.Equals(contextReservation.ReservationId, request.CreditReservationReference, StringComparison.Ordinal))
            {
                errors.Add("creditReservationReference mismatch.");
            }

            if (!string.Equals(contextReservation.PlayerAccountReference, request.PlayerAccountReference, StringComparison.Ordinal) ||
                !string.Equals(contextReservation.TicketId, request.TicketId, StringComparison.Ordinal) ||
                !string.Equals(contextReservation.TicketLineId, request.TicketLineId, StringComparison.Ordinal))
            {
                errors.Add("creditReservationReference scope mismatch.");
            }
        }

        if (!string.Equals(request.SettlementPolicy.Version, request.SettlementPolicyVersion, StringComparison.Ordinal))
        {
            errors.Add("settlementPolicy.version mismatch.");
        }
    }

    private static bool TicketReferenceMatches(string ticketReference, string ticketId, string ticketLineId)
    {
        return string.Equals(ticketReference, ticketLineId, StringComparison.Ordinal) ||
            string.Equals(ticketReference, ticketId, StringComparison.Ordinal) ||
            string.Equals(ticketReference, $"{ticketId}:{ticketLineId}", StringComparison.Ordinal);
    }

    private static bool IsVersionedReference(string value)
    {
        return !string.IsNullOrWhiteSpace(value) &&
            value.Contains(':', StringComparison.Ordinal) &&
            !value.EndsWith(':');
    }

    private static bool IsValidCurrency(string value)
    {
        return value.Length == 3 && value.All(character => character is >= 'A' and <= 'Z');
    }

    private static void RequireText(string? value, string field, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            errors.Add($"{field} is required.");
        }
    }

    private static void RequireHash(string? value, string field, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(value) || !value.StartsWith("sha256:", StringComparison.Ordinal))
        {
            errors.Add($"{field} must be a sha256 hash.");
        }
    }
}

public sealed class SettlementInputIngestionValidationException(IReadOnlyList<string> errors)
    : Exception(string.Join(" ", errors))
{
    public IReadOnlyList<string> Errors { get; } = errors;
}

public sealed class SettlementInputIngestionConflictException(string message)
    : Exception(message);
