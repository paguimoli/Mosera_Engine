using System.Net.Http.Json;
using System.Text.Json;
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
}

public sealed class SettlementIntegrationException : Exception
{
    public SettlementIntegrationException(string message)
        : base(message)
    {
    }
}
