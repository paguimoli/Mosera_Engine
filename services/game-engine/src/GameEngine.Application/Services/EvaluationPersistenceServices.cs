using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed record EvaluationRecordPersistenceResult(
    EvaluationDuplicateStatus Status,
    ImmutableEvaluationRecord Record,
    bool Created);

public interface IEvaluationRecordRepository
{
    EvaluationRecordPersistenceResult InsertEvaluationRecord(ImmutableEvaluationRecord record);

    ImmutableEvaluationRecord? FindById(Guid id);

    ImmutableEvaluationRecord? FindByIdempotencyKey(string idempotencyKey);

    IReadOnlyCollection<ImmutableEvaluationRecord> GetAll();

    IReadOnlyCollection<ImmutableEvaluationRecord> GetByRun(Guid runId);

    IReadOnlyCollection<ImmutableEvaluationRecord> GetByDraw(Guid drawId);

    IReadOnlyCollection<ImmutableEvaluationRecord> GetByTicket(Guid ticketId);

    IReadOnlyCollection<ImmutableEvaluationRecord> GetByBatch(Guid batchId);
}

public interface IEvaluationRunRepository
{
    IReadOnlyCollection<EvaluationRunDefinition> GetRuns();

    EvaluationRunDefinition? GetRun(Guid runId);
}

public interface IEvaluationBatchRepository
{
    IReadOnlyCollection<EvaluationBatchDefinition> GetBatches(Guid runId);

    EvaluationBatchDefinition? GetBatch(Guid batchId);
}

public interface IEvaluationCheckpointRepository
{
    PersistedEvaluationCheckpoint UpsertCheckpoint(
        EvaluationRunDefinition run,
        EvaluationBatchDefinition batch,
        int processedCount,
        int failedCount,
        EvaluationCheckpointStatus status);

    IReadOnlyCollection<PersistedEvaluationCheckpoint> GetCheckpoints();

    IReadOnlyCollection<PersistedEvaluationCheckpoint> GetCheckpoints(Guid runId);
}

public sealed class OrchestratorEvaluationRunRepository(EvaluationOrchestrator orchestrator) : IEvaluationRunRepository
{
    public IReadOnlyCollection<EvaluationRunDefinition> GetRuns() => orchestrator.GetRuns();

    public EvaluationRunDefinition? GetRun(Guid runId) => orchestrator.GetRun(runId);
}

public sealed class OrchestratorEvaluationBatchRepository(EvaluationOrchestrator orchestrator) : IEvaluationBatchRepository
{
    public IReadOnlyCollection<EvaluationBatchDefinition> GetBatches(Guid runId) => orchestrator.GetBatches(runId);

    public EvaluationBatchDefinition? GetBatch(Guid batchId) => orchestrator.GetBatch(batchId);
}

public sealed class InMemoryEvaluationRecordRepository : IEvaluationRecordRepository
{
    private readonly Dictionary<Guid, ImmutableEvaluationRecord> recordsById = [];
    private readonly Dictionary<string, ImmutableEvaluationRecord> recordsByIdempotencyKey = new(StringComparer.OrdinalIgnoreCase);

    public EvaluationRecordPersistenceResult InsertEvaluationRecord(ImmutableEvaluationRecord record)
    {
        if (recordsByIdempotencyKey.TryGetValue(record.IdempotencyKey, out var existingByKey))
        {
            return new EvaluationRecordPersistenceResult(EvaluationDuplicateStatus.DuplicateReturnedExisting, existingByKey, Created: false);
        }

        if (recordsById.TryGetValue(record.Id, out var existingById))
        {
            return new EvaluationRecordPersistenceResult(EvaluationDuplicateStatus.DuplicateReturnedExisting, existingById, Created: false);
        }

        recordsById[record.Id] = record;
        recordsByIdempotencyKey[record.IdempotencyKey] = record;
        return new EvaluationRecordPersistenceResult(EvaluationDuplicateStatus.Created, record, Created: true);
    }

    public ImmutableEvaluationRecord? FindById(Guid id) => recordsById.GetValueOrDefault(id);

    public ImmutableEvaluationRecord? FindByIdempotencyKey(string idempotencyKey) => recordsByIdempotencyKey.GetValueOrDefault(idempotencyKey);

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetAll()
    {
        return recordsById.Values.OrderBy(record => record.EvaluatedAt).ToArray();
    }

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByRun(Guid runId)
    {
        return GetAll().Where(record => record.RunId == runId).ToArray();
    }

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByDraw(Guid drawId)
    {
        return GetAll().Where(record => record.DrawId == drawId).ToArray();
    }

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByTicket(Guid ticketId)
    {
        return GetAll().Where(record => record.TicketId == ticketId).ToArray();
    }

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByBatch(Guid batchId)
    {
        return GetAll().Where(record => record.BatchId == batchId).ToArray();
    }
}

public sealed class EvaluationPersistenceService(
    IEvaluationRecordRepository repository,
    ITicketReader ticketReader)
    : IEvaluationCheckpointRepository
{
    private readonly Dictionary<Guid, PersistedEvaluationCheckpoint> checkpointsByBatch = [];

    public EvaluationRecordPersistenceResult InsertEvaluationRecord(ImmutableEvaluationRecord record)
    {
        return repository.InsertEvaluationRecord(record);
    }

    public ImmutableEvaluationRecord? FindById(Guid id) => repository.FindById(id);

    public ImmutableEvaluationRecord? FindByIdempotencyKey(string idempotencyKey) => repository.FindByIdempotencyKey(idempotencyKey);

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetAll() => repository.GetAll();

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByRun(Guid runId) => repository.GetByRun(runId);

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByDraw(Guid drawId) => repository.GetByDraw(drawId);

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByTicket(Guid ticketId) => repository.GetByTicket(ticketId);

    public IReadOnlyCollection<ImmutableEvaluationRecord> GetByBatch(Guid batchId) => repository.GetByBatch(batchId);

    public PersistedEvaluationCheckpoint UpsertCheckpoint(
        EvaluationRunDefinition run,
        EvaluationBatchDefinition batch,
        int processedCount,
        int failedCount,
        EvaluationCheckpointStatus status)
    {
        var now = DateTimeOffset.UtcNow;
        var existing = checkpointsByBatch.GetValueOrDefault(batch.Id);
        var checkpoint = new PersistedEvaluationCheckpoint(
            run.Id,
            batch.Id,
            batch.CheckpointCursor,
            processedCount,
            failedCount,
            batch.RetryCount,
            status,
            existing?.CreatedAt ?? now,
            now);

        checkpointsByBatch[batch.Id] = checkpoint;
        return checkpoint;
    }

    public IReadOnlyCollection<PersistedEvaluationCheckpoint> GetCheckpoints()
    {
        return checkpointsByBatch.Values.OrderBy(checkpoint => checkpoint.UpdatedAt).ToArray();
    }

    public IReadOnlyCollection<PersistedEvaluationCheckpoint> GetCheckpoints(Guid runId)
    {
        return GetCheckpoints().Where(checkpoint => checkpoint.RunId == runId).ToArray();
    }

    public EvaluationStorageDiagnostics GetDiagnostics()
    {
        var ticketSourceCount = ticketReader is DatabaseTicketReader databaseTicketReader
            ? databaseTicketReader.GetTicketSourceCount()
            : 0;

        return new EvaluationStorageDiagnostics(
            repository.GetAll().Count,
            checkpointsByBatch.Count,
            ticketSourceCount,
            DurableSchemaArtifactPresent: true,
            DurableRepositoryWiringEnabled: false,
            AppendOnlyGuardDesigned: true,
            SettlementIntegrationEnabled: false,
            FinancialPostingEnabled: false,
            ReplaySafePersistenceEnabled: true,
            DateTimeOffset.UtcNow);
    }

    public DurableEvaluationStorageStatus GetStorageStatus()
    {
        return new DurableEvaluationStorageStatus(
            DurableSchemaArtifactPresent: true,
            DurableRepositoryContractsPresent: true,
            DurableRepositoryWiringEnabled: false,
            AppendOnlyGuardDesigned: true,
            AppendOnlyTriggerDrafted: true,
            IdempotencyConstraintDocumented: true,
            SettlementConsumerIntegrationEnabled: false,
            FinancialPostingEnabled: false,
            [
                "game_engine.evaluation_runs",
                "game_engine.evaluation_batches",
                "game_engine.evaluation_records",
                "game_engine.evaluation_checkpoints"
            ],
            [
                "Durable database repository wiring is not active in the skeleton runtime.",
                "Settlement consumer activation is intentionally disabled."
            ],
            [
                "Schema is a draft artifact until applied through a governed migration process."
            ],
            DateTimeOffset.UtcNow);
    }
}

public sealed class DatabaseTicketReader : ITicketReader
{
    public IReadOnlyCollection<TicketReadModel> ReadBatch(TicketReadRequest request)
    {
        return BuildTickets(request.DrawId, request.GameId, request.StartInclusive, request.EndExclusive, request.Configuration);
    }

    public IReadOnlyCollection<TicketReadModel> ReadByRange(Guid drawId, Guid gameId, int startInclusive, int endExclusive)
    {
        return BuildTickets(drawId, gameId, startInclusive, endExclusive, new Dictionary<string, object?>());
    }

    public IReadOnlyCollection<TicketReadModel> ReadByCursor(Guid drawId, Guid gameId, string cursor, int limit)
    {
        var start = int.TryParse(cursor, out var parsed) ? parsed : 0;
        return BuildTickets(drawId, gameId, start, start + Math.Max(1, limit), new Dictionary<string, object?>());
    }

    public int GetTicketSourceCount() => 500;

    private static IReadOnlyCollection<TicketReadModel> BuildTickets(
        Guid drawId,
        Guid gameId,
        int startInclusive,
        int endExclusive,
        IReadOnlyDictionary<string, object?> configuration)
    {
        var paytable = new Dictionary<string, object?>
        {
            ["KenoSpot:5:5"] = 50m,
            ["KenoSpot:3:3"] = 20m,
            ["KenoBullseye:WIN"] = 25m,
            ["KenoOddEven:WIN"] = 18m
        };
        var tickets = new List<TicketReadModel>();
        var count = Math.Max(0, Math.Min(50, endExclusive - startInclusive));

        for (var index = 0; index < count; index += 1)
        {
            var ticketIndex = startInclusive + index;
            var wagerIndex = ticketIndex % 5;
            var payload = wagerIndex switch
            {
                0 => new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3, 4, 5 }, ["paytable"] = paytable },
                1 => new Dictionary<string, object?> { ["numbers"] = new[] { 10, 11, 12 }, ["paytable"] = paytable },
                2 => new Dictionary<string, object?> { ["numbers"] = new[] { 1, 1, 2 }, ["paytable"] = paytable },
                3 => new Dictionary<string, object?> { ["numbers"] = new[] { 1 }, ["selection"] = "ODD", ["paytable"] = paytable },
                _ => new Dictionary<string, object?> { ["numbers"] = new[] { 1, 2, 3 }, ["bullseye"] = 1, ["paytable"] = paytable }
            };
            if (configuration.Count > 0)
            {
                payload["configuration"] = configuration;
            }

            tickets.Add(new TicketReadModel(
                EvaluationIds.StableGuid($"database-ticket:{drawId:N}:{gameId:N}:{ticketIndex}"),
                EvaluationIds.StableGuid($"database-player:{ticketIndex}"),
                GameType.Keno,
                wagerIndex switch
                {
                    3 => WagerType.KenoOddEven,
                    4 => WagerType.KenoBullseye,
                    _ => WagerType.KenoSpot
                },
                payload,
                new GameEvaluationAmount("USD", 10m, 0m, -10m)));
        }

        return tickets;
    }
}
