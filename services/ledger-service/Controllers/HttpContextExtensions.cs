using LedgerService.Contracts;

namespace LedgerService.Controllers;

public static class HttpContextExtensions
{
    public static string GetCorrelationId(this HttpContext context)
    {
        return context.Items.TryGetValue(LedgerHeaders.CorrelationId, out var value)
            && value is string correlationId
            ? correlationId
            : Guid.NewGuid().ToString("N");
    }
}
