using GameEngine.Domain.Model;
using GameEngine.Domain.Modules;

namespace GameEngine.Application.Services;

public interface ITicketReader
{
    IReadOnlyCollection<TicketReadModel> ReadBatch(TicketReadRequest request);

    IReadOnlyCollection<TicketReadModel> ReadByRange(Guid drawId, Guid gameId, int startInclusive, int endExclusive);
}

public sealed class InMemoryTicketReader : ITicketReader
{
    public IReadOnlyCollection<TicketReadModel> ReadBatch(TicketReadRequest request)
    {
        return BuildTickets(request.DrawId, request.StartInclusive, request.EndExclusive, request.Configuration);
    }

    public IReadOnlyCollection<TicketReadModel> ReadByRange(Guid drawId, Guid gameId, int startInclusive, int endExclusive)
    {
        return BuildTickets(drawId, startInclusive, endExclusive, new Dictionary<string, object?>());
    }

    private static IReadOnlyCollection<TicketReadModel> BuildTickets(
        Guid drawId,
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
        var count = Math.Max(1, Math.Min(5, endExclusive - startInclusive));
        for (var index = 0; index < count; index += 1)
        {
            var ticketIndex = startInclusive + index;
            var payload = index switch
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
                EvaluationIds.StableGuid($"in-memory-ticket:{drawId}:{ticketIndex}"),
                EvaluationIds.StableGuid($"in-memory-player:{ticketIndex}"),
                GameType.Keno,
                index switch
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

public sealed class ModuleResolver(GameModuleRegistry registry)
{
    public ModuleResolutionResult Resolve(string moduleId, string moduleVersion)
    {
        var entry = registry.GetModuleVersions(moduleId)
            .FirstOrDefault(module => string.Equals(module.ModuleVersion, moduleVersion, StringComparison.OrdinalIgnoreCase));
        if (entry is null)
        {
            return new ModuleResolutionResult(false, moduleId, moduleVersion, "Module version was not found.", null, false, DateTimeOffset.UtcNow);
        }

        if (entry.RegistrationStatus != GameModuleRegistrationStatus.Registered)
        {
            return new ModuleResolutionResult(false, moduleId, moduleVersion, "Module is not registered.", entry.LifecycleStatus, entry.ProductionReady, DateTimeOffset.UtcNow);
        }

        if (entry.LifecycleStatus is GameModuleLifecycleStatus.Development or GameModuleLifecycleStatus.Retired)
        {
            return new ModuleResolutionResult(false, moduleId, moduleVersion, "Module lifecycle does not permit execution.", entry.LifecycleStatus, entry.ProductionReady, DateTimeOffset.UtcNow);
        }

        return new ModuleResolutionResult(true, moduleId, moduleVersion, null, entry.LifecycleStatus, entry.ProductionReady, DateTimeOffset.UtcNow);
    }
}

public sealed class ModuleVersionResolver(GameModuleRegistry registry)
{
    public GameModuleRegistryEntry? ResolveVersion(Guid gameBindingId)
    {
        var binding = registry.GetGameBinding(gameBindingId);
        var activeVersion = binding?.Versions.FirstOrDefault(version => version.Id == binding.ActiveVersionId);
        if (activeVersion is null || activeVersion.Status != GameBindingStatus.Validated)
        {
            return null;
        }

        return registry.GetModuleVersions(activeVersion.ModuleId)
            .FirstOrDefault(module => string.Equals(module.ModuleVersion, activeVersion.ModuleVersion, StringComparison.OrdinalIgnoreCase));
    }
}

public sealed class EvaluationRecordBuilder
{
    public ImmutableEvaluationRecord Build(
        EvaluationExecutionContext context,
        TicketReadModel ticket,
        GameEvaluationOutput output)
    {
        var metadata = new Dictionary<string, object?>
        {
            ["validationValid"] = output.ValidationResult.IsValid,
            ["settlementIntegrationEnabled"] = false,
            ["financialPostingEnabled"] = false,
            ["moduleVersion"] = context.ModuleVersion,
            ["evaluatorVersion"] = context.EvaluatorVersion,
            ["paytableVersion"] = context.PaytableVersion,
            ["evaluationFacts"] = output.SettlementFacts
        };
        var key = new EvaluationRecordIdempotencyKey(
            context.DrawId,
            ticket.TicketId,
            context.GameId,
            context.ModuleId,
            context.ModuleVersion,
            context.EvaluatorVersion);

        return new ImmutableEvaluationRecord(
            EvaluationIds.Record(key),
            context.RunId,
            context.BatchId,
            ticket.TicketId,
            context.DrawId,
            context.GameId,
            context.ModuleId,
            context.ModuleVersion,
            context.EvaluatorVersion,
            context.PaytableVersion,
            output.Outcome,
            output.Reason,
            output.Amount,
            metadata,
            DateTimeOffset.UtcNow);
    }
}

public sealed class GameModuleExecutionService(
    GameModuleRegistry registry,
    EvaluationOrchestrator orchestrator,
    ITicketReader ticketReader)
{
    private readonly ModuleResolver moduleResolver = new(registry);
    private readonly ModuleVersionResolver moduleVersionResolver = new(registry);
    private readonly EvaluationRecordBuilder recordBuilder = new();
    private readonly List<EvaluationExecutionResult> executions = [];

    public ModuleExecutionDiagnostics GetDiagnostics()
    {
        return new ModuleExecutionDiagnostics(
            executions.Count,
            executions.Sum(execution => execution.RecordsCreated),
            TicketDatabaseReadsEnabled: false,
            SettlementIntegrationEnabled: false,
            FinancialPostingEnabled: false,
            executions.OrderByDescending(execution => execution.ExecutedAt).Take(10).ToArray(),
            DateTimeOffset.UtcNow);
    }

    public EvaluationExecutionResult? GetExecution(Guid runId)
    {
        return executions.OrderByDescending(execution => execution.ExecutedAt).FirstOrDefault(execution => execution.RunId == runId);
    }

    public IReadOnlyCollection<object> GetTicketReaders()
    {
        return
        [
            new
            {
                name = "InMemoryTicketReader",
                databaseAccessEnabled = false,
                supportsReadBatch = true,
                supportsReadByRange = true,
                productionReady = false
            }
        ];
    }

    public IReadOnlyCollection<ModuleResolutionResult> GetModuleResolution()
    {
        return registry.GetRegisteredModules()
            .Select(module => moduleResolver.Resolve(module.ModuleId, module.ModuleVersion))
            .ToArray();
    }

    public EvaluationExecutionResult ExecuteReferenceRun(Guid correlationId)
    {
        var binding = registry.GetGameBindings()
            .FirstOrDefault(candidate => candidate.GameType == GameType.Keno && candidate.WagerType == WagerType.KenoSpot)
            ?? throw new InvalidOperationException("Keno game binding not found.");
        var version = binding.Versions.First(candidate => candidate.Id == binding.ActiveVersionId);
        var run = orchestrator.PlanRun(new EvaluationPlanRequest(
            EvaluationIds.StableGuid($"keno-certified-draw:{binding.Id}"),
            binding.Id,
            EvaluationIds.StableGuid($"keno-certified-result:{binding.Id}"),
            EligibleTicketCount: 5,
            GameSpecificBatchSize: 5,
            version.ModuleId,
            version.ModuleVersion,
            "keno-evaluator-1"));
        orchestrator.StartRun(run.Id);
        return ExecuteBatch(run.Id, orchestrator.GetBatches(run.Id).First().Id, correlationId);
    }

    public EvaluationExecutionResult ExecuteBatch(Guid runId, Guid batchId, Guid correlationId)
    {
        var run = orchestrator.GetRun(runId) ?? throw new InvalidOperationException("Evaluation run not found.");
        var batch = orchestrator.GetBatch(batchId) ?? throw new InvalidOperationException("Evaluation batch not found.");
        var moduleEntry = moduleVersionResolver.ResolveVersion(run.GameBindingId)
            ?? throw new InvalidOperationException("Module version could not be resolved from game binding.");
        var resolution = moduleResolver.Resolve(moduleEntry.ModuleId, moduleEntry.ModuleVersion);
        if (!resolution.Resolved)
        {
            throw new InvalidOperationException(resolution.Reason ?? "Module resolution failed.");
        }

        var module = registry.GetModuleInstance(moduleEntry.ModuleId, moduleEntry.ModuleVersion)
            ?? throw new InvalidOperationException("Module instance could not be resolved.");
        if (module is not IGameConfigurationValidator configurationValidator
            || module is not IGameTicketValidator ticketValidator
            || module is not IGameEvaluator evaluator)
        {
            throw new InvalidOperationException("Module does not implement required execution interfaces.");
        }

        var binding = registry.GetGameBinding(run.GameBindingId) ?? throw new InvalidOperationException("Game binding not found.");
        var bindingVersion = binding.Versions.First(version => version.Id == binding.ActiveVersionId);
        var configuration = MergeConfiguration(bindingVersion.DefaultConfiguration, bindingVersion.GameConfigurationOverrides);
        var configurationValidation = configurationValidator.ValidateConfiguration(configuration);
        if (!configurationValidation.Accepted || !configurationValidation.Validation.IsValid)
        {
            throw new InvalidOperationException("Module configuration is invalid.");
        }

        var context = CreateContext(run, batch, bindingVersion, moduleEntry, configuration, correlationId);
        orchestrator.ClaimBatch(batch.Id);
        var tickets = ticketReader.ReadBatch(new TicketReadRequest(
            context.DrawId,
            context.GameId,
            context.BatchId,
            context.StartInclusive,
            context.EndExclusive,
            context.Configuration));
        var records = new List<ImmutableEvaluationRecord>();
        var ticketResults = new List<EvaluationExecutionTicketResult>();
        var failures = 0;

        foreach (var ticket in tickets)
        {
            var validation = ticketValidator.ValidateTicket(new TicketValidationRequest(
                context.GameId,
                context.GameBindingId,
                ticket.PlayerId,
                ticket.GameType,
                ticket.WagerType,
                ticket.Payload));
            if (!validation.Accepted)
            {
                failures += 1;
                ticketResults.Add(new EvaluationExecutionTicketResult(
                    ticket.TicketId,
                    false,
                    GameEvaluationOutcome.Rejected,
                    GameEvaluationReason.InvalidTicket,
                    null,
                    validation.Validation.Errors));
                continue;
            }

            var output = evaluator.EvaluateTicket(new GameEvaluationInput(
                ticket.TicketId,
                context.DrawId,
                ticket.GameType,
                ticket.WagerType,
                ticket.Payload,
                context.CertifiedResult,
                ticket.Stake,
                new GameEvaluationMetadata(
                    context.ModuleId,
                    context.ModuleVersion,
                    context.EvaluatorVersion,
                    context.PaytableVersion,
                    "disabled",
                    context.GameBindingId.ToString("N"),
                    "not-approved",
                    context.DrawAuthorityId.ToString("N"),
                    $"execution:{context.RunId:N}:{ticket.TicketId:N}")));
            var record = recordBuilder.Build(context, ticket, output);
            records.Add(record);
            orchestrator.RecordEvaluation(
                context.RunId,
                context.BatchId,
                new EvaluationRecordIdempotencyKey(context.DrawId, ticket.TicketId, context.GameId, context.ModuleId, context.ModuleVersion, context.EvaluatorVersion),
                output.Outcome);
            ticketResults.Add(new EvaluationExecutionTicketResult(
                ticket.TicketId,
                true,
                output.Outcome,
                output.Reason,
                record.Id,
                output.ValidationResult.Errors));
        }

        var completed = orchestrator.CompleteBatch(batch.Id, tickets.Count, tickets.LastOrDefault()?.TicketId.ToString("N") ?? "empty");
        var completedRun = orchestrator.GetRun(run.Id) ?? run;
        var result = new EvaluationExecutionResult(
            run.Id,
            batch.Id,
            correlationId,
            context.ModuleId,
            context.ModuleVersion,
            tickets.Count,
            records.Count,
            failures,
            completed.Status,
            completedRun.Status,
            records,
            ticketResults,
            SettlementIntegrationTriggered: false,
            FinancialMutationPerformed: false,
            DateTimeOffset.UtcNow);
        executions.Add(result);
        return result;
    }

    private EvaluationExecutionContext CreateContext(
        EvaluationRunDefinition run,
        EvaluationBatchDefinition batch,
        GameBindingVersion bindingVersion,
        GameModuleRegistryEntry module,
        IReadOnlyDictionary<string, object?> configuration,
        Guid correlationId)
    {
        return new EvaluationExecutionContext(
            run.DrawId,
            run.GameBindingId,
            run.GameBindingId,
            module.ModuleId,
            module.ModuleVersion,
            module.ModuleId == "KENO_GENERIC" ? "keno-evaluator-1" : run.EvaluationVersion,
            EvaluationIds.StableGuid($"draw-authority:{bindingVersion.DrawAuthority}"),
            ReadString(configuration, "paytableVersion") ?? "REFERENCE_PAYTABLE_V1",
            CertifiedKenoResult(),
            configuration,
            run.Id,
            batch.Id,
            batch.Sequence,
            batch.StartInclusive,
            batch.EndExclusive,
            correlationId);
    }

    private static IReadOnlyDictionary<string, object?> CertifiedKenoResult()
    {
        return new Dictionary<string, object?>
        {
            ["numbers"] = new[] { 1, 2, 3, 4, 5, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39 },
            ["bullseye"] = 1
        };
    }

    private static IReadOnlyDictionary<string, object?> MergeConfiguration(
        IReadOnlyDictionary<string, object?> defaults,
        IReadOnlyDictionary<string, object?> overrides)
    {
        var merged = new Dictionary<string, object?>(defaults, StringComparer.OrdinalIgnoreCase);
        foreach (var item in overrides)
        {
            merged[item.Key] = item.Value;
        }

        return merged;
    }

    private static string? ReadString(IReadOnlyDictionary<string, object?> payload, string key)
    {
        return payload.TryGetValue(key, out var value) ? value?.ToString() : null;
    }
}
