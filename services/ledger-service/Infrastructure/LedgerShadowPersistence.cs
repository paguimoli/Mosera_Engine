using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using LedgerService.Application;
using LedgerService.Configuration;
using LedgerService.Contracts;

namespace LedgerService.Infrastructure;

public sealed class LedgerShadowPersistence
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly IHttpClientFactory httpClientFactory;
    private readonly ServiceConfiguration configuration;
    private readonly ILogger<LedgerShadowPersistence> logger;

    public LedgerShadowPersistence(
        IHttpClientFactory httpClientFactory,
        ServiceConfiguration configuration,
        ILogger<LedgerShadowPersistence> logger)
    {
        this.httpClientFactory = httpClientFactory;
        this.configuration = configuration;
        this.logger = logger;
    }

    public async Task<string?> PersistRunAsync(
        LedgerShadowExecuteRequest request,
        LedgerShadowEvaluation evaluation,
        CancellationToken cancellationToken)
    {
        if (!IsConfigured())
        {
            logger.LogInformation("Ledger shadow persistence skipped because Supabase is not configured.");
            return null;
        }

        var calculated = evaluation.CalculatedResult;
        var expected = request.ExpectedMonolithResult;
        var run = await InsertSingleAsync<InsertedId>(
            "ledger_shadow_runs",
            new
            {
                correlation_id = request.CorrelationId,
                transaction_id = calculated.TransactionId,
                account_id = calculated.AccountId,
                wallet_id = calculated.WalletId,
                entry_type = calculated.EntryType,
                comparison_status = evaluation.ComparisonStatus.ToString(),
                shadow_entry_type = calculated.EntryType,
                monolith_entry_type = expected?.EntryType,
                shadow_amount_minor = calculated.AmountMinor,
                monolith_amount_minor = expected?.AmountMinor,
                shadow_currency = calculated.Currency,
                monolith_currency = expected?.Currency,
                shadow_account_id = calculated.AccountId,
                monolith_account_id = expected?.AccountId,
                shadow_idempotency_key = calculated.IdempotencyKey,
                monolith_idempotency_key = expected?.IdempotencyKey,
                shadow_service_version = "0.1.0"
            },
            cancellationToken);

        if (run?.Id is null)
        {
            return null;
        }

        foreach (var mismatch in evaluation.Mismatches)
        {
            await InsertSingleAsync<InsertedId>(
                "ledger_shadow_mismatches",
                new
                {
                    shadow_run_id = run.Id,
                    mismatch_type = mismatch.MismatchType,
                    field_name = mismatch.Field,
                    monolith_value = mismatch.Expected,
                    shadow_value = mismatch.Actual,
                    severity = mismatch.Severity
                },
                cancellationToken);
        }

        return run.Id;
    }

    public async Task PersistFailureAsync(
        LedgerShadowExecuteRequest? request,
        string correlationId,
        string failureType,
        string failureReason,
        IReadOnlyDictionary<string, object?>? metadata,
        CancellationToken cancellationToken)
    {
        if (!IsConfigured())
        {
            logger.LogInformation("Ledger shadow failure persistence skipped because Supabase is not configured.");
            return;
        }

        await InsertSingleAsync<InsertedId>(
            "ledger_shadow_failures",
            new
            {
                correlation_id = correlationId,
                transaction_id = request?.TransactionId,
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
                "Ledger shadow persistence failed. Table={Table} StatusCode={StatusCode} Response={Response}",
                table,
                (int)response.StatusCode,
                responseBody);
            return default;
        }

        var rows = JsonSerializer.Deserialize<List<T>>(responseBody, JsonOptions);
        return rows?.FirstOrDefault();
    }

    private sealed record InsertedId([property: JsonPropertyName("id")] string Id);
}
