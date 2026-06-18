using SettlementService.Contracts;

namespace SettlementService.Controllers;

public static class HttpContextExtensions
{
    public static string GetCorrelationId(this HttpContext context)
    {
        return context.Items.TryGetValue(SettlementHeaders.CorrelationId, out var value)
            ? Convert.ToString(value) ?? string.Empty
            : string.Empty;
    }
}
