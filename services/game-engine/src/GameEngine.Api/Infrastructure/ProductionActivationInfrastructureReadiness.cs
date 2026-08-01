using GameEngine.Application.Services;
using GameEngine.Domain.Model;

namespace GameEngine.Api.Infrastructure;

public sealed class ProductionActivationInfrastructureReadiness(
    InfrastructureReadinessChecks readinessChecks)
    : IGameEngineProductionInfrastructureReadiness
{
    public async Task<GameEngineProductionInfrastructureReadiness> CheckAsync(
        CancellationToken cancellationToken)
    {
        var database = await readinessChecks.CheckDatabaseAsync(cancellationToken);
        var rabbitMq = await readinessChecks.CheckRabbitMqAsync(cancellationToken);
        return new GameEngineProductionInfrastructureReadiness(
            database.Ready,
            rabbitMq.Ready,
            new[] { database, rabbitMq }
                .Where(result => !result.Ready)
                .Select(result => $"{result.Name}: {result.Message}")
                .ToArray());
    }
}
