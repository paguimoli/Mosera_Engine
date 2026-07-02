using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace GamingEngine.Tests;

public sealed class NumberSetApiTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public NumberSetApiTests(WebApplicationFactory<Program> factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task GetEngines_ReturnsNumberSetEngine()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/engines");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<EngineMetadataResponse[]>();
        Assert.NotNull(body);
        var numberSet = Assert.Single(body);
        Assert.Equal("NumberSet", numberSet.EngineType);
        Assert.Equal("Number Set Engine", numberSet.Name);
        Assert.Equal("1.0.0", numberSet.Version);
        Assert.Equal("Generates N unique numbers from an inclusive range.", numberSet.Description);
        Assert.False(numberSet.SupportsMetrics);
        Assert.False(numberSet.SupportsMarketEvaluation);
    }

    [Fact]
    public async Task GetEngineByType_ReturnsOkForNumberSetSlug()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/engines/number-set");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<EngineMetadataResponse>();
        Assert.NotNull(body);
        Assert.Equal("NumberSet", body.EngineType);
        Assert.Equal("Number Set Engine", body.Name);
    }

    [Fact]
    public async Task GetEngineByType_ReturnsNotFoundForInvalidEngineType()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/engines/invalid");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Draw_ReturnsOkForValidNumberSetRequest()
    {
        using var client = _factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/engines/number-set/draw", new
        {
            minNumber = 1,
            maxNumber = 10,
            numbersToDraw = 5,
            correlationId = "api-valid"
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<DrawResponse>();
        Assert.NotNull(body);
        Assert.Equal("NumberSet", body.EngineType);
        Assert.Equal("1.0.0", body.EngineVersion);
        Assert.Equal("NumberSet", body.ResultType);
        Assert.Equal("api-valid", body.CorrelationId);
        Assert.Equal(5, body.ResultPayload.Numbers.Length);
        Assert.Equal(5, body.ResultPayload.Numbers.Distinct().Count());
        Assert.All(body.ResultPayload.Numbers, number => Assert.InRange(number, 1, 10));
    }

    [Fact]
    public async Task Draw_ReturnsBadRequestForInvalidNumberSetRequest()
    {
        using var client = _factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/engines/number-set/draw", new
        {
            minNumber = 10,
            maxNumber = 1,
            numbersToDraw = 5,
            correlationId = "api-invalid"
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    private sealed record DrawResponse(
        string EngineType,
        string EngineVersion,
        string ResultType,
        NumberSetPayload ResultPayload,
        DateTimeOffset GeneratedAtUtc,
        string CorrelationId);

    private sealed record NumberSetPayload(int[] Numbers);

    private sealed record EngineMetadataResponse(
        string EngineType,
        string Name,
        string Version,
        string Description,
        bool SupportsMetrics,
        bool SupportsMarketEvaluation);
}
