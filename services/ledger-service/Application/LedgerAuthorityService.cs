using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgerService.Configuration;
using LedgerService.Contracts;
using LedgerService.Infrastructure;

namespace LedgerService.Application;

public sealed class LedgerAuthorityService(
    ServiceConfiguration configuration,
    InfrastructureReadinessChecks infrastructureReadiness,
    DurableLedgerService durableLedgerService,
    LedgerPostingService postingService,
    LedgerRecoveryService recoveryService,
    FinancialPostingCatalog postingCatalog,
    LedgerPromotionRepository repository,
    IHttpClientFactory httpClientFactory)
{
    private const string BuildVersion = "ledger-authority-guardrails-v1";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<LedgerAuthorityReadinessReport> BuildReadinessReportAsync(
        LedgerAuthorityMode? requestedMode,
        CancellationToken cancellationToken)
    {
        var mode = requestedMode ?? ResolveConfiguredMode();
        var database = await infrastructureReadiness.CheckDatabaseAsync(cancellationToken);
        var catalog = await postingCatalog.GetReadinessAsync(cancellationToken);
        var recovery = await recoveryService.CheckReadinessAsync(cancellationToken);
        var snapshot = database.Ready
            ? await repository.GetOperationalSnapshotAsync(cancellationToken)
            : new LedgerPromotionOperationalSnapshot(0, 0, 0, 0, 0);
        var passingPromotionRehearsal = database.Ready
            && await repository.HasPassingPromotionRehearsalAsync(cancellationToken);
        var credit = await CheckCreditWalletAsync(cancellationToken);
        var legacyPaths = BuildLegacyPathEvidence(mode);
        var legacyIsolated = legacyPaths.All(path => path.AllowedInRequestedMode);
        var blockers = new List<string>();

        AddBlockerUnless(blockers, repository.Configured && database.Ready, "Durable Ledger persistence is not reachable.");
        AddBlockerUnless(blockers, durableLedgerService.ImmutableEntryStorageReady, "Immutable Ledger posting is not ready.");
        AddBlockerUnless(blockers, postingService.BalancedJournalReady && snapshot.UnbalancedJournals == 0, "Balanced journal readiness is incomplete.");
        AddBlockerUnless(blockers, durableLedgerService.ConflictSafeIdempotencyReady && postingService.DurablePostingRequestsReady, "Conflict-safe idempotency is not ready.");
        AddBlockerUnless(blockers, durableLedgerService.ReversalOnlyCorrectionReady && postingService.ReversalJournalReady, "Reversal-only correction is not ready.");
        AddBlockerUnless(
            blockers,
            catalog.CatalogLoaded
                && catalog.RequiredLaunchMappingsPresent
                && catalog.ExactRuleResolutionReady
                && catalog.AccountRoleResolutionReady
                && catalog.CashierMappingsDisabled,
            "The credit-only launch posting catalog or exact account-role resolution is not ready.");
        AddBlockerUnless(blockers, recovery.Reachable && recovery.PostingRecoveryReady && recovery.JournalIntegrityRecoveryReady, "Ledger recovery is not ready.");
        AddBlockerUnless(blockers, recovery.ReplayReady, "Ledger replay verification is not ready.");
        AddBlockerUnless(blockers, recovery.MinimalReconciliationReady && snapshot.ReconciliationMismatches == 0 && snapshot.ReconciliationInconclusive == 0, "Ledger reconciliation has unresolved evidence.");
        AddBlockerUnless(blockers, credit.Ready && credit.ReconciliationReady, "Credit Wallet dependency readiness is incomplete.");
        AddBlockerUnless(blockers, snapshot.IncompletePostingRequests == 0, "Incomplete Ledger posting requests block promotion.");

        var productionPostingEnabled = false;
        var explicitApproval = false;
        if (mode == LedgerAuthorityMode.SERVICE)
        {
            AddBlockerUnless(blockers, legacyIsolated, "Legacy direct posting paths are not proven isolated for SERVICE authority.");
            AddBlockerUnless(blockers, passingPromotionRehearsal, "No passing Ledger promotion rehearsal evidence exists.");
            blockers.Add("Production Ledger posting is intentionally disabled.");
            blockers.Add("Explicit production promotion approval evidence is absent.");
            blockers.Add("Production environment confirmation is absent.");
        }

        var rollbackReady = mode != LedgerAuthorityMode.SERVICE && ResolveConfiguredMode() == LedgerAuthorityMode.MONOLITH;
        var promotionAllowed = blockers.Count == 0 && mode is LedgerAuthorityMode.SERVICE_SHADOW or LedgerAuthorityMode.SERVICE_DRY_RUN;
        var markers = BuildMarkers(database.Ready, catalog, recovery, credit, promotionAllowed);
        var reportHash = Hash(JsonSerializer.Serialize(new
        {
            mode,
            database = database.Ready,
            catalog,
            recovery,
            snapshot,
            credit,
            legacyPaths,
            productionPostingEnabled,
            explicitApproval,
            passingPromotionRehearsal,
            rollbackReady,
            blockers,
            markers
        }, JsonOptions));

        return new LedgerAuthorityReadinessReport(
            mode,
            repository.Configured && database.Ready,
            durableLedgerService.ImmutableEntryStorageReady,
            postingService.BalancedJournalReady && snapshot.UnbalancedJournals == 0,
            durableLedgerService.ConflictSafeIdempotencyReady && postingService.DurablePostingRequestsReady,
            durableLedgerService.ReversalOnlyCorrectionReady && postingService.ReversalJournalReady,
            catalog.CatalogLoaded
                && catalog.RequiredLaunchMappingsPresent
                && catalog.ExactRuleResolutionReady
                && catalog.AccountRoleResolutionReady
                && catalog.CashierMappingsDisabled,
            recovery.Reachable && recovery.PostingRecoveryReady && recovery.JournalIntegrityRecoveryReady,
            recovery.ReplayReady,
            recovery.MinimalReconciliationReady && snapshot.ReconciliationMismatches == 0 && snapshot.ReconciliationInconclusive == 0,
            credit.Ready && credit.ReconciliationReady,
            legacyIsolated,
            productionPostingEnabled,
            explicitApproval,
            passingPromotionRehearsal,
            rollbackReady,
            promotionAllowed,
            false,
            credit,
            legacyPaths,
            markers,
            blockers.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray(),
            reportHash,
            DateTimeOffset.UtcNow);
    }

    public async Task<LedgerPromotionDryRunResult> RunPromotionDryRunAsync(
        LedgerPromotionDryRunRequest request,
        CancellationToken cancellationToken)
    {
        if (request.AuthorityMode is LedgerAuthorityMode.MONOLITH or LedgerAuthorityMode.SERVICE)
        {
            throw new LedgerAuthorityValidationException("Promotion rehearsal requires SERVICE_SHADOW or SERVICE_DRY_RUN; SERVICE remains blocked.");
        }
        if (string.IsNullOrWhiteSpace(request.OperatorReference))
        {
            throw new LedgerAuthorityValidationException("operatorReference is required.");
        }

        var startedAt = DateTimeOffset.UtcNow;
        var readiness = await BuildReadinessReportAsync(request.AuthorityMode, cancellationToken);
        var comparisons = await repository.CompareRepresentativePostingsAsync(cancellationToken);
        var comparisonBlockers = comparisons
            .Where(item => item.Status is LedgerPromotionComparisonStatus.DIVERGENCE or LedgerPromotionComparisonStatus.INCONCLUSIVE)
            .Select(item => $"{item.InstructionFamily} comparison is {item.Status}.");
        var blockers = readiness.Blockers.Concat(comparisonBlockers).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var completedAt = DateTimeOffset.UtcNow;
        var comparisonSummary = JsonSerializer.Serialize(new
        {
            total = comparisons.Count,
            match = comparisons.Count(item => item.Status == LedgerPromotionComparisonStatus.MATCH),
            acceptableDifference = comparisons.Count(item => item.Status == LedgerPromotionComparisonStatus.ACCEPTABLE_DIFFERENCE),
            divergence = comparisons.Count(item => item.Status == LedgerPromotionComparisonStatus.DIVERGENCE),
            inconclusive = comparisons.Count(item => item.Status == LedgerPromotionComparisonStatus.INCONCLUSIVE),
            comparisons
        }, JsonOptions);
        var testRequestSetHash = Hash(JsonSerializer.Serialize(
            comparisons.Select(item => new { item.InstructionFamily, item.ArtifactCount }).OrderBy(item => item.InstructionFamily),
            JsonOptions));
        var configurationHash = Hash(JsonSerializer.Serialize(new
        {
            request.AuthorityMode,
            configuredAuthority = ResolveConfiguredMode(),
            readiness.DurablePersistenceReady,
            readiness.CreditWalletDependencyReady,
            readiness.ProductionPostingEnabled,
            readiness.ServiceAuthorityEnabled
        }, JsonOptions));
        var result = blockers.Length == 0 ? "PASS" : "BLOCKED";
        var evidenceHash = Hash(JsonSerializer.Serialize(new
        {
            request.AuthorityMode,
            configurationHash,
            readiness.ReadinessReportHash,
            testRequestSetHash,
            result,
            comparisonSummary,
            blockers,
            request.OperatorReference
        }, JsonOptions));
        var rehearsal = await repository.PersistRehearsalAsync(
            DeterministicGuid(evidenceHash), request.AuthorityMode, BuildVersion, configurationHash,
            readiness.ReadinessReportHash, testRequestSetHash, result, comparisonSummary, blockers.Length,
            startedAt, completedAt, request.OperatorReference,
            request.ApprovalMetadata ?? new Dictionary<string, object?>(), evidenceHash, cancellationToken);

        return new LedgerPromotionDryRunResult(
            readiness, rehearsal, comparisons, blockers, LedgerAuthorityMode.MONOLITH, false);
    }

    public Task<LedgerRollbackReadiness> GetRollbackReadinessAsync(
        LedgerAuthorityMode? proposedMode,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var current = ResolveConfiguredMode();
        var proposed = proposedMode ?? LedgerAuthorityMode.SERVICE_DRY_RUN;
        var prerequisites = new[]
        {
            "LEDGER_AUTHORITY is changed explicitly by an operator.",
            "Rollback target is MONOLITH.",
            "Immutable Ledger journals remain the financial record.",
            "No automatic fallback is enabled."
        };
        var limitations = new[]
        {
            "Legacy direct DB/RPC callers require inventory and isolation before SERVICE promotion.",
            "Rollback is configuration-governed and does not reverse already committed journals.",
            "Cashier is outside the credit-only launch promotion scope."
        };
        var hash = Hash(JsonSerializer.Serialize(new { current, proposed, rollback = LedgerAuthorityMode.MONOLITH, prerequisites, limitations }, JsonOptions));
        return Task.FromResult(new LedgerRollbackReadiness(
            current, proposed, LedgerAuthorityMode.MONOLITH, true, false,
            prerequisites, limitations, hash, DateTimeOffset.UtcNow));
    }

    private async Task<LedgerDependencyReadiness> CheckCreditWalletAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(configuration.CreditWalletService.Url))
        {
            return new(false, false, false, false, false, false, false, null, ["CREDIT_WALLET_SERVICE_URL is not configured."]);
        }
        try
        {
            using var client = httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(3);
            using var response = await client.GetAsync($"{configuration.CreditWalletService.Url.TrimEnd('/')}/v1/credit-wallets/health", cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                return new(true, true, false, false, false, false, false, null, [$"Credit Wallet readiness returned HTTP {(int)response.StatusCode}."]);
            }
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var root = document.RootElement;
            var capabilities = root.GetProperty("capabilities");
            bool Read(string name) => capabilities.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
            var marker = capabilities.TryGetProperty("qaCapabilityMarker", out var markerValue) && markerValue.ValueKind == JsonValueKind.String
                ? markerValue.GetString()
                : null;
            var durable = Read("durablePersistenceConfigured");
            var idempotency = Read("idempotencySupportConfigured");
            var mutation = Read("mutationCapabilityEnabled");
            var scope = capabilities.TryGetProperty("mutationCapabilityScope", out var scopeValue)
                && scopeValue.ValueKind == JsonValueKind.String
                ? scopeValue.GetString()
                : null;
            var reconciliation = Read("reconciliationReady")
                || (Read("readCapabilityEnabled") && scope?.Contains("Reconcile", StringComparison.OrdinalIgnoreCase) == true);
            var ready = durable && idempotency && reconciliation && mutation && !string.IsNullOrWhiteSpace(marker);
            return new(true, true, ready, durable, mutation, idempotency, reconciliation, marker,
                ready ? [] : ["Credit Wallet capability markers are incomplete."]);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or JsonException)
        {
            return new(true, false, false, false, false, false, false, null, [$"Credit Wallet readiness failed: {error.Message}"]);
        }
    }

    private static IReadOnlyList<LedgerLegacyPathEvidence> BuildLegacyPathEvidence(LedgerAuthorityMode mode)
    {
        var service = mode == LedgerAuthorityMode.SERVICE;
        return
        [
            new("public.post_financial_ledger_entry RPC", "LEGACY_MONOLITH_POSTING", !service, "Existing monolith durable posting path remains available."),
            new("Supabase financial_ledger_entries access", "DIRECT_DB_COMPATIBILITY", !service, "Direct database compatibility path exists and has not been disabled."),
            new("Next.js Ledger authority router", "EXPLICIT_ROUTER", true, "Authority selection is explicit; no silent fallback is permitted."),
            new("Settlement financial instructions", "SERVICE_CLIENT", true, "Settlement uses idempotent Ledger Service instructions."),
            new("Governed manual adjustments", "CATALOG_ONLY", true, "Exact posting rule and version are required."),
            new("Ledger shadow endpoint", "NON_AUTHORITATIVE_SHADOW", !service, "Shadow comparison is non-authoritative and may not post production authority effects.")
        ];
    }

    private static IReadOnlyList<string> BuildMarkers(
        bool databaseReady,
        FinancialPostingCatalogReadiness catalog,
        LedgerRecoveryReadiness recovery,
        LedgerDependencyReadiness credit,
        bool promotionAllowed)
    {
        var markers = new SortedSet<string>(StringComparer.Ordinal);
        if (databaseReady) markers.Add("durable-ledger-persistence");
        markers.Add("immutable-ledger-posting");
        markers.Add("balanced-journal");
        markers.Add("conflict-safe-idempotency");
        markers.Add("reversal-only-corrections");
        if (catalog.RequiredLaunchMappingsPresent) markers.Add("credit-only-posting-catalog");
        if (recovery.PostingRecoveryReady) markers.Add("posting-recovery");
        if (recovery.ReplayReady) markers.Add("replay-verification");
        if (recovery.MinimalReconciliationReady) markers.Add("minimal-reconciliation");
        if (credit.Ready) markers.Add("credit-wallet-dependency");
        if (promotionAllowed) markers.Add("promotion-dry-run-ready");
        markers.Add("production-authority-disabled");
        markers.Add("no-silent-fallback");
        return markers.ToArray();
    }

    private LedgerAuthorityMode ResolveConfiguredMode()
    {
        var raw = Environment.GetEnvironmentVariable("LEDGER_AUTHORITY");
        if (string.IsNullOrWhiteSpace(raw)) return LedgerAuthorityMode.MONOLITH;
        return Enum.TryParse<LedgerAuthorityMode>(raw.Trim(), true, out var mode)
            ? mode
            : throw new LedgerAuthorityValidationException($"Invalid LEDGER_AUTHORITY mode '{raw}'.");
    }

    private static void AddBlockerUnless(ICollection<string> blockers, bool condition, string blocker)
    {
        if (!condition) blockers.Add(blocker);
    }

    private static string Hash(string value) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";

    private static Guid DeterministicGuid(string value) => new(SHA256.HashData(Encoding.UTF8.GetBytes(value))[..16]);
}
