using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using SettlementService.Application;
using SettlementService.Configuration;
using SettlementService.Contracts;
using SettlementService.Infrastructure;

var tenantId = Guid.NewGuid();
var brandId = Guid.NewGuid();
var playerId = Guid.NewGuid();
var reservationId = Guid.NewGuid();
var input = BuildInput();
var ticketId = "ticket-1";
var scope = new CanonicalSettlementScopeDto(
    tenantId,
    brandId,
    playerId,
    reservationId,
    ticketId,
    "manifest:1.0.0",
    "outcome:certificate",
    Hash("scope"));
var request = BuildRequest(input, scope);
var service = new SettlementInputIngestionService(
    new SettlementInputIngestionRepository(BuildConfiguration("Development")));

var validation = service.Validate(request, input, scope);
Assert(validation.IsValid, $"Canonical scoped request should validate: {string.Join(", ", validation.Errors)}");

var tenantConflict = request with { TenantId = Guid.NewGuid() };
Assert(
    !service.Validate(tenantConflict, input, scope).IsValid,
    "Conflicting tenant scope must fail closed.");

var brandConflict = request with { BrandId = Guid.NewGuid() };
Assert(
    !service.Validate(brandConflict, input, scope).IsValid,
    "Conflicting brand scope must fail closed.");

var contextConflict = request with
{
    AcceptedWagerFinancialContext = request.AcceptedWagerFinancialContext with
    {
        TenantId = Guid.NewGuid()
    }
};
Assert(
    !service.Validate(contextConflict, input, scope).IsValid,
    "Cross-tenant financial context must fail closed.");

var originalHash = SettlementInputIngestionService.BuildCanonicalRequestHash(request, scope);
var conflictingScopeHash = SettlementInputIngestionService.BuildCanonicalRequestHash(
    request,
    scope with { BrandId = Guid.NewGuid(), ScopeHash = Hash("different-scope") });
Assert(originalHash != conflictingScopeHash, "Canonical request hash must bind tenant/brand scope.");

var previousEnvironment = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT");
var previousLegacy = Environment.GetEnvironmentVariable("SETTLEMENT_LEGACY_MUTATIONS_ENABLED");
try
{
    Environment.SetEnvironmentVariable("ASPNETCORE_ENVIRONMENT", "Production");
    Environment.SetEnvironmentVariable("SETTLEMENT_LEGACY_MUTATIONS_ENABLED", "true");
    AssertThrows<InvalidOperationException>(
        () => ServiceConfiguration.FromEnvironment(new TestHostEnvironment("Production")),
        "Production must reject enabled legacy settlement mutations.");

    Environment.SetEnvironmentVariable("SETTLEMENT_LEGACY_MUTATIONS_ENABLED", "false");
    var production = ServiceConfiguration.FromEnvironment(new TestHostEnvironment("Production"));
    Assert(!production.Runtime.LegacyMutationRoutesEnabled, "Production legacy settlement mutations must remain disabled.");
}
finally
{
    Environment.SetEnvironmentVariable("ASPNETCORE_ENVIRONMENT", previousEnvironment);
    Environment.SetEnvironmentVariable("SETTLEMENT_LEGACY_MUTATIONS_ENABLED", previousLegacy);
}

Console.WriteLine("Settlement Service focused tests passed.");

static StoredSettlementInputDto BuildInput()
{
    var inputId = Guid.NewGuid();
    return new StoredSettlementInputDto(
        inputId,
        Hash("input"),
        Guid.NewGuid(),
        Hash("math-certificate"),
        Guid.NewGuid(),
        Hash("outcome-certificate"),
        "ticket-line-1",
        "manifest",
        "1.0.0",
        Hash("manifest"),
        "math",
        "1.0.0",
        Hash("math"),
        "paytable",
        "1.0.0",
        Hash("paytable"),
        "keno:1.0.0",
        "Win",
        "TIER_1",
        Hash("prize-facts"),
        2,
        2,
        Hash("canonical-payload"));
}

static SettlementInputIngestionRequest BuildRequest(
    StoredSettlementInputDto input,
    CanonicalSettlementScopeDto scope)
{
    var contextReference = "accepted-wager-context:v1:test";
    var acceptedAt = DateTimeOffset.UtcNow;
    var reservation = new CreditReservationReferenceDto(
        scope.CreditReservationId.ToString(),
        scope.TenantId,
        scope.BrandId,
        scope.PlayerAccountId.ToString(),
        scope.TicketId,
        input.TicketReference);
    var context = new AcceptedWagerFinancialContextDto(
        contextReference,
        scope.TenantId,
        scope.BrandId,
        scope.TicketId,
        input.TicketReference,
        scope.PlayerAccountId.ToString(),
        100,
        "USD",
        2,
        "rounding-policy:v1",
        reservation,
        acceptedAt);
    return new SettlementInputIngestionRequest(
        Guid.NewGuid(),
        "settlement:test",
        input.SettlementInputId,
        input.SettlementInputHash,
        input.MathEvaluationCertificateId,
        input.MathEvaluationCertificateHash,
        input.OutcomeCertificateId,
        input.OutcomeCertificateHash,
        scope.TenantId,
        scope.BrandId,
        scope.TicketId,
        input.TicketReference,
        scope.PlayerAccountId.ToString(),
        contextReference,
        100,
        "USD",
        2,
        "rounding-policy:v1",
        scope.CreditReservationId.ToString(),
        "settlement-policy:v1",
        acceptedAt,
        new Dictionary<string, object?> { ["source"] = "focused-test" },
        SettlementIngestionMode.DryRun,
        context,
        new SettlementPolicyReferenceDto("settlement-policy:v1"));
}

static ServiceConfiguration BuildConfiguration(string environment)
{
    return new ServiceConfiguration(
        "settlement-service",
        environment,
        new DatabaseConfiguration(string.Empty),
        new ServiceIntegrationConfiguration(string.Empty, string.Empty, string.Empty),
        new SettlementRuntimeConfiguration(true),
        new RabbitMqConfiguration(string.Empty, "lottery.events"),
        new RedisConfiguration(string.Empty),
        new SupabaseConfiguration(string.Empty, string.Empty));
}

static string Hash(string value)
{
    return SettlementInputIngestionService.HashCanonical(value);
}

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

static void AssertThrows<TException>(Action action, string message)
    where TException : Exception
{
    try
    {
        action();
    }
    catch (TException)
    {
        return;
    }

    throw new InvalidOperationException(message);
}

file sealed class TestHostEnvironment(string environmentName) : IHostEnvironment
{
    public string EnvironmentName { get; set; } = environmentName;
    public string ApplicationName { get; set; } = "SettlementService.Tests";
    public string ContentRootPath { get; set; } = Directory.GetCurrentDirectory();
    public IFileProvider ContentRootFileProvider { get; set; } =
        new PhysicalFileProvider(Directory.GetCurrentDirectory());
}
