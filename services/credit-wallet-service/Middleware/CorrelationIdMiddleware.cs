using CreditWalletService.Configuration;
using CreditWalletService.Contracts;

namespace CreditWalletService.Middleware;

public sealed class CorrelationIdMiddleware
{
    private readonly RequestDelegate next;
    private readonly ILogger<CorrelationIdMiddleware> logger;
    private readonly ServiceConfiguration configuration;

    public CorrelationIdMiddleware(
        RequestDelegate next,
        ILogger<CorrelationIdMiddleware> logger,
        ServiceConfiguration configuration)
    {
        this.next = next;
        this.logger = logger;
        this.configuration = configuration;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var correlationId = GetOrCreateCorrelationId(context);
        context.Items[CreditWalletHeaders.CorrelationId] = correlationId;
        context.Response.Headers[CreditWalletHeaders.CorrelationId] = correlationId;

        using var scope = logger.BeginScope(new Dictionary<string, object>
        {
            ["ServiceName"] = configuration.ServiceName,
            ["CorrelationId"] = correlationId
        });

        await next(context);
    }

    private static string GetOrCreateCorrelationId(HttpContext context)
    {
        var headerValue = context.Request.Headers[CreditWalletHeaders.CorrelationId].FirstOrDefault();

        return string.IsNullOrWhiteSpace(headerValue)
            ? Guid.NewGuid().ToString("N")
            : headerValue.Trim();
    }
}
