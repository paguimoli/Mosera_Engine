using GamingEngine.Domain;

namespace GamingEngine.Application;

public sealed class NumberSetEngine
{
    private readonly IRandomNumberGenerator _randomNumberGenerator;
    private readonly TimeProvider _timeProvider;

    public NumberSetEngine(IRandomNumberGenerator randomNumberGenerator, TimeProvider? timeProvider = null)
    {
        _randomNumberGenerator = randomNumberGenerator;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public DrawResult Draw(DrawRequest request)
    {
        Validate(request);

        var rangeSize = checked(request.MaxNumber - request.MinNumber + 1);
        var candidates = Enumerable.Range(request.MinNumber, rangeSize).ToArray();

        for (var index = candidates.Length - 1; index > 0; index--)
        {
            var swapIndex = _randomNumberGenerator.GetInt32(index + 1);
            (candidates[index], candidates[swapIndex]) = (candidates[swapIndex], candidates[index]);
        }

        var resultNumbers = candidates.Take(request.NumbersToDraw).ToArray();

        return new DrawResult(
            EngineType.NumberSet,
            "1.0.0",
            ResultType.NumberSet,
            new NumberSetResult(resultNumbers),
            _timeProvider.GetUtcNow(),
            request.CorrelationId);
    }

    public static void Validate(DrawRequest request)
    {
        if (request.MinNumber >= request.MaxNumber)
        {
            throw new ArgumentException("minNumber must be less than maxNumber.", nameof(request));
        }

        if (request.NumbersToDraw <= 0)
        {
            throw new ArgumentException("numbersToDraw must be greater than zero.", nameof(request));
        }

        var rangeSize = checked(request.MaxNumber - request.MinNumber + 1);
        if (request.NumbersToDraw > rangeSize)
        {
            throw new ArgumentException("numbersToDraw must be less than or equal to the inclusive range size.", nameof(request));
        }
    }
}
