namespace GameEngine.Api.Controllers;

public static class HttpContextExtensions
{
    public const string CorrelationIdHeader = "x-correlation-id";

    public static string GetCorrelationId(this HttpContext context)
    {
        if (context.Items.TryGetValue(CorrelationIdHeader, out var value) && value is string correlationId)
        {
            return correlationId;
        }

        return context.TraceIdentifier;
    }
}
