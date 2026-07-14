using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SettlementService.Configuration;
using SettlementService.Contracts;
using SettlementService.Infrastructure;

namespace SettlementService.Application;

public sealed class SettlementAuthorityService(
    ServiceConfiguration configuration,
    SettlementInputIngestionService inputIngestionService,
    SettlementExecutionService executionService,
    FinancialInstructionService financialInstructionService,
    SettlementRecoveryService recoveryService,
    ResettlementService resettlementService,
    SettlementLedgerServiceClient ledgerClient,
    SettlementCreditWalletServiceClient creditClient,
    SettlementPromotionRepository repository)
{
    private const string ServiceBuildVersion = "settlement-authority-guardrails-v1";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    public async Task<SettlementAuthorityReadinessReport> BuildReadinessReportAsync(
        SettlementAuthorityMode? requestedMode,
        CancellationToken cancellationToken)
    {
        var mode = requestedMode ?? ResolveAuthorityMode();
        var ingestion = await inputIngestionService.CheckReadinessAsync(cancellationToken);
        var execution = await executionService.CheckReadinessAsync(cancellationToken);
        var instructions = await financialInstructionService.CheckReadinessAsync(cancellationToken);
        var recovery = await recoveryService.CheckReadinessAsync(cancellationToken);
        var resettlement = await resettlementService.CheckReadinessAsync(cancellationToken);
        var ledger = await ledgerClient.CheckReadinessAsync(cancellationToken);
        var credit = await creditClient.CheckReadinessAsync(cancellationToken);
        var snapshot = await repository.GetOperationalSnapshotAsync(cancellationToken);
        var databaseConfigured = !string.IsNullOrWhiteSpace(configuration.Database.Url);
        var markers = BuildCapabilityMarkers(ingestion, execution, instructions, recovery, resettlement);
        var blockers = new List<string>();

        AddBlockerUnless(blockers, ingestion.RepositoryReachable && ingestion.SettlementInputValidationReady, "SettlementInput ingestion is not ready.");
        AddBlockerUnless(blockers, ingestion.FinancialContextValidationReady, "Financial context validation is not ready.");
        AddBlockerUnless(blockers, execution.RepositoryReachable && execution.SettlementExecutionReady, "Authoritative SettlementRecord execution is not ready.");
        AddBlockerUnless(blockers, execution.SettlementPolicyReady, "Settlement policy readiness is missing.");
        AddBlockerUnless(blockers, databaseConfigured && execution.RepositoryReachable, "Durable settlement persistence is not reachable.");
        AddBlockerUnless(blockers, ingestion.IdempotencyReady && instructions.IdempotencyExecutionReady, "Idempotency readiness is incomplete.");
        AddBlockerUnless(blockers, execution.SettlementReplayReady && recovery.ReplayReady, "Replay readiness is incomplete.");
        AddBlockerUnless(blockers, recovery.RecoveryReady && recovery.ResumeReady, "Batch/recovery readiness is incomplete.");
        AddBlockerUnless(blockers, instructions.FinancialInstructionGenerationReady, "Financial instruction generation is not ready.");
        AddBlockerUnless(blockers, ledger.Ready && ledger.MutationCapabilityEnabled && ledger.DurablePersistenceConfigured && ledger.IdempotencySupportConfigured, "Ledger Service execution readiness is incomplete.");
        AddBlockerUnless(blockers, credit.Ready && credit.MutationCapabilityEnabled && credit.DurablePersistenceConfigured && credit.IdempotencySupportConfigured, "Credit Wallet Service execution readiness is incomplete.");
        AddBlockerUnless(blockers, instructions.PartialFailureRecoveryReady && recovery.RecoveryReady, "Partial-failure recovery is not ready.");
        AddBlockerUnless(blockers, recovery.InstructionReconciliationReady, "Instruction reconciliation is not ready.");
        AddBlockerUnless(blockers, resettlement.RepositoryReachable && resettlement.ResettlementValidationReady && resettlement.ReversalCalculationReady && resettlement.ReversalInstructionGenerationReady && resettlement.CorrectedSettlementCreationReady && resettlement.ResettlementRecoveryReady, "Resettlement/reversal readiness is incomplete.");
        AddBlockerUnless(blockers, snapshot.UnresolvedFailedInstructions == 0, "Unresolved failed financial instructions block promotion.");
        AddBlockerUnless(blockers, snapshot.AwaitingVerificationItems == 0, "AwaitingVerification items block promotion.");
        AddBlockerUnless(blockers, snapshot.MissingImmutableReferenceItems == 0, "Missing immutable references block promotion.");
        AddBlockerUnless(blockers, mode != SettlementAuthorityMode.SERVICE, "Production SERVICE authority activation is intentionally blocked in this phase.");
        if (mode == SettlementAuthorityMode.SERVICE)
        {
            blockers.Add("Production posting is not explicitly enabled.");
            blockers.Add("Production authority approval evidence is not configured.");
            blockers.Add("Production rollback target evidence is not recorded.");
            blockers.Add("Production environment confirmation is not enabled.");
        }

        var productionPostingEnabled = false;
        var authorityActivationEnabled = mode == SettlementAuthorityMode.SERVICE && blockers.Count == 0;
        var legacyIsolated = mode != SettlementAuthorityMode.SERVICE ||
            markers.Contains("legacy-path-isolation");
        var reportSeed = new
        {
            mode,
            ingestion,
            execution,
            instructions,
            recovery,
            resettlement,
            ledger,
            credit,
            snapshot,
            blockers,
            markers
        };
        var hash = HashCanonical(JsonSerializer.Serialize(reportSeed, JsonOptions));

        return new SettlementAuthorityReadinessReport(
            mode,
            ingestion.RepositoryReachable && ingestion.SettlementInputValidationReady,
            ingestion.FinancialContextValidationReady,
            execution.RepositoryReachable && execution.SettlementExecutionReady,
            execution.SettlementPolicyReady,
            databaseConfigured && execution.RepositoryReachable,
            ingestion.IdempotencyReady && instructions.IdempotencyExecutionReady,
            execution.SettlementReplayReady && recovery.ReplayReady,
            recovery.RecoveryReady && recovery.ResumeReady,
            instructions.FinancialInstructionGenerationReady,
            ledger.Ready && ledger.MutationCapabilityEnabled && ledger.DurablePersistenceConfigured && ledger.IdempotencySupportConfigured,
            credit.Ready && credit.MutationCapabilityEnabled && credit.DurablePersistenceConfigured && credit.IdempotencySupportConfigured,
            instructions.PartialFailureRecoveryReady && recovery.RecoveryReady,
            recovery.InstructionReconciliationReady,
            resettlement.RepositoryReachable && resettlement.ResettlementValidationReady && resettlement.ReversalCalculationReady && resettlement.ReversalInstructionGenerationReady && resettlement.CorrectedSettlementCreationReady && resettlement.ResettlementRecoveryReady,
            legacyIsolated,
            productionPostingEnabled,
            authorityActivationEnabled,
            blockers.Count == 0 && mode is SettlementAuthorityMode.SERVICE_SHADOW or SettlementAuthorityMode.SERVICE_DRY_RUN,
            legacyIsolated ? "explicit_compatibility_only" : "not_isolated",
            productionPostingEnabled ? "enabled" : "disabled",
            authorityActivationEnabled ? "enabled" : "blocked",
            ledger,
            credit,
            markers,
            blockers,
            hash,
            DateTimeOffset.UtcNow);
    }

    public async Task<SettlementPromotionDryRunResult> RunPromotionDryRunAsync(
        SettlementPromotionDryRunRequest request,
        CancellationToken cancellationToken)
    {
        if (request.AuthorityMode == SettlementAuthorityMode.SERVICE)
        {
            throw new SettlementAuthorityValidationException("Production SERVICE authority remains blocked for this phase.");
        }

        if (request.AuthorityMode == SettlementAuthorityMode.MONOLITH)
        {
            throw new SettlementAuthorityValidationException("Promotion rehearsal requires SERVICE_SHADOW or SERVICE_DRY_RUN mode.");
        }

        var startedAt = DateTimeOffset.UtcNow;
        var readiness = await BuildReadinessReportAsync(request.AuthorityMode, cancellationToken);
        var selected = request.SettlementRequestIds is { Count: > 0 }
            ? request.SettlementRequestIds
            : await repository.ListRepresentativeSettlementRequestsAsync(10, cancellationToken);
        var comparisons = await repository.CompareSettlementRequestsAsync(selected, cancellationToken);
        var comparisonBlockers = comparisons
            .Where(item => item.Status is SettlementPromotionComparisonStatus.DIVERGENCE or SettlementPromotionComparisonStatus.INCONCLUSIVE)
            .Select(item => $"Comparison {item.Status} for request {item.SettlementRequestId}.")
            .ToList();
        var blockers = readiness.Blockers.Concat(comparisonBlockers).Distinct(StringComparer.Ordinal).ToList();
        var completedAt = DateTimeOffset.UtcNow;
        var testRequestSetHash = HashCanonical(JsonSerializer.Serialize(selected.OrderBy(id => id), JsonOptions));
        var configurationHash = HashCanonical(JsonSerializer.Serialize(new
        {
            request.AuthorityMode,
            ledgerConfigured = readiness.LedgerService.Configured,
            creditConfigured = readiness.CreditWalletService.Configured,
            posting = readiness.ProductionPostingStatus,
            activation = readiness.AuthorityActivationStatus
        }, JsonOptions));
        var resultSummary = blockers.Count == 0 ? "PASS" : "BLOCKED";
        var comparisonSummary = JsonSerializer.Serialize(new
        {
            total = comparisons.Count,
            match = comparisons.Count(item => item.Status == SettlementPromotionComparisonStatus.MATCH),
            acceptableDifference = comparisons.Count(item => item.Status == SettlementPromotionComparisonStatus.ACCEPTABLE_DIFFERENCE),
            divergence = comparisons.Count(item => item.Status == SettlementPromotionComparisonStatus.DIVERGENCE),
            inconclusive = comparisons.Count(item => item.Status == SettlementPromotionComparisonStatus.INCONCLUSIVE)
        }, JsonOptions);
        var evidenceSeed = JsonSerializer.Serialize(new
        {
            request.AuthorityMode,
            configurationHash,
            readiness.ReadinessReportHash,
            testRequestSetHash,
            resultSummary,
            comparisonSummary,
            blockers,
            startedAt,
            completedAt,
            request.OperatorReference
        }, JsonOptions);
        var evidenceHash = HashCanonical(evidenceSeed);
        var rehearsalId = CreateDeterministicGuid(evidenceHash);
        var rehearsal = await repository.PersistRehearsalAsync(
            rehearsalId,
            request.AuthorityMode,
            ServiceBuildVersion,
            configurationHash,
            readiness.ReadinessReportHash,
            testRequestSetHash,
            resultSummary,
            comparisonSummary,
            blockers.Count,
            startedAt,
            completedAt,
            request.OperatorReference,
            request.ApprovalMetadata ?? new Dictionary<string, object?>(),
            evidenceHash,
            cancellationToken);

        return new SettlementPromotionDryRunResult(
            readiness,
            rehearsal,
            comparisons,
            blockers,
            SettlementAuthorityMode.MONOLITH.ToString(),
            false);
    }

    public Task<SettlementRollbackReadiness> GetRollbackReadinessAsync(
        SettlementAuthorityMode? proposedAuthority,
        CancellationToken cancellationToken)
    {
        var current = ResolveAuthorityMode();
        var proposed = proposedAuthority ?? SettlementAuthorityMode.SERVICE_DRY_RUN;
        var prerequisites = new[]
        {
            "SETTLEMENT_AUTHORITY must be explicitly set.",
            "Rollback authority must be MONOLITH.",
            "No automatic fallback is permitted.",
            "SettlementInput-backed evidence remains immutable."
        };
        var limitations = new[]
        {
            "Legacy run-based settlement remains compatibility/dry-run only.",
            "Production SERVICE authority is intentionally blocked.",
            "Rollback is configuration-governed; no runtime auto-downgrade exists."
        };
        var generatedAt = DateTimeOffset.UtcNow;
        var hash = HashCanonical(JsonSerializer.Serialize(new
        {
            current,
            proposed,
            rollback = SettlementAuthorityMode.MONOLITH,
            prerequisites,
            limitations,
            generatedAt
        }, JsonOptions));

        return Task.FromResult(new SettlementRollbackReadiness(
            current,
            proposed,
            SettlementAuthorityMode.MONOLITH,
            true,
            prerequisites,
            limitations,
            hash,
            generatedAt));
    }

    private SettlementAuthorityMode ResolveAuthorityMode()
    {
        var raw = Environment.GetEnvironmentVariable("SETTLEMENT_AUTHORITY");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return SettlementAuthorityMode.MONOLITH;
        }

        return Enum.TryParse<SettlementAuthorityMode>(raw.Trim(), true, out var mode)
            ? mode
            : throw new SettlementAuthorityValidationException($"Invalid SETTLEMENT_AUTHORITY mode '{raw}'.");
    }

    private static IReadOnlyList<string> BuildCapabilityMarkers(
        SettlementIngestionReadiness ingestion,
        SettlementExecutionReadiness execution,
        FinancialInstructionReadiness instructions,
        SettlementRecoveryReadiness recovery,
        ResettlementReadiness resettlement)
    {
        var markers = new SortedSet<string>(StringComparer.Ordinal);
        if (ingestion.RepositoryReachable && ingestion.SettlementInputValidationReady) markers.Add("settlement-input-ingestion");
        if (ingestion.FinancialContextValidationReady) markers.Add("financial-context-validation");
        if (execution.RepositoryReachable && execution.SettlementExecutionReady) markers.Add("authoritative-settlement-execution");
        if (execution.SettlementPolicyReady) markers.Add("settlement-policy");
        if (execution.RepositoryReachable) markers.Add("durable-settlement-persistence");
        if (ingestion.IdempotencyReady && instructions.IdempotencyExecutionReady) markers.Add("settlement-idempotency");
        if (execution.SettlementReplayReady && recovery.ReplayReady) markers.Add("settlement-replay");
        if (recovery.RecoveryReady && recovery.ResumeReady) markers.Add("settlement-recovery-resume");
        if (instructions.FinancialInstructionGenerationReady) markers.Add("financial-instruction-generation");
        if (instructions.PartialFailureRecoveryReady) markers.Add("partial-failure-recovery");
        if (recovery.InstructionReconciliationReady) markers.Add("instruction-reconciliation");
        if (resettlement.ResettlementValidationReady && resettlement.ReversalCalculationReady && resettlement.ReversalInstructionGenerationReady && resettlement.CorrectedSettlementCreationReady) markers.Add("resettlement-reversal");
        markers.Add("legacy-path-isolation");
        markers.Add("production-authority-disabled");
        return markers.ToList();
    }

    private static void AddBlockerUnless(List<string> blockers, bool condition, string blocker)
    {
        if (!condition)
        {
            blockers.Add(blocker);
        }
    }

    private static string HashCanonical(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }

    private static Guid CreateDeterministicGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes[..16]);
    }
}

public sealed class SettlementAuthorityValidationException(string message)
    : Exception(message);
