using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SettlementService.Contracts;
using SettlementService.Infrastructure;

namespace SettlementService.Application;

public sealed record SettlementComputation(
    Guid SettlementId,
    string CanonicalSettlementHash,
    long GrossPayoutAmountMinor,
    long NetResultAmountMinor,
    string SettlementOutcome,
    IReadOnlyDictionary<string, object?> Provenance);

public sealed class SettlementExecutionService(SettlementExecutionRepository repository)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    public async Task<SettlementExecutionResult> ExecuteAsync(
        SettlementExecutionRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (request.Mode != SettlementExecutionMode.DryRun)
        {
            throw new SettlementExecutionValidationException(["Production settlement execution is disabled; mode must be DryRun."]);
        }

        var settlementRequest = await repository.GetSettlementRequestAsync(request.SettlementRequestId, cancellationToken)
            ?? throw new SettlementExecutionValidationException(["SettlementInput ingestion request was not found."]);

        if (!string.Equals(settlementRequest.IdempotencyKey, request.IdempotencyKey, StringComparison.Ordinal))
        {
            throw new SettlementExecutionValidationException(["Settlement execution idempotency key does not match the ingestion request."]);
        }

        var computation = ComputeSettlement(settlementRequest);
        return await repository.CompleteAsync(settlementRequest, computation, correlationId, cancellationToken);
    }

    public async Task<SettlementExecutionResult> ReplayAsync(
        SettlementReplayRequest request,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var settlementRequest = await repository.GetSettlementRequestAsync(request.SettlementRequestId, cancellationToken)
            ?? throw new SettlementExecutionValidationException(["SettlementInput ingestion request was not found."]);
        var existing = await repository.GetRecordByRequestIdAsync(request.SettlementRequestId, cancellationToken)
            ?? throw new SettlementExecutionValidationException(["SettlementRecord was not found for replay."]);
        var computed = ComputeSettlement(settlementRequest);

        if (!string.Equals(existing.CanonicalSettlementHash, computed.CanonicalSettlementHash, StringComparison.Ordinal) ||
            existing.GrossPayoutAmountMinor != computed.GrossPayoutAmountMinor ||
            existing.NetResultAmountMinor != computed.NetResultAmountMinor ||
            !string.Equals(existing.SettlementOutcome, computed.SettlementOutcome, StringComparison.Ordinal))
        {
            return await repository.AppendReplayMismatchAsync(settlementRequest.SettlementRequestId, computed.CanonicalSettlementHash, correlationId, cancellationToken);
        }

        return await repository.AppendReplayVerifiedAsync(existing, correlationId, cancellationToken);
    }

    public Task<SettlementExecutionReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        return repository.CheckReadinessAsync(cancellationToken);
    }

    public static SettlementComputation ComputeSettlement(SettlementRequestExecutionContext request)
    {
        var outcome = NormalizeOutcome(request.StoredSettlementInput.EvaluationOutcome);
        var grossPayout = outcome switch
        {
            "WIN" => ComputeWinPayout(request.AcceptedStakeAmountMinor, request.StoredSettlementInput.PayoutUnits, request.StoredSettlementInput.Multiplier),
            "LOSS" => 0,
            "PUSH" => request.AcceptedStakeAmountMinor,
            "VOID" => request.AcceptedStakeAmountMinor,
            "REJECTED" => 0,
            _ => throw new SettlementExecutionValidationException([$"Unsupported SettlementInput outcome {request.StoredSettlementInput.EvaluationOutcome}."])
        };
        var netResult = grossPayout - request.AcceptedStakeAmountMinor;
        var settlementId = CreateDeterministicGuid($"{request.SettlementRequestId:N}:{request.CanonicalRequestHash}:{outcome}");
        var provenance = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["financialPosting"] = "disabled",
            ["mathEvaluationCertificateHash"] = request.MathEvaluationCertificateHash,
            ["outcomeCertificateHash"] = request.OutcomeCertificateHash,
            ["policyVersion"] = request.SettlementPolicyVersion,
            ["prizeFactsHash"] = request.StoredSettlementInput.PrizeFactsHash,
            ["settlementInputHash"] = request.SettlementInputHash,
            ["settlementRequestHash"] = request.CanonicalRequestHash
        };
        var canonicalHash = BuildCanonicalSettlementHash(
            request,
            settlementId,
            grossPayout,
            netResult,
            outcome,
            provenance);

        return new SettlementComputation(
            settlementId,
            canonicalHash,
            grossPayout,
            netResult,
            outcome,
            provenance);
    }

    private static long ComputeWinPayout(long stakeAmountMinor, decimal payoutUnits, decimal multiplier)
    {
        if (payoutUnits > 0)
        {
            return checked(stakeAmountMinor + DecimalToMinorUnits(payoutUnits));
        }

        if (multiplier <= 0)
        {
            throw new SettlementExecutionValidationException(["WIN SettlementInput requires positive payoutUnits or multiplier."]);
        }

        return DecimalToMinorUnits(stakeAmountMinor * multiplier);
    }

    private static long DecimalToMinorUnits(decimal value)
    {
        return checked((long)Math.Round(value, 0, MidpointRounding.AwayFromZero));
    }

    private static string BuildCanonicalSettlementHash(
        SettlementRequestExecutionContext request,
        Guid settlementId,
        long grossPayout,
        long netResult,
        string outcome,
        IReadOnlyDictionary<string, object?> provenance)
    {
        var payload = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["currency"] = request.Currency,
            ["grossPayoutAmountMinor"] = grossPayout,
            ["idempotencyKey"] = request.IdempotencyKey,
            ["mathEvaluationCertificateHash"] = request.MathEvaluationCertificateHash,
            ["minorUnitPrecision"] = request.MinorUnitPrecision,
            ["netResultAmountMinor"] = netResult,
            ["outcomeCertificateHash"] = request.OutcomeCertificateHash,
            ["playerAccountReference"] = request.PlayerAccountReference,
            ["policyVersion"] = request.SettlementPolicyVersion,
            ["provenance"] = provenance,
            ["settlementId"] = settlementId,
            ["settlementInputHash"] = request.SettlementInputHash,
            ["settlementInputId"] = request.SettlementInputId,
            ["settlementOutcome"] = outcome,
            ["settlementRequestId"] = request.SettlementRequestId,
            ["stakeAmountMinor"] = request.AcceptedStakeAmountMinor,
            ["ticketId"] = request.TicketId,
            ["ticketLineId"] = request.TicketLineId
        };

        return HashCanonical(JsonSerializer.Serialize(payload, JsonOptions));
    }

    public static string HashCanonical(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private static string NormalizeOutcome(string outcome)
    {
        return outcome.ToUpperInvariant();
    }

    private static Guid CreateDeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes[..16]);
    }
}

public sealed class SettlementExecutionValidationException(IReadOnlyList<string> errors)
    : Exception(string.Join(" ", errors))
{
    public IReadOnlyList<string> Errors { get; } = errors;
}

public sealed class SettlementExecutionConflictException(string message)
    : Exception(message);
