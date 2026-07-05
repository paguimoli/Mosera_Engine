using System.Net.Http.Json;
using System.Text.Json;
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
}
