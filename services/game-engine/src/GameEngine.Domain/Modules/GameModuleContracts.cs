using GameEngine.Domain.Model;

namespace GameEngine.Domain.Modules;

public sealed record TicketValidationRequest(
    Guid GameDefinitionId,
    Guid GameDefinitionVersionId,
    Guid PlayerId,
    GameType GameType,
    WagerType WagerType,
    IReadOnlyDictionary<string, object?> Payload);

public sealed record TicketValidationResult(
    bool Accepted,
    ValidationResult Validation,
    string ValidationHash);

public sealed record DrawGenerationRequest(
    Guid DrawScheduleId,
    Guid GameDefinitionVersionId,
    Guid DrawAuthorityVersionId,
    DateTimeOffset SalesClosedAt);

public sealed record DrawGenerationResult(
    bool Generated,
    string ResultHash,
    IReadOnlyDictionary<string, object?> Payload,
    DrawGenerationMetadata Metadata,
    ValidationResult Validation);

public sealed record ConfigurationValidationResult(
    bool Accepted,
    ValidationResult Validation,
    string ConfigurationHash);

public sealed record GameModuleHealthCheckResult(
    GameModuleHealthStatus Status,
    string ModuleCode,
    string ModuleVersion,
    IReadOnlyCollection<string> Warnings,
    DateTimeOffset CheckedAt);

public sealed record GameModuleFixture(
    string FixtureId,
    TicketValidationRequest InputTicket,
    IReadOnlyDictionary<string, object?> DrawResult,
    GameEvaluationOutcome ExpectedOutcome,
    GameEvaluationAmount ExpectedPayout,
    bool ExpectedValidationResult,
    GameEvaluationReason ExpectedReasonCode);

public interface IGameModule
{
    string ModuleId { get; }

    GameModuleManifest GetManifest();

    string GetVersion();

    GameModuleVersionMetadata GetVersionMetadata();

    IReadOnlyCollection<GameType> GetSupportedGameTypes();

    IReadOnlyCollection<WagerType> GetSupportedWagerTypes();
}

public interface IGameTicketValidator
{
    TicketValidationResult ValidateTicket(TicketValidationRequest request);
}

public interface IGameDrawGenerator
{
    bool CanGenerateDraw(DrawGenerationRequest request);

    DrawGenerationResult GenerateDraw(DrawGenerationRequest request);
}

public interface IGameEvaluator
{
    GameEvaluationOutput EvaluateTicket(GameEvaluationInput input);

    IReadOnlyCollection<GameEvaluationOutput> EvaluateBatch(IReadOnlyCollection<GameEvaluationInput> inputs);
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
    GameModuleManifest GetManifest();
}

public interface IGameModuleFixtureProvider
{
    IReadOnlyCollection<GameModuleFixture> GetDeterministicFixtures();
}
