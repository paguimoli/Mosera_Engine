using LedgerService.Configuration;
using LedgerService.Contracts;
using LedgerService.Application;
using LedgerService.Infrastructure;

namespace LedgerService.Controllers;

public static class HealthEndpoints
{
    public static void MapHealthEndpoints(this WebApplication app)
    {
        app.MapGet("/health", (HttpContext context, ServiceConfiguration configuration) =>
        {
            return Results.Ok(new
            {
                status = "ok",
                service = configuration.ServiceName,
                environment = configuration.Environment,
                timestamp = DateTimeOffset.UtcNow,
                correlationId = context.GetCorrelationId()
            });
        });

        app.MapGet("/health/live", (HttpContext context, ServiceConfiguration configuration) =>
        {
            return Results.Ok(new
            {
                status = "ok",
                service = configuration.ServiceName,
                timestamp = DateTimeOffset.UtcNow,
                correlationId = context.GetCorrelationId()
            });
        });

        app.MapGet("/health/ready", async (
            HttpContext context,
            ServiceConfiguration configuration,
            InfrastructureReadinessChecks readinessChecks,
            DurableLedgerService durableLedgerService,
            LedgerPostingService ledgerPostingService,
            LedgerRecoveryService recoveryService,
            FinancialPostingCatalog postingCatalog,
            CancellationToken cancellationToken) =>
        {
            var rabbitMqReady = await readinessChecks.CheckRabbitMqAsync(cancellationToken);
            var redisReady = await readinessChecks.CheckRedisAsync(cancellationToken);
            var databaseReady = await readinessChecks.CheckDatabaseAsync(cancellationToken);
            var catalog = await postingCatalog.GetReadinessAsync(cancellationToken);
            var recovery = await recoveryService.CheckReadinessAsync(cancellationToken);
            var ready = rabbitMqReady.Ready && redisReady.Ready && databaseReady.Ready
                && recovery.Reachable && recovery.Blockers.Count == 0;

            var response = new
            {
                status = ready ? "ok" : "error",
                service = configuration.ServiceName,
                timestamp = DateTimeOffset.UtcNow,
                dependencies = new
                {
                    rabbitMq = rabbitMqReady,
                    redis = redisReady,
                    database = databaseReady
                },
                capabilities = new
                {
                    mutationCapabilityEnabled = durableLedgerService.MutationCapabilityEnabled,
                    durablePersistenceConfigured = durableLedgerService.DurablePersistenceConfigured,
                    idempotencySupportConfigured = durableLedgerService.IdempotencySupportConfigured,
                    canonicalPostingContractReady = durableLedgerService.CanonicalPostingContractReady,
                    canonicalHashValidationReady = durableLedgerService.CanonicalHashValidationReady,
                    conflictSafeIdempotencyReady = durableLedgerService.ConflictSafeIdempotencyReady,
                    currencyAccountValidationReady = durableLedgerService.CurrencyAccountValidationReady,
                    immutableEntryStorageReady = durableLedgerService.ImmutableEntryStorageReady,
                    reversalOnlyCorrectionReady = durableLedgerService.ReversalOnlyCorrectionReady,
                    originalEntryValidationReady = durableLedgerService.OriginalEntryValidationReady,
                    reversalConflictProtectionReady = durableLedgerService.ReversalConflictProtectionReady,
                    settlementReversalInstructionCompatible = durableLedgerService.SettlementReversalInstructionCompatible,
                    durablePostingRequestsReady = ledgerPostingService.DurablePostingRequestsReady,
                    postingAttemptsReady = ledgerPostingService.PostingAttemptsReady,
                    unknownResultRecoveryReady = ledgerPostingService.UnknownResultRecoveryReady,
                    replayVerificationReady = ledgerPostingService.ReplayVerificationReady,
                    balancedJournalReady = ledgerPostingService.BalancedJournalReady,
                    journalPersistenceReady = ledgerPostingService.JournalPersistenceReady,
                    journalRecoveryReady = ledgerPostingService.JournalRecoveryReady,
                    reversalJournalReady = ledgerPostingService.ReversalJournalReady,
                    postingRecoveryReady = recovery.PostingRecoveryReady,
                    journalIntegrityRecoveryReady = recovery.JournalIntegrityRecoveryReady,
                    minimalReconciliationReady = recovery.MinimalReconciliationReady,
                    unknownResultHandlingReady = recovery.UnknownResultHandlingReady,
                    unresolvedReconciliationMismatches = recovery.UnresolvedMismatches,
                    unresolvedReconciliationInconclusive = recovery.UnresolvedInconclusive,
                    recoveryBlockers = recovery.Blockers,
                    postingCatalogLoaded = catalog.CatalogLoaded,
                    requiredLaunchMappingsPresent = catalog.RequiredLaunchMappingsPresent,
                    exactRuleResolutionReady = catalog.ExactRuleResolutionReady,
                    accountRoleResolutionReady = catalog.AccountRoleResolutionReady,
                    settlementMappingsReady = catalog.SettlementMappingsReady,
                    commissionAccrualMappingReady = catalog.CommissionAccrualMappingReady,
                    rebateMappingReady = catalog.RebateMappingReady,
                    promotionMappingReady = catalog.PromotionMappingReady,
                    manualAdjustmentMappingReady = catalog.ManualAdjustmentMappingReady,
                    stakeRecognitionReady = catalog.StakeRecognitionReady,
                    freePlayReady = catalog.FreePlayReady,
                    cashierMappingsDisabled = catalog.CashierMappingsDisabled,
                    postingCatalogBlockers = catalog.Blockers,
                    serviceAuthorityEnabled = false,
                    qaCapabilityMarker = durableLedgerService.MutationCapabilityEnabled
                        ? "ledger-service-authority-dry-run"
                        : null
                },
                correlationId = context.GetCorrelationId()
            };

            return ready ? Results.Ok(response) : Results.Json(response, statusCode: 503);
        });

        app.MapGet("/v1/ledger/health", async (
            HttpContext context,
            ServiceConfiguration configuration,
            InfrastructureReadinessChecks readinessChecks,
            DurableLedgerService durableLedgerService,
            LedgerPostingService ledgerPostingService,
            LedgerRecoveryService recoveryService,
            FinancialPostingCatalog postingCatalog,
            CancellationToken cancellationToken) =>
        {
            var rabbitMqReady = await readinessChecks.CheckRabbitMqAsync(cancellationToken);
            var redisReady = await readinessChecks.CheckRedisAsync(cancellationToken);
            var databaseReady = await readinessChecks.CheckDatabaseAsync(cancellationToken);
            var catalog = await postingCatalog.GetReadinessAsync(cancellationToken);
            var recovery = await recoveryService.CheckReadinessAsync(cancellationToken);
            var dependencies = new Dictionary<string, string>
            {
                ["database"] = databaseReady.Ready ? "ready" : "not_ready",
                ["rabbitmq"] = rabbitMqReady.Ready ? "ready" : "not_ready",
                ["redis"] = redisReady.Ready ? "ready" : "not_ready"
            };
            var ready = rabbitMqReady.Ready && redisReady.Ready && databaseReady.Ready
                && recovery.Reachable && recovery.Blockers.Count == 0;

            var response = new LedgerHealthResponse(
                ready ? "ok" : "error",
                configuration.ServiceName,
                "0.1.0",
                DateTimeOffset.UtcNow,
                dependencies,
                new LedgerCapabilityMarkers(
                    durableLedgerService.MutationCapabilityEnabled,
                    durableLedgerService.DurablePersistenceConfigured,
                    durableLedgerService.IdempotencySupportConfigured,
                    durableLedgerService.CanonicalPostingContractReady,
                    durableLedgerService.CanonicalHashValidationReady,
                    durableLedgerService.ConflictSafeIdempotencyReady,
                    durableLedgerService.CurrencyAccountValidationReady,
                    durableLedgerService.ImmutableEntryStorageReady,
                    durableLedgerService.ReversalOnlyCorrectionReady,
                    durableLedgerService.OriginalEntryValidationReady,
                    durableLedgerService.ReversalConflictProtectionReady,
                    durableLedgerService.SettlementReversalInstructionCompatible,
                    ledgerPostingService.DurablePostingRequestsReady,
                    ledgerPostingService.PostingAttemptsReady,
                    ledgerPostingService.UnknownResultRecoveryReady,
                    ledgerPostingService.ReplayVerificationReady,
                    ledgerPostingService.BalancedJournalReady,
                    ledgerPostingService.JournalPersistenceReady,
                    ledgerPostingService.JournalRecoveryReady,
                    ledgerPostingService.ReversalJournalReady,
                    recovery.PostingRecoveryReady,
                    recovery.JournalIntegrityRecoveryReady,
                    recovery.MinimalReconciliationReady,
                    recovery.UnknownResultHandlingReady,
                    recovery.UnresolvedMismatches,
                    recovery.UnresolvedInconclusive,
                    catalog.CatalogLoaded,
                    catalog.RequiredLaunchMappingsPresent,
                    catalog.ExactRuleResolutionReady,
                    catalog.AccountRoleResolutionReady,
                    catalog.SettlementMappingsReady,
                    catalog.CommissionAccrualMappingReady,
                    catalog.RebateMappingReady,
                    catalog.PromotionMappingReady,
                    catalog.ManualAdjustmentMappingReady,
                    catalog.StakeRecognitionReady,
                    catalog.FreePlayReady,
                    catalog.CashierMappingsDisabled,
                    false,
                    durableLedgerService.MutationCapabilityEnabled
                        ? "ledger-service-authority-dry-run"
                        : null),
                context.GetCorrelationId());

            return ready ? Results.Ok(response) : Results.Json(response, statusCode: 503);
        });
    }
}
