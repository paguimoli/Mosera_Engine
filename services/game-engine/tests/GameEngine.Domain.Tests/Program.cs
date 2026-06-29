using GameEngine.Domain.Model;

var metadata = new DrawGenerationMetadata(
    "module-version",
    "draw-generator-version",
    "prng-provider-version",
    "draw-authority-version",
    "algorithm-version",
    "payload-hash");

var result = new OfficialCertifiedDrawResult(
    Guid.NewGuid(),
    Guid.NewGuid(),
    Guid.NewGuid(),
    "qa-operator",
    DateTimeOffset.UtcNow,
    metadata);

if (result.Metadata.PrngProviderVersion != "prng-provider-version")
{
    throw new InvalidOperationException("Certified result metadata must preserve PRNG provider version.");
}

if (!Enum.IsDefined(GameModuleLifecycleStatus.ProductionActive))
{
    throw new InvalidOperationException("Game module lifecycle must include ProductionActive.");
}

var validation = ValidationResult.Failure(new ValidationError(
    ValidationCode.InvalidTicket,
    "ticket",
    "Ticket is invalid.",
    ValidationSeverity.Error));

if (validation.IsValid || validation.Errors.First().Code != ValidationCode.InvalidTicket)
{
    throw new InvalidOperationException("Validation model must expose structured error codes.");
}

var amount = new GameEvaluationAmount("USD", 10m, 20m, 10m);
if (amount.NetAmount != 10m)
{
    throw new InvalidOperationException("Evaluation amount must preserve settlement-ready monetary facts.");
}

Console.WriteLine("GameEngine.Domain.Tests PASS");
