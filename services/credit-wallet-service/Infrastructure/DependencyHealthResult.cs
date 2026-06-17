namespace CreditWalletService.Infrastructure;

public sealed record DependencyHealthResult(
    string Name,
    bool Ready,
    string? Message = null);
