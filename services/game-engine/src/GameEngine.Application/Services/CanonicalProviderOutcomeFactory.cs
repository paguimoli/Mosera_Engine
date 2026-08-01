using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public static class CanonicalProviderOutcomeFactory
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter() }
    };

    public static (CanonicalProviderOutcomeResult Result, string Json, string Hash) Create(
        DrawExecutionManifest manifest,
        GameDefinitionVersion definition,
        IReadOnlyList<int> primaryNumbers,
        IReadOnlyList<int> bonusNumbers,
        OutcomeNumberOrdering primaryOrdering,
        OutcomeNumberOrdering? bonusOrdering,
        IReadOnlyDictionary<string, object?>? derivedOutcomeData,
        string sourceResultHash)
    {
        var result = new CanonicalProviderOutcomeResult(
            "mosera.canonical-provider-result.v1",
            manifest.DrawId,
            manifest.ExecutionManifestId,
            manifest.GameDefinitionVersionId,
            definition.DefinitionHash,
            manifest.EvaluatorVersion,
            primaryNumbers.ToArray(),
            bonusNumbers.ToArray(),
            primaryOrdering,
            bonusOrdering,
            NormalizeDictionary(derivedOutcomeData),
            sourceResultHash);
        var json = JsonSerializer.Serialize(result, JsonOptions);
        return (result, json, Hash(json));
    }

    public static CanonicalProviderOutcomeResult Parse(string json)
    {
        return JsonSerializer.Deserialize<CanonicalProviderOutcomeResult>(json, JsonOptions)
            ?? throw new InvalidOperationException("Canonical provider result evidence is invalid.");
    }

    public static string Hash(string value) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";

    private static IReadOnlyDictionary<string, object?> NormalizeDictionary(
        IReadOnlyDictionary<string, object?>? value) =>
        value is null
            ? new SortedDictionary<string, object?>(StringComparer.Ordinal)
            : new SortedDictionary<string, object?>(
                value.ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal),
                StringComparer.Ordinal);
}
