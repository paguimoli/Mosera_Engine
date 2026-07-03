namespace GameEngine.Api.Infrastructure;

public sealed record DependencyHealthResult(
    string Name,
    bool Ready,
    string? Message = null);
