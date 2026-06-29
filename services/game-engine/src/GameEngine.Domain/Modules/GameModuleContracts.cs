using GameEngine.Domain.Model;

namespace GameEngine.Domain.Modules;

public sealed record TicketValidationRequest(
    Guid GameDefinitionId,
    Guid GameDefinitionVersionId,
    Guid PlayerId,
    string WagerType,
    IReadOnlyDictionary<string, object?> Payload);

public sealed record TicketValidationResult(
    bool Accepted,
    IReadOnlyCollection<string> Errors,
    string ValidationHash);

public sealed record DrawGenerationRequest(
    Guid DrawScheduleId,
    Guid GameDefinitionVersionId,
    Guid DrawAuthorityVersionId,
    DateTimeOffset SalesClosedAt);

public sealed record DrawGenerationResult(
    string ResultHash,
    IReadOnlyDictionary<string, object?> Payload,
    DrawGenerationMetadata Metadata);

public sealed record EvaluationRequest(
    Guid TicketId,
    Guid DrawScheduleId,
    Guid GameDefinitionVersionId,
    IReadOnlyDictionary<string, object?> TicketPayload,
    IReadOnlyDictionary<string, object?> DrawPayload);

public sealed record EvaluationResult(
    string ResultCode,
    string EvaluationHash,
    IReadOnlyDictionary<string, object?> SettlementFacts);

public sealed record ConfigurationValidationResult(
    bool Accepted,
    IReadOnlyCollection<string> Errors,
    string ConfigurationHash);

public sealed record GameModuleHealthCheckResult(
    GameModuleHealthStatus Status,
    string ModuleCode,
    string ModuleVersion,
    IReadOnlyCollection<string> Warnings,
    DateTimeOffset CheckedAt);

public interface IGameModule
{
    string ModuleCode { get; }

    string GetVersion();

    GameModuleManifest GetMetadata();

    IReadOnlyCollection<string> SupportedWagers();
}

public interface IGameTicketValidator
{
    TicketValidationResult ValidateTicket(TicketValidationRequest request);
}

public interface IGameDrawGenerator
{
    DrawGenerationResult GenerateDraw(DrawGenerationRequest request);
}

public interface IGameEvaluator
{
    EvaluationResult Evaluate(EvaluationRequest request);
}

public interface IGameConfigurationValidator
{
    ConfigurationValidationResult ValidateConfiguration(IReadOnlyDictionary<string, object?> configuration);
}

public interface IGameModuleHealthCheck
{
    GameModuleHealthCheckResult HealthCheck();
}

public interface IGameModuleManifestProvider
{
    GameModuleManifest GetMetadata();
}
