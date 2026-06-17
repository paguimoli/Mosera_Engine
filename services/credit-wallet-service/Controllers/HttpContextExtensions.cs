using CreditWalletService.Contracts;

namespace CreditWalletService.Controllers;

public static class HttpContextExtensions
{
    public static string GetCorrelationId(this HttpContext context)
    {
        return context.Items.TryGetValue(CreditWalletHeaders.CorrelationId, out var value)
            && value is string correlationId
            ? correlationId
            : Guid.NewGuid().ToString("N");
    }
}
