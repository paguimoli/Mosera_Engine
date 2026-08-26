using System.Text.Json;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using GameEngine.Infrastructure.Persistence;

internal static class Pr04AHotSpotEvidenceHarness
{
    public static async Task RunAsync(string[] args)
    {
        var marker = Array.IndexOf(args, "pr04a-hot-spot-evidence");
        if (marker < 0 || marker + 1 >= args.Length)
        {
            throw new ArgumentException("PR-04A Hot Spot evidence command is required.");
        }

        var databaseUrl = Environment.GetEnvironmentVariable("DATABASE_URL");
        if (string.IsNullOrWhiteSpace(databaseUrl))
        {
            throw new InvalidOperationException("PR-04A Hot Spot evidence requires durable PostgreSQL persistence.");
        }

        var repository = new PostgresDurableSchedulerRepository(databaseUrl);
        var command = args[marker + 1];
        object result = command switch
        {
            "quick-pick" => await GenerateQuickPickAsync(repository, args[(marker + 2)..]),
            "multi-draw" => await BindMultiDrawAsync(repository, args[(marker + 2)..]),
            _ => throw new ArgumentException($"Unsupported PR-04A Hot Spot evidence command '{command}'.")
        };

        Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
    }

    private static async Task<HotSpotQuickPickSelection> GenerateQuickPickAsync(
        PostgresDurableSchedulerRepository repository,
        string[] args)
    {
        if (args.Length != 5)
        {
            throw new ArgumentException(
                "quick-pick requires ticket request ID, idempotency key, spot count, product version hash, and actor reference.");
        }

        var drbg = new HmacDrbgRuntime();
        var authority = new HotSpotQuickPickAuthority(
            repository,
            new PurposeSeparatedRandomnessService(
                new AutoOsEntropyProvider(),
                drbg,
                new CertifiedCsprngSampler(drbg)),
            new SystemClock());
        return await authority.GenerateAsync(
            new HotSpotQuickPickRequest(
                Guid.Parse(args[0]),
                args[1],
                int.Parse(args[2]),
                args[3],
                args[4]),
            CancellationToken.None);
    }

    private static async Task<HotSpotMultiDrawPlan> BindMultiDrawAsync(
        PostgresDurableSchedulerRepository repository,
        string[] args)
    {
        if (args.Length is < 4 or > 5)
        {
            throw new ArgumentException(
                "multi-draw requires purchase ID, ticket ID, draw count, stake per draw, and optional Quick Pick idempotency key.");
        }

        HotSpotQuickPickSelection? quickPick = null;
        if (args.Length == 5)
        {
            quickPick = await repository.FindQuickPickAsync(args[4], CancellationToken.None)
                ?? throw new InvalidOperationException("The bound Quick Pick evidence was not found.");
        }

        return await new HotSpotMultiDrawAuthority(repository, new SystemClock()).BindAsync(
            Guid.Parse(args[0]),
            Guid.Parse(args[1]),
            int.Parse(args[2]),
            long.Parse(args[3]),
            quickPick,
            CancellationToken.None);
    }
}
