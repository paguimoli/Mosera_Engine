using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using SettlementService.Application;
using SettlementService.Configuration;
using SettlementService.Contracts;

namespace SettlementService.Infrastructure;

public sealed class SettlementShadowPersistence
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly IHttpClientFactory httpClientFactory;
    private readonly ServiceConfiguration configuration;
    private readonly ILogger<SettlementShadowPersistence> logger;

    public SettlementShadowPersistence(
        IHttpClientFactory httpClientFactory,
        ServiceConfiguration configuration,
        ILogger<SettlementShadowPersistence> logger)
    {
        this.httpClientFactory = httpClientFactory;
        this.configuration = configuration;
        this.logger = logger;
    }

    public async Task<string?> PersistRunAsync(
        ShadowSettlementExecuteRequest request,
        ShadowCalculationResult result,
        CancellationToken cancellationToken)
    {
        if (!IsConfigured())
        {
            logger.LogInformation("Settlement shadow persistence skipped because Supabase is not configured.");
            return null;
        }

        var runPayload = new
        {
            correlation_id = result.CorrelationId,
            settlement_run_id = request.SettlementRunId,
            ticket_id = request.TicketId,
            game_id = request.GameId,
            drawing_id = request.DrawingId,
            comparison_status = result.ComparisonStatus.ToString(),
            shadow_outcome = result.CalculatedOutcome.ToString(),
            monolith_outcome = request.ExpectedMonolithResult?.CalculatedOutcome.ToString(),
            shadow_gross_payout = result.GrossPayout,
            monolith_gross_payout = request.ExpectedMonolithResult?.GrossPayout,
            shadow_net_amount = result.NetAmount,
            monolith_net_amount = request.ExpectedMonolithResult?.NetAmount,
            currency = result.Currency,
            shadow_service_version = "0.1.0"
        };
        var run = await InsertSingleAsync<InsertedId>(
            "settlement_shadow_runs",
            runPayload,
            cancellationToken);

        if (run?.Id is null)
        {
            return null;
        }

        foreach (var mismatch in result.Mismatches)
        {
            var mismatchType = ClassifyMismatch(mismatch.Field);
            await InsertSingleAsync<InsertedId>(
                "settlement_shadow_mismatches",
                new
                {
                    shadow_run_id = run.Id,
                    mismatch_type = mismatchType,
                    field_name = mismatch.Field,
                    monolith_value = mismatch.Expected,
                    shadow_value = mismatch.Actual,
                    severity = GetSeverity(mismatchType)
                },
                cancellationToken);
        }

        return run.Id;
    }

    public async Task PersistFailureAsync(
        ShadowSettlementExecuteRequest? request,
        string correlationId,
        string failureType,
        string failureReason,
        IReadOnlyDictionary<string, object?>? metadata,
        CancellationToken cancellationToken)
    {
        if (!IsConfigured())
        {
            logger.LogInformation("Settlement shadow failure persistence skipped because Supabase is not configured.");
            return;
        }

        await InsertSingleAsync<InsertedId>(
            "settlement_shadow_failures",
            new
            {
                correlation_id = correlationId,
                ticket_id = request?.TicketId,
                failure_reason = failureReason,
                failure_type = failureType,
                metadata = metadata ?? new Dictionary<string, object?>()
            },
            cancellationToken);
    }

    private bool IsConfigured()
    {
        return !string.IsNullOrWhiteSpace(configuration.Supabase.Url) &&
               !string.IsNullOrWhiteSpace(configuration.Supabase.ServiceRoleKey);
    }

    private async Task<T?> InsertSingleAsync<T>(
        string table,
        object payload,
        CancellationToken cancellationToken) where T : class
    {
        var client = httpClientFactory.CreateClient();
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{configuration.Supabase.Url.TrimEnd('/')}/rest/v1/{table}?select=id");
        var serialized = JsonSerializer.Serialize(payload, JsonOptions);

        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            configuration.Supabase.ServiceRoleKey);
        request.Headers.Add("apikey", configuration.Supabase.ServiceRoleKey);
        request.Headers.Add("Prefer", "return=representation");
        request.Content = new StringContent(serialized, Encoding.UTF8, "application/json");

        using var response = await client.SendAsync(request, cancellationToken);
        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            logger.LogWarning(
                "Settlement shadow persistence failed. Table={Table} StatusCode={StatusCode} Response={Response}",
                table,
                (int)response.StatusCode,
                responseBody);
            return default;
        }

        var rows = JsonSerializer.Deserialize<List<T>>(responseBody, JsonOptions);
        return rows?.FirstOrDefault();
    }

    private static string ClassifyMismatch(string field)
    {
        return field switch
        {
            "calculatedOutcome" => "OUTCOME_MISMATCH",
            "grossPayout" => "PAYOUT_MISMATCH",
            "netAmount" => "NET_AMOUNT_MISMATCH",
            "stakeAmount" => "STAKE_MISMATCH",
            "currency" => "CURRENCY_MISMATCH",
            _ => "UNKNOWN_MISMATCH"
        };
    }

    private static string GetSeverity(string mismatchType)
    {
        return mismatchType switch
        {
            "OUTCOME_MISMATCH" => "CRITICAL",
            "PAYOUT_MISMATCH" => "CRITICAL",
            "NET_AMOUNT_MISMATCH" => "CRITICAL",
            "STAKE_MISMATCH" => "WARNING",
            "CURRENCY_MISMATCH" => "CRITICAL",
            _ => "WARNING"
        };
    }

    private sealed record InsertedId([property: JsonPropertyName("id")] string Id);
}
