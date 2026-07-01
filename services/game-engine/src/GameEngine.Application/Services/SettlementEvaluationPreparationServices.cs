using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public interface ISettlementEvaluationReadModel
{
    IReadOnlyCollection<SettlementEvaluationRecord> ListSettlementReadyRecords(bool includeConsumed = false);

    IReadOnlyCollection<SettlementEvaluationBatch> ListBatches();

    IReadOnlyCollection<SettlementEvaluationRunSummary> ListRunSummaries();
}

public sealed class SettlementEvaluationReadService(
    IEvaluationRunRepository runRepository,
    IEvaluationBatchRepository batchRepository,
    EvaluationPersistenceService persistenceService)
    : ISettlementEvaluationReadModel
{
    public IReadOnlyCollection<SettlementEvaluationRecord> ListSettlementReadyRecords(bool includeConsumed = false)
    {
        var completedRunIds = runRepository.GetRuns()
            .Where(run => run.Status == EvaluationRunStatus.Completed)
            .Select(run => run.Id)
            .ToHashSet();

        return persistenceService.GetAll()
            .Where(record => completedRunIds.Contains(record.RunId))
            .Select(ToSettlementRecord)
            .Where(record => IsEvaluable(record.Outcome))
            .Where(record => includeConsumed || record.ConsumerStatus != SettlementEvaluationConsumerStatus.Consumed)
            .OrderBy(record => record.EvaluatedAt)
            .ToArray();
    }

    public IReadOnlyCollection<SettlementEvaluationBatch> ListBatches()
    {
        return runRepository.GetRuns()
            .SelectMany(run => batchRepository.GetBatches(run.Id))
            .OrderBy(batch => batch.Sequence)
            .Select(batch =>
            {
                var records = persistenceService.GetByBatch(batch.Id).Select(ToSettlementRecord).ToArray();
                var readyCount = records.Count(record => IsEvaluable(record.Outcome) && record.ConsumerStatus != SettlementEvaluationConsumerStatus.Consumed);
                return new SettlementEvaluationBatch(
                    batch.Id,
                    batch.EvaluationRunId,
                    batch.Sequence,
                    batch.Status,
                    readyCount,
                    records.Length - readyCount,
                    DateTimeOffset.UtcNow);
            })
            .ToArray();
    }

    public IReadOnlyCollection<SettlementEvaluationRunSummary> ListRunSummaries()
    {
        return runRepository.GetRuns()
            .Select(run =>
            {
                var records = persistenceService.GetByRun(run.Id).Select(ToSettlementRecord).ToArray();
                var readyCount = run.Status == EvaluationRunStatus.Completed
                    ? records.Count(record => IsEvaluable(record.Outcome) && record.ConsumerStatus != SettlementEvaluationConsumerStatus.Consumed)
                    : 0;
                return new SettlementEvaluationRunSummary(
                    run.Id,
                    run.DrawId,
                    run.GameBindingId,
                    run.Status,
                    readyCount,
                    records.Length - readyCount,
                    SettlementIntegrationEnabled: false,
                    DateTimeOffset.UtcNow);
            })
            .ToArray();
    }

    public SettlementEvaluationConsumerCursor GetCursor(int pageSize = 100)
    {
        var latest = ListSettlementReadyRecords()
            .OrderByDescending(record => record.EvaluatedAt)
            .FirstOrDefault();
        return new SettlementEvaluationConsumerCursor(
            latest?.EvaluationRecordId,
            latest?.EvaluatedAt,
            pageSize,
            DateTimeOffset.UtcNow);
    }

    private static bool IsEvaluable(GameEvaluationOutcome outcome)
    {
        return outcome is GameEvaluationOutcome.Win or GameEvaluationOutcome.Loss or GameEvaluationOutcome.Push;
    }

    private static SettlementEvaluationRecord ToSettlementRecord(ImmutableEvaluationRecord record)
    {
        var consumerStatus = ReadConsumerStatus(record);
        return new SettlementEvaluationRecord(
            record.Id,
            record.RunId,
            record.BatchId,
            record.TicketId,
            record.DrawId,
            record.GameId,
            record.IdempotencyKey,
            record.Outcome,
            record.ReasonCode,
            record.Amount,
            record.ModuleId,
            record.ModuleVersion,
            record.EvaluatorVersion,
            record.PaytableVersion,
            consumerStatus,
            ReadDateTimeOffset(record.EvaluationMetadata, "settlementConsumedAt"),
            ReadString(record.EvaluationMetadata, "settlementConsumedBy"),
            ReadGuid(record.EvaluationMetadata, "settlementConsumerCorrelationId"),
            record.EvaluatedAt);
    }

    private static SettlementEvaluationConsumerStatus ReadConsumerStatus(ImmutableEvaluationRecord record)
    {
        var raw = ReadString(record.EvaluationMetadata, "settlementConsumerStatus");
        return Enum.TryParse<SettlementEvaluationConsumerStatus>(raw, ignoreCase: true, out var status)
            ? status
            : SettlementEvaluationConsumerStatus.NotConsumed;
    }

    private static string? ReadString(IReadOnlyDictionary<string, object?> metadata, string key)
    {
        return metadata.TryGetValue(key, out var value) ? value?.ToString() : null;
    }

    private static Guid? ReadGuid(IReadOnlyDictionary<string, object?> metadata, string key)
    {
        return Guid.TryParse(ReadString(metadata, key), out var value) ? value : null;
    }

    private static DateTimeOffset? ReadDateTimeOffset(IReadOnlyDictionary<string, object?> metadata, string key)
    {
        return DateTimeOffset.TryParse(ReadString(metadata, key), out var value) ? value : null;
    }
}

public sealed class SettlementConsumerActivationGate(EvaluationPersistenceService persistenceService)
{
    public SettlementConsumerActivationStatus GetStatus()
    {
        var storage = persistenceService.GetStorageStatus();
        var requirements = new[]
        {
            new SettlementConsumerActivationRequirement("DURABLE_STORAGE_ENABLED", storage.DurableRepositoryWiringEnabled, "Durable repository implementation is active."),
            new SettlementConsumerActivationRequirement("EVALUATION_RECORDS_IMMUTABLE", storage.AppendOnlyGuardDesigned, "Evaluation records are append-only and immutable."),
            new SettlementConsumerActivationRequirement("EVALUATION_RUN_COMPLETED", false, "A completed evaluation run is selected for settlement consumption."),
            new SettlementConsumerActivationRequirement("GAME_BINDING_APPROVED", false, "The game binding is approved for settlement consumption."),
            new SettlementConsumerActivationRequirement("MODULE_VERSION_APPROVED", false, "The module version is approved for settlement consumption."),
            new SettlementConsumerActivationRequirement("DRAW_CERTIFIED", false, "The draw result is officially certified."),
            new SettlementConsumerActivationRequirement("SETTLEMENT_CONSUMER_APPROVED", false, "Operator approval exists for the Settlement consumer."),
            new SettlementConsumerActivationRequirement("FINANCIAL_AUTHORITY_READY", false, "Financial authorities are ready for Game Engine settlement intake."),
            new SettlementConsumerActivationRequirement("QA_SETTLEMENT_INTEGRATION_PASS", false, "Settlement integration QA has passed.")
        };
        var blockers = requirements
            .Where(requirement => !requirement.Satisfied)
            .Select(requirement => requirement.Description)
            .ToArray();

        return new SettlementConsumerActivationStatus(
            Enabled: false,
            ActivationAllowed: false,
            requirements,
            blockers,
            [
                "Settlement consumer activation is intentionally disabled in Phase 22.6L."
            ],
            SettlementMutationPerformed: false,
            FinancialMutationPerformed: false,
            DateTimeOffset.UtcNow);
    }
}
