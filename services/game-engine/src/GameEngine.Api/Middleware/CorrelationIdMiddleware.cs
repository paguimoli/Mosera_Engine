using GameEngine.Api.Controllers;

namespace GameEngine.Api.Middleware;

public sealed class CorrelationIdMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var correlationId = context.Request.Headers.TryGetValue(HttpContextExtensions.CorrelationIdHeader, out var values)
            && !string.IsNullOrWhiteSpace(values.FirstOrDefault())
            ? values.First()!
            : Guid.NewGuid().ToString("N");

        context.Items[HttpContextExtensions.CorrelationIdHeader] = correlationId;
        context.Response.Headers[HttpContextExtensions.CorrelationIdHeader] = correlationId;

        await next(context);
    }
}
