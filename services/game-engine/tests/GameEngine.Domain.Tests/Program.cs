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

Console.WriteLine("GameEngine.Domain.Tests PASS");
