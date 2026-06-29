namespace GameEngine.Domain.Model;

public enum ValidationSeverity
{
    Info,
    Warning,
    Error
}

public enum ValidationCode
{
    None,
    ManifestMissing,
    VersionMissing,
    UnsupportedGameType,
    UnsupportedWagerType,
    InvalidConfiguration,
    InvalidTicket,
    InvalidDrawResult,
    InvalidEvaluationInput,
    DrawGenerationUnsupported,
    FixtureMissing,
    HealthCheckFailed,
    ContractTestFailed,
    LifecycleStatusNotProductionReady
}

public sealed record ValidationError(
    ValidationCode Code,
    string Field,
    string Message,
    ValidationSeverity Severity);

public sealed record ValidationWarning(
    ValidationCode Code,
    string Field,
    string Message);

public sealed record ValidationResult(
    bool IsValid,
    IReadOnlyCollection<ValidationError> Errors,
    IReadOnlyCollection<ValidationWarning> Warnings)
{
    public static ValidationResult Success(IReadOnlyCollection<ValidationWarning>? warnings = null)
    {
        return new ValidationResult(true, [], warnings ?? []);
    }

    public static ValidationResult Failure(params ValidationError[] errors)
    {
        return new ValidationResult(false, errors, []);
    }
}
