using GameEngine.Domain.Model;
using GameEngine.Domain.Randomness;

namespace GameEngine.Application.Services;

public sealed class DrawGenerationFramework : IDrawSamplingFramework
{
    public DrawSamplingDiagnostic GetDiagnostic()
    {
        return new DrawSamplingDiagnostic(
            DrawSamplingMode.WithoutReplacement,
            "FRAMEWORK_ONLY",
            ["card/deck generation", "dice generation", "wheel generation"]);
    }

    public IReadOnlyCollection<int> SampleWithoutReplacement(DrawSamplingRequest request, IRandomnessProvider provider)
    {
        ValidateRequest(request);
        var available = Enumerable.Range(request.MinimumInclusive, request.MaximumInclusive - request.MinimumInclusive + 1).ToList();
        if (request.SelectionCount > available.Count)
        {
            throw new InvalidOperationException("Selection count exceeds available values for sampling without replacement.");
        }

        var selected = new List<int>();
        for (var index = 0; index < request.SelectionCount; index += 1)
        {
            var selectedIndex = provider.GenerateBoundedInteger(0, available.Count);
            selected.Add(available[selectedIndex]);
            available.RemoveAt(selectedIndex);
        }

        return selected;
    }

    public IReadOnlyCollection<int> SampleWithReplacement(DrawSamplingRequest request, IRandomnessProvider provider)
    {
        ValidateRequest(request);
        return Enumerable
            .Range(0, request.SelectionCount)
            .Select(_ => provider.GenerateBoundedInteger(request.MinimumInclusive, request.MaximumInclusive + 1))
            .ToArray();
    }

    private static void ValidateRequest(DrawSamplingRequest request)
    {
        if (request.MaximumInclusive < request.MinimumInclusive)
        {
            throw new ArgumentOutOfRangeException(nameof(request), "Maximum must be greater than or equal to minimum.");
        }

        if (request.SelectionCount <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(request), "Selection count must be positive.");
        }
    }
}
