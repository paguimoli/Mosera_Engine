using System.Net.Http.Json;
using System.Text.Json;
using SettlementService.Application;
using SettlementService.Configuration;
using SettlementService.Contracts;

namespace SettlementService.Infrastructure;

public sealed class SettlementCreditWalletServiceClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly IHttpClientFactory httpClientFactory;
    private readonly ServiceConfiguration configuration;

    public SettlementCreditWalletServiceClient(
        IHttpClientFactory httpClientFactory,
        ServiceConfiguration configuration)
    {
        this.httpClientFactory = httpClientFactory;
        this.configuration = configuration;
    }

    public bool Configured => !string.IsNullOrWhiteSpace(configuration.Integrations.CreditServiceUrl);

    public async Task<SettlementTargetServiceReadiness> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        if (!Configured)
        {
            return new SettlementTargetServiceReadiness(
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                null,
                ["Credit Wallet Service URL is not configured."]);
        }

        try
        {
            var client = httpClientFactory.CreateClient();
            client.BaseAddress = new Uri(NormalizeBaseUrl(configuration.Integrations.CreditServiceUrl));
            using var response = await client.GetAsync("/v1/credit-wallets/health", cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                return new SettlementTargetServiceReadiness(
                    true,
                    true,
                    false,
                    false,
                    false,
                    false,
                    false,
                    null,
                    [$"Credit Wallet Service readiness failed with status {(int)response.StatusCode}."]);
            }

            using var document = JsonDocument.Parse(body);
            var capabilities = document.RootElement.GetProperty("capabilities");
            var marker = capabilities.TryGetProperty("qaCapabilityMarker", out var markerElement) &&
                markerElement.ValueKind == JsonValueKind.String
                    ? markerElement.GetString()
                    : null;

            var ready = GetString(document.RootElement, "status") == "ok";
            var mutation = GetBool(capabilities, "mutationCapabilityEnabled");
            var durable = GetBool(capabilities, "durablePersistenceConfigured");
            var idempotency = GetBool(capabilities, "idempotencySupportConfigured");
            var qaMarker = !string.IsNullOrWhiteSpace(marker);
            var blockers = new List<string>();
            if (!ready) blockers.Add("Credit Wallet Service readiness status is not ok.");
            if (!mutation) blockers.Add("Credit Wallet Service mutation capability is not enabled.");
            if (!durable) blockers.Add("Credit Wallet Service durable persistence is not configured.");
            if (!idempotency) blockers.Add("Credit Wallet Service idempotency support is not configured.");
            if (!qaMarker) blockers.Add("Credit Wallet Service QA capability marker is missing.");

            return new SettlementTargetServiceReadiness(
                true,
                true,
                ready,
                mutation,
                durable,
                idempotency,
                qaMarker,
                marker,
                blockers);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or JsonException or InvalidOperationException)
        {
            return new SettlementTargetServiceReadiness(
                true,
                false,
                false,
                false,
                false,
                false,
                false,
                null,
                [$"Credit Wallet Service readiness check failed: {error.Message}"]);
        }
    }

    public async Task<(SettlementExternalReferenceDto Reference, string ResponseHash)> ExecuteFinancialInstructionAsync(
        FinancialInstructionExecutionContext context,
        Guid playerId,
        Guid reservationId,
        string targetIdempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        if (!Configured)
        {
            throw new SettlementIntegrationException("Credit Wallet Service URL is not configured.");
        }

        if (context.Instruction.InstructionType == FinancialInstructionType.CREDIT_NOOP)
        {
            return (new SettlementExternalReferenceDto(
                context.SettlementRecord.SettlementId.ToString(),
                context.SettlementRecord.TicketId,
                context.SettlementRecord.TicketLineId,
                "credit_noop",
                "SKIPPED",
                targetIdempotencyKey,
                "SKIPPED"), "sha256:noop");
        }

        return context.Instruction.InstructionType switch
        {
            FinancialInstructionType.CREDIT_APPLY or FinancialInstructionType.CREDIT_REFUND =>
                await SettleFinancialInstructionAsync(context, playerId, reservationId, targetIdempotencyKey, correlationId, cancellationToken),
            FinancialInstructionType.CREDIT_RELEASE =>
                await ReleaseFinancialInstructionAsync(context, playerId, reservationId, targetIdempotencyKey, correlationId, cancellationToken),
            _ => throw new SettlementIntegrationException($"Instruction {context.Instruction.InstructionType} is not a Credit Wallet instruction.")
        };
    }

    private async Task<(SettlementExternalReferenceDto Reference, string ResponseHash)> SettleFinancialInstructionAsync(
        FinancialInstructionExecutionContext context,
        Guid playerId,
        Guid reservationId,
        string targetIdempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var record = context.SettlementRecord;
        var reservation = await GetReservationContextAsync(reservationId, correlationId, cancellationToken);
        if (reservation.PlayerId != playerId)
        {
            throw new SettlementIntegrationException("Credit reservation player does not match Settlement instruction player.");
        }

        var role = GetProvenanceString(context.Instruction.Provenance, "resettlementRole");
        var originalSettlementId = ParseOptionalGuid(
            GetProvenanceString(context.Instruction.Provenance, "originalSettlementId"));
        WalletSettlementTrace? trace = null;
        if (role is "reversal" or "corrected")
        {
            if (originalSettlementId is null)
            {
                throw new SettlementIntegrationException("Resettlement instruction is missing originalSettlementId provenance.");
            }
            trace = await GetSettlementTraceAsync(originalSettlementId.Value, correlationId, cancellationToken);
        }

        var operation = role == "reversal" ? "REVERSE" : "SETTLE";
        var captureAmount = record.StakeAmountMinor;
        var balanceImpact = record.NetResultAmountMinor == 0 ? record.GrossPayoutAmountMinor : record.NetResultAmountMinor;
        if (balanceImpact == 0)
        {
            balanceImpact = record.GrossPayoutAmountMinor;
        }
        var ledgerInstructionId = context.LedgerInstructionId
            ?? throw new SettlementIntegrationException("Credit instruction is missing its preceding Ledger instruction reference.");
        var ledgerPostingRequired = context.LedgerInstructionType != FinancialInstructionType.LEDGER_NOOP;

        var client = httpClientFactory.CreateClient();
        client.BaseAddress = new Uri(NormalizeBaseUrl(configuration.Integrations.CreditServiceUrl));
        using var request = new HttpRequestMessage(HttpMethod.Post, "/v1/credit-wallets/internal/operations");
        AddInternalHeaders(request, targetIdempotencyKey, correlationId);
        request.Content = JsonContent.Create(new
        {
            requestId = context.Instruction.InstructionId,
            reservation.TenantId,
            reservation.BrandId,
            reservation.PlayerId,
            reservation.WalletId,
            instrument = reservation.Instrument,
            operation,
            money = new { amount = captureAmount, currency = reservation.Currency },
            balanceImpact = new { amount = balanceImpact, currency = reservation.Currency },
            authority = "settlement-service",
            effectiveAt = context.Instruction.CreatedAt,
            ticketId = ToGuid(record.TicketId, "ticketId"),
            reservationId,
            settlementId = record.SettlementId,
            settlementBatchId = record.SettlementRequestId,
            settlementInstructionId = context.Instruction.InstructionId,
            settlementInstructionSequence = context.Instruction.InstructionSequence,
            settlementInstructionHash = context.Instruction.CanonicalPayloadHash,
            settlementVersion = record.PolicyVersion,
            settlementHash = record.CanonicalSettlementHash,
            settlementOutcome = record.SettlementOutcome == "REJECTED" ? "VOID" : record.SettlementOutcome,
            ledgerInstructionId,
            ledgerPostingRequired,
            originalOperationId = role == "reversal" ? trace?.OriginalOperationId : null,
            correctsOperationId = role == "corrected" ? trace?.ReversalOperationId : null,
            reasonCode = role == "reversal" ? "authoritative_settlement_reversal" : null,
            sourceService = "settlement-service",
            auditMetadata = new Dictionary<string, object?>
            {
                ["settlementId"] = record.SettlementId,
                ["settlementRequestId"] = record.SettlementRequestId,
                ["instructionId"] = context.Instruction.InstructionId,
                ["instructionType"] = context.Instruction.InstructionType.ToString(),
                ["canonicalPayloadHash"] = context.Instruction.CanonicalPayloadHash
            }
        }, options: JsonOptions);

        using var response = await client.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new SettlementIntegrationException(
                $"Credit Wallet Service rejected financial instruction. StatusCode={(int)response.StatusCode}. Body={body}");
        }

        using var document = JsonDocument.Parse(body);
        var settlementApplicationId = document.RootElement.GetProperty("effectReferenceId").GetString()
            ?? throw new SettlementIntegrationException("Credit Wallet Service response did not include effectReferenceId.");

        return (new SettlementExternalReferenceDto(
            record.SettlementId.ToString(),
            record.TicketId,
            record.TicketLineId,
            "credit_settlement_application",
            settlementApplicationId,
            targetIdempotencyKey,
            "POSTED"), FinancialInstructionService.HashCanonical(body));
    }

    private async Task<(SettlementExternalReferenceDto Reference, string ResponseHash)> ReleaseFinancialInstructionAsync(
        FinancialInstructionExecutionContext context,
        Guid playerId,
        Guid reservationId,
        string targetIdempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var record = context.SettlementRecord;
        var reservation = await GetReservationContextAsync(reservationId, correlationId, cancellationToken);
        if (reservation.PlayerId != playerId)
        {
            throw new SettlementIntegrationException("Credit reservation player does not match Settlement release instruction player.");
        }
        var client = httpClientFactory.CreateClient();
        client.BaseAddress = new Uri(NormalizeBaseUrl(configuration.Integrations.CreditServiceUrl));
        using var request = new HttpRequestMessage(HttpMethod.Post, "/v1/credit-wallets/internal/operations");
        AddInternalHeaders(request, targetIdempotencyKey, correlationId);
        request.Content = JsonContent.Create(new
        {
            requestId = context.Instruction.InstructionId,
            reservation.TenantId,
            reservation.BrandId,
            reservation.PlayerId,
            reservation.WalletId,
            instrument = reservation.Instrument,
            operation = "RELEASE",
            money = new { amount = record.StakeAmountMinor, currency = reservation.Currency },
            balanceImpact = (object?)null,
            authority = "settlement-service",
            effectiveAt = context.Instruction.CreatedAt,
            reservationId,
            ticketId = ToGuid(record.TicketId, "ticketId"),
            reasonCode = "settlement_instruction_release",
            sourceService = "settlement-service",
            auditMetadata = new Dictionary<string, object?>
            {
                ["settlementId"] = record.SettlementId,
                ["instructionId"] = context.Instruction.InstructionId,
                ["instructionType"] = context.Instruction.InstructionType.ToString()
            }
        }, options: JsonOptions);

        using var response = await client.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new SettlementIntegrationException(
                $"Credit Wallet Service rejected financial release instruction. StatusCode={(int)response.StatusCode}. Body={body}");
        }

        using var document = JsonDocument.Parse(body);
        var reservationReference = document.RootElement.GetProperty("effectReferenceId").GetString()
            ?? reservationId.ToString();

        return (new SettlementExternalReferenceDto(
            record.SettlementId.ToString(),
            record.TicketId,
            record.TicketLineId,
            "credit_reservation_release",
            reservationReference,
            targetIdempotencyKey,
            "POSTED"), FinancialInstructionService.HashCanonical(body));
    }

    public async Task<SettlementExternalReferenceDto> ApplySettlementAsync(
        SettlementRecordDto record,
        SettlementExecutionTicketLineRequest line,
        string idempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        if (!Configured)
        {
            throw new SettlementIntegrationException("Credit Wallet Service URL is not configured.");
        }

        if (line.CreditPlayerId is null || line.CreditReservationId is null)
        {
            return new SettlementExternalReferenceDto(
                record.Id,
                record.TicketId,
                record.TicketLineId,
                "credit_settlement",
                "SKIPPED",
                idempotencyKey,
                "SKIPPED");
        }

        var settlementId = line.CreditSettlementId ?? CreateDeterministicGuid(record.Id);
        var settlementBatchId = line.CreditSettlementBatchId ?? CreateDeterministicGuid(record.SettlementRunId);
        var releaseAmount = record.Stake;
        var balanceImpact = record.NetAmount == 0 ? record.Payout : record.NetAmount;
        if (balanceImpact == 0)
        {
            balanceImpact = record.Payout;
        }

        var client = httpClientFactory.CreateClient();
        client.BaseAddress = new Uri(NormalizeBaseUrl(configuration.Integrations.CreditServiceUrl));
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"/v1/credit-wallets/{line.CreditPlayerId.Value}/settle");
        request.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
        request.Headers.TryAddWithoutValidation("x-correlation-id", correlationId);
        request.Content = JsonContent.Create(new
        {
            settlementId,
            settlementBatchId,
            reservationId = line.CreditReservationId.Value,
            ticketId = ToGuid(record.TicketId, "ticketId"),
            releaseAmount = new
            {
                amount = ToMinorAmount(releaseAmount),
                currency = "USD"
            },
            balanceImpact = new
            {
                amount = ToMinorAmount(balanceImpact),
                currency = "USD"
            },
            outcome = record.Outcome.ToUpperInvariant(),
            sourceService = "settlement-service",
            metadata = new Dictionary<string, object?>
            {
                ["settlementRunId"] = record.SettlementRunId,
                ["settlementRecordId"] = record.Id,
                ["integrationMode"] = "DRY_RUN",
                ["authoritativeSettlement"] = false
            }
        }, options: JsonOptions);

        using var response = await client.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new SettlementIntegrationException(
                $"Credit Wallet Service rejected settlement application. StatusCode={(int)response.StatusCode}. Body={body}");
        }

        using var document = JsonDocument.Parse(body);
        var settlementApplicationId = document.RootElement.GetProperty("settlementApplicationId").GetString()
            ?? throw new SettlementIntegrationException("Credit Wallet Service response did not include settlementApplicationId.");

        return new SettlementExternalReferenceDto(
            record.Id,
            record.TicketId,
            record.TicketLineId,
            "credit_settlement_application",
            settlementApplicationId,
            idempotencyKey,
            "APPLIED_DRY_RUN");
    }

    private static Guid ToGuid(string value, string fieldName)
    {
        return Guid.TryParse(value, out var parsed)
            ? parsed
            : throw new SettlementIntegrationException($"{fieldName} must be a GUID for Credit Wallet integration.");
    }

    private async Task<WalletReservationContext> GetReservationContextAsync(
        Guid reservationId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var client = httpClientFactory.CreateClient();
        client.BaseAddress = new Uri(NormalizeBaseUrl(configuration.Integrations.CreditServiceUrl));
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"/v1/credit-wallets/internal/reservations/{reservationId}/settlement-context");
        AddInternalHeaders(request, null, correlationId);
        using var response = await client.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new SettlementIntegrationException(
                $"Credit Wallet reservation context lookup failed with status {(int)response.StatusCode}.");
        }
        return await response.Content.ReadFromJsonAsync<WalletReservationContext>(JsonOptions, cancellationToken)
            ?? throw new SettlementIntegrationException("Credit Wallet reservation context response was empty.");
    }

    private async Task<WalletSettlementTrace> GetSettlementTraceAsync(
        Guid settlementId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        var client = httpClientFactory.CreateClient();
        client.BaseAddress = new Uri(NormalizeBaseUrl(configuration.Integrations.CreditServiceUrl));
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"/v1/credit-wallets/internal/settlements/{settlementId}/operation-trace");
        AddInternalHeaders(request, null, correlationId);
        using var response = await client.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new SettlementIntegrationException(
                $"Original Credit Wallet settlement trace lookup failed with status {(int)response.StatusCode}.");
        }
        return await response.Content.ReadFromJsonAsync<WalletSettlementTrace>(JsonOptions, cancellationToken)
            ?? throw new SettlementIntegrationException("Credit Wallet settlement trace response was empty.");
    }

    private void AddInternalHeaders(HttpRequestMessage request, string? idempotencyKey, string correlationId)
    {
        if (string.IsNullOrWhiteSpace(configuration.Integrations.CreditWalletInternalApiKey))
        {
            throw new SettlementIntegrationException("Credit Wallet internal authentication key is not configured.");
        }
        request.Headers.TryAddWithoutValidation("x-internal-service-name", "settlement-service");
        request.Headers.TryAddWithoutValidation(
            "Authorization", $"Bearer {configuration.Integrations.CreditWalletInternalApiKey}");
        request.Headers.TryAddWithoutValidation("x-correlation-id", correlationId);
        if (!string.IsNullOrWhiteSpace(idempotencyKey))
        {
            request.Headers.TryAddWithoutValidation("Idempotency-Key", idempotencyKey);
        }
    }

    private static string? GetProvenanceString(
        IReadOnlyDictionary<string, object?> provenance,
        string key)
    {
        if (!provenance.TryGetValue(key, out var value) || value is null) return null;
        return value is JsonElement element ? element.ToString() : value.ToString();
    }

    private static Guid? ParseOptionalGuid(string? value) =>
        Guid.TryParse(value, out var parsed) ? parsed : null;

    private static Guid CreateDeterministicGuid(string value)
    {
        var bytes = System.Security.Cryptography.MD5.HashData(System.Text.Encoding.UTF8.GetBytes(value));
        return new Guid(bytes);
    }

    private static long ToMinorAmount(decimal amount)
    {
        return decimal.ToInt64(decimal.Round(amount, 0, MidpointRounding.AwayFromZero));
    }

    private static string NormalizeBaseUrl(string value)
    {
        return value.Trim().TrimEnd('/');
    }

    private sealed record WalletReservationContext(
        Guid ReservationId,
        Guid TenantId,
        Guid BrandId,
        Guid PlayerId,
        Guid WalletId,
        string Instrument,
        string Currency,
        Guid TicketId,
        string Status,
        long RemainingExposure,
        long CapturedAmount);

    private sealed record WalletSettlementTrace(
        Guid OriginalSettlementId,
        Guid OriginalOperationId,
        Guid OriginalApplicationId,
        Guid? ReversalOperationId,
        Guid? ReversalApplicationId);

    private static bool GetBool(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.True;
    }

    private static string? GetString(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;
    }
}
