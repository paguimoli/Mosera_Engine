using System.Net.Http.Json;
using System.Text.Json;
using SettlementService.Application;
using SettlementService.Configuration;
using SettlementService.Contracts;

namespace SettlementService.Infrastructure;

public sealed class SettlementLedgerServiceClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly IHttpClientFactory httpClientFactory;
    private readonly ServiceConfiguration configuration;

    public SettlementLedgerServiceClient(
        IHttpClientFactory httpClientFactory,
        ServiceConfiguration configuration)
    {
        this.httpClientFactory = httpClientFactory;
        this.configuration = configuration;
    }

    public bool Configured => !string.IsNullOrWhiteSpace(configuration.Integrations.LedgerServiceUrl);

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
                ["Ledger Service URL is not configured."]);
        }

        try
        {
            var client = httpClientFactory.CreateClient();
            client.BaseAddress = new Uri(NormalizeBaseUrl(configuration.Integrations.LedgerServiceUrl));
            using var response = await client.GetAsync("/v1/ledger/health", cancellationToken);
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
                    [$"Ledger Service readiness failed with status {(int)response.StatusCode}."]);
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
            if (!ready) blockers.Add("Ledger Service readiness status is not ok.");
            if (!mutation) blockers.Add("Ledger Service mutation capability is not enabled.");
            if (!durable) blockers.Add("Ledger Service durable persistence is not configured.");
            if (!idempotency) blockers.Add("Ledger Service idempotency support is not configured.");
            if (!qaMarker) blockers.Add("Ledger Service QA capability marker is missing.");

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
                [$"Ledger Service readiness check failed: {error.Message}"]);
        }
    }

    public async Task<(SettlementExternalReferenceDto Reference, string ResponseHash)> PostFinancialInstructionAsync(
        FinancialInstructionExecutionContext context,
        Guid walletId,
        string targetIdempotencyKey,
        string correlationId,
        CancellationToken cancellationToken)
    {
        if (!Configured)
        {
            throw new SettlementIntegrationException("Ledger Service URL is not configured.");
        }

        var instruction = context.Instruction;
        if (instruction.InstructionType == FinancialInstructionType.LEDGER_NOOP)
        {
            return (new SettlementExternalReferenceDto(
                context.SettlementRecord.SettlementId.ToString(),
                context.SettlementRecord.TicketId,
                context.SettlementRecord.TicketLineId,
                "ledger_noop",
                "SKIPPED",
                targetIdempotencyKey,
                "SKIPPED"), "sha256:noop");
        }

        var (transactionType, direction, amount) = instruction.InstructionType switch
        {
            FinancialInstructionType.LEDGER_PAYOUT => ("SETTLEMENT_CREDIT", "CREDIT", context.SettlementRecord.GrossPayoutAmountMinor),
            FinancialInstructionType.LEDGER_REFUND => ("TICKET_REFUND", "CREDIT", context.SettlementRecord.StakeAmountMinor),
            FinancialInstructionType.LEDGER_REVERSAL => ("REVERSAL", "DEBIT", Math.Abs(context.SettlementRecord.NetResultAmountMinor)),
            _ => throw new SettlementIntegrationException($"Instruction {instruction.InstructionType} is not a Ledger instruction.")
        };

        if (amount <= 0)
        {
            return (new SettlementExternalReferenceDto(
                context.SettlementRecord.SettlementId.ToString(),
                context.SettlementRecord.TicketId,
                context.SettlementRecord.TicketLineId,
                "ledger_noop",
                "SKIPPED",
                targetIdempotencyKey,
                "SKIPPED"), "sha256:noop");
        }

        var client = httpClientFactory.CreateClient();
        client.BaseAddress = new Uri(NormalizeBaseUrl(configuration.Integrations.LedgerServiceUrl));
        using var request = new HttpRequestMessage(HttpMethod.Post, "/v1/ledger/entries");
        request.Headers.TryAddWithoutValidation("Idempotency-Key", targetIdempotencyKey);
        request.Headers.TryAddWithoutValidation("x-correlation-id", correlationId);
        request.Content = JsonContent.Create(new
        {
            walletId,
            transactionType,
            direction,
            money = new
            {
                amount,
                currency = context.SettlementRecord.Currency
            },
            reference = new
            {
                type = "settlement_financial_instruction",
                id = instruction.InstructionId.ToString()
            },
            metadata = new Dictionary<string, object?>
            {
                ["settlementId"] = context.SettlementRecord.SettlementId,
                ["settlementRequestId"] = context.SettlementRecord.SettlementRequestId,
                ["instructionId"] = instruction.InstructionId,
                ["instructionType"] = instruction.InstructionType.ToString(),
                ["canonicalPayloadHash"] = instruction.CanonicalPayloadHash,
                ["sourceService"] = "settlement-service"
            }
        }, options: JsonOptions);

        using var response = await client.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new SettlementIntegrationException(
                $"Ledger Service rejected financial instruction. StatusCode={(int)response.StatusCode}. Body={body}");
        }

        using var document = JsonDocument.Parse(body);
        var ledgerEntry = document.RootElement.GetProperty("ledgerEntry");
        var ledgerEntryId = ledgerEntry.GetProperty("id").GetString()
            ?? throw new SettlementIntegrationException("Ledger Service response did not include ledgerEntry.id.");

        return (new SettlementExternalReferenceDto(
            context.SettlementRecord.SettlementId.ToString(),
            context.SettlementRecord.TicketId,
            context.SettlementRecord.TicketLineId,
            "ledger_entry",
            ledgerEntryId,
            targetIdempotencyKey,
            "POSTED"), FinancialInstructionService.HashCanonical(body));
    }

    public async Task<SettlementExternalReferenceDto> PostLedgerEffectAsync(
        SettlementLedgerEffectDto effect,
        Guid walletId,
        string correlationId,
        CancellationToken cancellationToken)
    {
        if (!Configured)
        {
            throw new SettlementIntegrationException("Ledger Service URL is not configured.");
        }

        if (effect.Direction == "NOOP" || effect.Amount <= 0)
        {
            return new SettlementExternalReferenceDto(
                effect.SettlementRecordId,
                effect.TicketId,
                effect.TicketLineId,
                "ledger_noop",
                "NO_OP",
                effect.IdempotencyKey,
                "SKIPPED");
        }

        var client = httpClientFactory.CreateClient();
        client.BaseAddress = new Uri(NormalizeBaseUrl(configuration.Integrations.LedgerServiceUrl));
        using var request = new HttpRequestMessage(HttpMethod.Post, "/v1/ledger/entries");
        request.Headers.TryAddWithoutValidation("Idempotency-Key", effect.IdempotencyKey);
        request.Headers.TryAddWithoutValidation("x-correlation-id", correlationId);
        request.Content = JsonContent.Create(new
        {
            walletId,
            transactionType = effect.TransactionType,
            direction = effect.Direction,
            money = new
            {
                amount = ToMinorAmount(effect.Amount),
                currency = "USD"
            },
            reference = new
            {
                type = "settlement_service_dry_run",
                id = effect.ReferenceId
            },
            metadata = new Dictionary<string, object?>
            {
                ["settlementRunId"] = effect.SettlementRunId,
                ["settlementRecordId"] = effect.SettlementRecordId,
                ["settlementLedgerEffectId"] = effect.Id,
                ["integrationMode"] = "DRY_RUN",
                ["authoritativeSettlement"] = false
            }
        }, options: JsonOptions);

        using var response = await client.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new SettlementIntegrationException(
                $"Ledger Service rejected settlement effect. StatusCode={(int)response.StatusCode}. Body={body}");
        }

        using var document = JsonDocument.Parse(body);
        var ledgerEntry = document.RootElement.GetProperty("ledgerEntry");
        var ledgerEntryId = ledgerEntry.GetProperty("id").GetString()
            ?? throw new SettlementIntegrationException("Ledger Service response did not include ledgerEntry.id.");

        return new SettlementExternalReferenceDto(
            effect.SettlementRecordId,
            effect.TicketId,
            effect.TicketLineId,
            "ledger_entry",
            ledgerEntryId,
            effect.IdempotencyKey,
            "POSTED_DRY_RUN");
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

public sealed class SettlementIntegrationException : Exception
{
    public SettlementIntegrationException(string message)
        : base(message)
    {
    }
}
