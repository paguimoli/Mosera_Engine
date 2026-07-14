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
        var settlementId = CreateDeterministicGuid(context.Instruction.InstructionId.ToString());
        var settlementBatchId = CreateDeterministicGuid(record.SettlementRequestId.ToString());
        var releaseAmount = record.StakeAmountMinor;
        var balanceImpact = record.NetResultAmountMinor == 0 ? record.GrossPayoutAmountMinor : record.NetResultAmountMinor;
        if (balanceImpact == 0)
        {
            balanceImpact = record.GrossPayoutAmountMinor;
        }

        var client = httpClientFactory.CreateClient();
        client.BaseAddress = new Uri(NormalizeBaseUrl(configuration.Integrations.CreditServiceUrl));
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/v1/credit-wallets/{playerId}/settle");
        request.Headers.TryAddWithoutValidation("Idempotency-Key", targetIdempotencyKey);
        request.Headers.TryAddWithoutValidation("x-correlation-id", correlationId);
        request.Content = JsonContent.Create(new
        {
            settlementId,
            settlementBatchId,
            reservationId,
            ticketId = ToGuid(record.TicketId, "ticketId"),
            releaseAmount = new
            {
                amount = releaseAmount,
                currency = record.Currency
            },
            balanceImpact = new
            {
                amount = balanceImpact,
                currency = record.Currency
            },
            outcome = record.SettlementOutcome == "REJECTED" ? "VOID" : record.SettlementOutcome,
            sourceService = "settlement-service",
            metadata = new Dictionary<string, object?>
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
        var settlementApplicationId = document.RootElement.GetProperty("settlementApplicationId").GetString()
            ?? throw new SettlementIntegrationException("Credit Wallet Service response did not include settlementApplicationId.");

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
        var client = httpClientFactory.CreateClient();
        client.BaseAddress = new Uri(NormalizeBaseUrl(configuration.Integrations.CreditServiceUrl));
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/v1/credit-wallets/{playerId}/release");
        request.Headers.TryAddWithoutValidation("Idempotency-Key", targetIdempotencyKey);
        request.Headers.TryAddWithoutValidation("x-correlation-id", correlationId);
        request.Content = JsonContent.Create(new
        {
            reservationId,
            ticketId = ToGuid(record.TicketId, "ticketId"),
            releaseAmount = new
            {
                amount = record.StakeAmountMinor,
                currency = record.Currency
            },
            reasonCode = "settlement_instruction_release",
            sourceService = "settlement-service",
            metadata = new Dictionary<string, object?>
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
        var reservationReference = document.RootElement.GetProperty("reservationId").GetString()
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
