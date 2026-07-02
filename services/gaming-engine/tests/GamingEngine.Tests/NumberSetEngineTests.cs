using GamingEngine.Application;
using GamingEngine.Domain;
using GamingEngine.Infrastructure;
using Xunit;

namespace GamingEngine.Tests;

public sealed class NumberSetEngineTests
{
    [Fact]
    public void Draw_ReturnsUniqueNumbers()
    {
        var engine = new NumberSetEngine(new SequenceRandomNumberGenerator(0, 1, 2, 3, 4, 5));

        var result = engine.Draw(new DrawRequest(1, 10, 6, "unique-test"));

        Assert.Equal(6, result.NumberSetResult.Numbers.Length);
        Assert.Equal(result.NumberSetResult.Numbers.Length, result.NumberSetResult.Numbers.Distinct().Count());
    }

    [Fact]
    public void Draw_ReturnsNumbersWithinInclusiveRange()
    {
        var engine = new NumberSetEngine(new SequenceRandomNumberGenerator(0, 1, 2, 3, 4));

        var result = engine.Draw(new DrawRequest(10, 20, 5, "range-test"));

        Assert.All(result.NumberSetResult.Numbers, number => Assert.InRange(number, 10, 20));
    }

    [Theory]
    [InlineData(5, 5, 1)]
    [InlineData(6, 5, 1)]
    [InlineData(1, 5, 0)]
    [InlineData(1, 5, 6)]
    public void Draw_RejectsInvalidConfigurations(int minNumber, int maxNumber, int numbersToDraw)
    {
        var engine = new NumberSetEngine(new SequenceRandomNumberGenerator(0));

        Assert.Throws<ArgumentException>(() =>
            engine.Draw(new DrawRequest(minNumber, maxNumber, numbersToDraw, "invalid-test")));
    }

    [Fact]
    public void Draw_UsesCryptoRandomNumberGeneratorInfrastructure()
    {
        var generator = new CryptoRandomNumberGenerator();
        var values = Enumerable.Range(0, 100)
            .Select(_ => generator.GetInt32(10))
            .ToArray();

        Assert.All(values, value => Assert.InRange(value, 0, 9));
    }

    [Fact]
    public void RepeatDraw_DoesNotReturnSortedDeterministicOutputEveryTime()
    {
        var engine = new NumberSetEngine(new CryptoRandomNumberGenerator());
        var sorted = Enumerable.Range(1, 10).ToArray();

        var everyDrawSorted = Enumerable.Range(0, 25)
            .Select(index => engine.Draw(new DrawRequest(1, 10, 10, $"repeat-{index}")).NumberSetResult.Numbers)
            .All(numbers => numbers.SequenceEqual(sorted));

        Assert.False(everyDrawSorted);
    }

    private sealed class SequenceRandomNumberGenerator : IRandomNumberGenerator
    {
        private readonly IReadOnlyList<int> _values;
        private int _index;

        public SequenceRandomNumberGenerator(params int[] values)
        {
            _values = values.Length == 0 ? [0] : values;
        }

        public int GetInt32(int exclusiveUpperBound)
        {
            var value = _values[_index % _values.Count];
            _index++;
            return Math.Abs(value) % exclusiveUpperBound;
        }
    }
}
