using CreditWalletService.Infrastructure;

namespace CreditWalletService.Application;

public sealed class CreditWalletStartupRecoveryHostedService(
    CreditWalletRecoveryRepository repository,
    CreditWalletRecoveryService recoveryService,
    ILogger<CreditWalletStartupRecoveryHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!repository.Configured) return;
        try
        {
            await recoveryService.RunStartupRecoveryAsync(stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            logger.LogError(error, "Credit Wallet startup recovery failed closed; production readiness remains disabled.");
        }
    }
}
