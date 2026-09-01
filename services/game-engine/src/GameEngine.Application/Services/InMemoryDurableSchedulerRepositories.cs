using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class InMemoryDurableSchedulerRepository(
    IReadOnlyCollection<DurableSchedulerProductDefinition>? seedDefinitions = null) :
    IDurableSchedulerRepository,
    IHotSpotRuntimeEvidenceRepository
{
    private readonly object sync = new();
    private readonly List<DurableSchedulerProductDefinition> definitions = seedDefinitions?.ToList() ?? [];
    private readonly Dictionary<Guid, DurableScheduledDraw> draws = [];
    private readonly Dictionary<string, long> nextPublicNumbers = new(StringComparer.Ordinal);
    private readonly Dictionary<Guid, DurableSchedulerExecutionClaim> claims = [];
    private readonly Dictionary<string, HotSpotQuickPickSelection> quickPicks = new(StringComparer.Ordinal);
    private readonly Dictionary<Guid, HotSpotBullseyeEvidence> bullseyes = [];
    private readonly Dictionary<Guid, HotSpotMultiDrawPlan> multiDrawPlans = [];
    private readonly Dictionary<string, HotSpotMultiDrawCancellationResult> multiDrawCancellations = new(StringComparer.Ordinal);

    public bool Ready { get; set; } = true;

    public IReadOnlyCollection<DurableScheduledDraw> Draws
    {
        get
        {
            lock (sync)
            {
                return draws.Values.OrderBy(draw => draw.Slot.ScheduledExecutionAt).ToArray();
            }
        }
    }

    public Task<bool> CheckReadinessAsync(CancellationToken cancellationToken) => Task.FromResult(Ready);

    public Task<IReadOnlyCollection<DurableSchedulerProductDefinition>> ListProductDefinitionsAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyCollection<DurableSchedulerProductDefinition>>(definitions.ToArray());

    public Task<IReadOnlyCollection<DurableScheduledDraw>> MaterializeAsync(
        DurableSchedulerProductDefinition definition,
        IReadOnlyCollection<AuthoritativeDrawSlot> slots,
        TimeSpan recoveryWindow,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            foreach (var slot in slots.OrderBy(item => item.ScheduledExecutionAt))
            {
                if (draws.ContainsKey(slot.DrawId))
                {
                    continue;
                }

                var next = nextPublicNumbers.TryGetValue(slot.ProductCode, out var current) ? current : 1L;
                nextPublicNumbers[slot.ProductCode] = next + 1;
                draws.Add(slot.DrawId, new DurableScheduledDraw(
                    slot,
                    next,
                    DurableSchedulerDrawState.Scheduled,
                    slot.ScheduledExecutionAt.Add(recoveryWindow),
                    slot.SalesOpenAt,
                    null,
                    null,
                    null));
            }

            return Task.FromResult<IReadOnlyCollection<DurableScheduledDraw>>(
                slots.Select(slot => draws[slot.DrawId]).ToArray());
        }
    }

    public Task AdvanceTimeStatesAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        lock (sync)
        {
            foreach (var (id, draw) in draws.ToArray())
            {
                if (draw.State is DurableSchedulerDrawState.Scheduled or
                    DurableSchedulerDrawState.Accepting or
                    DurableSchedulerDrawState.Cutoff)
                {
                    var state = now < draw.Slot.SalesOpenAt
                        ? DurableSchedulerDrawState.Scheduled
                        : now < draw.Slot.CutoffAt
                            ? DurableSchedulerDrawState.Accepting
                            : now < draw.Slot.ScheduledExecutionAt
                                ? DurableSchedulerDrawState.Cutoff
                                : DurableSchedulerDrawState.ExecutionDue;
                    draws[id] = draw with { State = state };
                }
            }
        }
        return Task.CompletedTask;
    }

    public Task<IReadOnlyCollection<DurableScheduledDraw>> ListDueAsync(
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            return Task.FromResult<IReadOnlyCollection<DurableScheduledDraw>>(draws.Values
                .Where(draw => draw.Slot.ScheduledExecutionAt <= now &&
                    (draw.State == DurableSchedulerDrawState.ExecutionDue ||
                     (draw.State == DurableSchedulerDrawState.Executing &&
                      claims.TryGetValue(draw.Slot.DrawId, out var claim) && claim.LeaseExpiresAt <= now)))
                .OrderBy(draw => draw.Slot.ScheduledExecutionAt)
                .Take(limit)
                .ToArray());
        }
    }

    public HashSet<Guid> FundedDraws { get; } = [];

    public Task<bool> HasFundedAcceptedWagersAsync(Guid drawId, CancellationToken cancellationToken) =>
        Task.FromResult(FundedDraws.Contains(drawId));

    public Task<DurableSchedulerExecutionClaim> TryClaimExecutionAsync(
        Guid drawId,
        string ownerId,
        TimeSpan lease,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            if (claims.TryGetValue(drawId, out var existing) && existing.LeaseExpiresAt > now)
            {
                return Task.FromResult(existing with
                {
                    Status = existing.OwnerId == ownerId
                        ? DurableSchedulerClaimStatus.Duplicate
                        : DurableSchedulerClaimStatus.Unavailable
                });
            }

            var attempt = existing?.AttemptNumber + 1 ?? 1;
            var claim = new DurableSchedulerExecutionClaim(
                drawId,
                AuthoritativeScheduleCalculator.StableGuid($"claim|{drawId:N}|{attempt}"),
                ownerId,
                DurableSchedulerClaimStatus.Acquired,
                now,
                now.Add(lease),
                attempt,
                AuthoritativeScheduleCalculator.Hash($"claim|{drawId:N}|{ownerId}|{attempt}|{now:O}"));
            claims[drawId] = claim;
            if (draws.TryGetValue(drawId, out var draw))
            {
                draws[drawId] = draw with { State = DurableSchedulerDrawState.Executing };
            }
            return Task.FromResult(claim);
        }
    }

    public Task RecordExecutionStateAsync(
        Guid drawId,
        DurableSchedulerDrawState state,
        string reasonCode,
        string evidenceHash,
        DateTimeOffset occurredAt,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            if (!draws.TryGetValue(drawId, out var draw))
            {
                throw new InvalidOperationException("Durable scheduler draw was not found.");
            }
            draws[drawId] = draw with
            {
                State = state,
                AuthoritativeResultAt = state is DurableSchedulerDrawState.AuthoritativeResult or
                    DurableSchedulerDrawState.SettlementTriggered or
                    DurableSchedulerDrawState.Completed
                    ? draw.AuthoritativeResultAt ?? occurredAt
                    : draw.AuthoritativeResultAt,
                SettlementRequestedAt = state is DurableSchedulerDrawState.SettlementTriggered or DurableSchedulerDrawState.Completed
                    ? draw.SettlementRequestedAt ?? occurredAt
                    : draw.SettlementRequestedAt
            };
            if (claims.TryGetValue(drawId, out var claim))
            {
                claims[drawId] = claim with { LeaseExpiresAt = occurredAt };
            }
        }
        return Task.CompletedTask;
    }

    public Task<DurableSchedulerOperationalStatus> GetOperationalStatusAsync(
        bool hostedRuntimeEnabled,
        bool productionExecutionEnabled,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            var due = draws.Values.Where(draw => draw.State == DurableSchedulerDrawState.ExecutionDue).ToArray();
            var unsettled = draws.Values.Where(draw => draw.State is DurableSchedulerDrawState.AuthoritativeResult or DurableSchedulerDrawState.SettlementTriggered).ToArray();
            return Task.FromResult(new DurableSchedulerOperationalStatus(
                Ready,
                Ready,
                hostedRuntimeEnabled,
                productionExecutionEnabled,
                draws.Count,
                draws.Values.Count(draw => draw.State == DurableSchedulerDrawState.Accepting),
                due.Length,
                draws.Values.Count(draw => draw.State == DurableSchedulerDrawState.RecoveryRequired),
                unsettled.Length,
                due.Length == 0 ? TimeSpan.Zero : now - due.Min(draw => draw.Slot.ScheduledExecutionAt),
                unsettled.Length == 0 ? null : now - unsettled.Min(draw => draw.AuthoritativeResultAt ?? now),
                now,
                Ready ? [] : ["In-memory scheduler repository is unavailable."]));
        }
    }

    public Task<HotSpotQuickPickSelection?> FindQuickPickAsync(string idempotencyKey, CancellationToken cancellationToken)
    {
        lock (sync)
        {
            return Task.FromResult(quickPicks.TryGetValue(idempotencyKey, out var selection)
                ? selection with { Duplicate = true }
                : null);
        }
    }

    public Task<HotSpotQuickPickSelection> PersistQuickPickAsync(
        HotSpotQuickPickSelection selection,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            if (quickPicks.TryGetValue(selection.IdempotencyKey, out var existing))
            {
                return Task.FromResult(existing with { Duplicate = true });
            }
            quickPicks.Add(selection.IdempotencyKey, selection);
            return Task.FromResult(selection);
        }
    }

    public Task<HotSpotBullseyeEvidence?> FindBullseyeAsync(Guid drawId, CancellationToken cancellationToken)
    {
        lock (sync)
        {
            return Task.FromResult(bullseyes.TryGetValue(drawId, out var evidence)
                ? evidence with { Duplicate = true }
                : null);
        }
    }

    public Task<HotSpotBullseyeEvidence> PersistBullseyeAsync(
        HotSpotBullseyeEvidence evidence,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            if (bullseyes.TryGetValue(evidence.DrawId, out var existing))
            {
                return Task.FromResult(existing with { Duplicate = true });
            }
            bullseyes.Add(evidence.DrawId, evidence);
            return Task.FromResult(evidence);
        }
    }

    public Task<IReadOnlyCollection<DurableScheduledDraw>> ListNextAcceptingHotSpotDrawsAsync(
        Guid ticketId,
        DateTimeOffset after,
        int count,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            return Task.FromResult<IReadOnlyCollection<DurableScheduledDraw>>(draws.Values
                .Where(draw => draw.Slot.ProductCode == "HOT_SPOT_V1" &&
                    draw.State is DurableSchedulerDrawState.Scheduled or DurableSchedulerDrawState.Accepting &&
                    draw.Slot.CutoffAt > after)
                .OrderBy(draw => draw.Slot.ScheduledExecutionAt)
                .Take(count)
                .ToArray());
        }
    }

    public Task<HotSpotMultiDrawPlan?> FindMultiDrawPlanAsync(Guid purchaseId, CancellationToken cancellationToken)
    {
        lock (sync)
        {
            return Task.FromResult(multiDrawPlans.TryGetValue(purchaseId, out var plan)
                ? plan with { Duplicate = true }
                : null);
        }
    }

    public Task<HotSpotMultiDrawPlan> PersistMultiDrawPlanAsync(
        HotSpotMultiDrawPlan plan,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            if (multiDrawPlans.TryGetValue(plan.PurchaseId, out var existing))
            {
                return Task.FromResult(existing with { Duplicate = true });
            }
            multiDrawPlans.Add(plan.PurchaseId, plan);
            return Task.FromResult(plan);
        }
    }

    public Task<HotSpotMultiDrawCancellationResult> CancelFutureParticipationsAsync(
        HotSpotMultiDrawCancellationRequest request,
        DateTimeOffset cancelledAt,
        CancellationToken cancellationToken)
    {
        lock (sync)
        {
            if (multiDrawCancellations.TryGetValue(request.IdempotencyKey, out var existing))
            {
                if (existing.PurchaseId != request.PurchaseId)
                {
                    throw new InvalidOperationException("Multi-draw cancellation idempotency payload conflict.");
                }
                return Task.FromResult(existing with { Duplicate = true });
            }
            if (!multiDrawPlans.TryGetValue(request.PurchaseId, out var plan))
            {
                throw new InvalidOperationException("Hot Spot multi-draw plan was not found.");
            }
            var count = plan.Bindings.Count(binding => binding.DrawId != plan.Bindings.First().DrawId);
            if (count == 0)
            {
                throw new InvalidOperationException("No undrawn Hot Spot participations are available for cancellation.");
            }
            var result = new HotSpotMultiDrawCancellationResult(
                AuthoritativeScheduleCalculator.StableGuid($"multi-draw-cancel|{request.IdempotencyKey}"),
                request.PurchaseId,
                count,
                checked(plan.StakePerDrawMinor * count),
                AuthoritativeScheduleCalculator.StableGuid($"multi-draw-wallet-release|{request.IdempotencyKey}"),
                AuthoritativeScheduleCalculator.Hash($"multi-draw-cancel|{request.PurchaseId:N}|{count}|{request.ReasonCode}"),
                cancelledAt,
                Duplicate: false);
            multiDrawCancellations.Add(request.IdempotencyKey, result);
            return Task.FromResult(result);
        }
    }
}

public sealed class DisabledScheduledDrawExecutionInvoker : IScheduledDrawExecutionInvoker
{
    public Task<ScheduledDrawInvocationResult> InvokeAsync(
        DurableScheduledDraw draw,
        CancellationToken cancellationToken) =>
        throw new InvalidOperationException("Canonical scheduled draw execution is disabled.");
}
