using GameEngine.Application.Interfaces;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;

public static class DurableSchedulerTests
{
    public static async Task RunAsync()
    {
        var calculator = new AuthoritativeScheduleCalculator();
        TestFastKenoSchedule(calculator);
        TestHotSpotSchedule(calculator);
        TestDaylightSavingTransitions(calculator);
        await TestActivationAndConcurrencyAsync(calculator);
        await TestExpiredClaimRecoveryAsync(calculator);
        await TestExactlyOnceInvocationAsync(calculator);
        await TestRecoveryPolicyAsync(calculator);
        await TestPurposeSeparatedRuntimeAsync(calculator);
    }

    private static async Task TestExpiredClaimRecoveryAsync(AuthoritativeScheduleCalculator calculator)
    {
        var dueAt = DateTimeOffset.Parse("2026-08-24T12:00:00Z");
        var definition = Definition(DurableSchedulerProductKind.FastKeno, "FAST_KENO_V1", active: true);
        var slot = calculator.MaterializeWindow(definition, dueAt, dueAt).Single();
        var repository = new InMemoryDurableSchedulerRepository();
        await repository.MaterializeAsync(definition, [slot], TimeSpan.FromMinutes(10), CancellationToken.None);
        var abandoned = await repository.TryClaimExecutionAsync(
            slot.DrawId, "crashed-owner", TimeSpan.FromSeconds(20), dueAt, CancellationToken.None);
        Require(abandoned.Status == DurableSchedulerClaimStatus.Acquired,
            "The first scheduler instance must acquire the execution claim.");

        var invoker = new CountingExecutionInvoker();
        var recoveredAt = dueAt.AddSeconds(21);
        var runtime = new DurableSchedulerRuntime(
            repository,
            calculator,
            invoker,
            new MutableClock(recoveredAt),
            new DurableSchedulerOptions(
                HostedRuntimeEnabled: true,
                ProductionExecutionEnabled: true,
                TimeSpan.FromMinutes(2),
                TimeSpan.FromHours(8),
                TimeSpan.FromMinutes(10),
                TimeSpan.FromSeconds(20),
                TimeSpan.FromSeconds(1)));

        await runtime.RunCycleAsync("recovery-owner", CancellationToken.None);
        Require(invoker.InvocationCount == 1 && repository.Draws.Single().State == DurableSchedulerDrawState.SettlementTriggered,
            "An expired execution claim must be reclaimed exactly once after process death.");
    }

    private static void TestFastKenoSchedule(AuthoritativeScheduleCalculator calculator)
    {
        var definition = Definition(DurableSchedulerProductKind.FastKeno, "FAST_KENO_V1", active: true);
        var from = DateTimeOffset.Parse("2026-08-24T12:00:00Z");
        var slots = calculator.MaterializeWindow(definition, from, from.AddMinutes(5)).ToArray();
        Require(slots.Length == 13, "Fast Keno must include exact 25-second cadence boundaries.");
        Require(slots.Zip(slots.Skip(1)).All(pair =>
            pair.Second.ScheduledExecutionAt - pair.First.ScheduledExecutionAt == TimeSpan.FromSeconds(25)),
            "Fast Keno cadence must not drift.");
        Require(slots.All(slot => slot.ScheduledExecutionAt - slot.CutoffAt == TimeSpan.FromSeconds(5)),
            "Fast Keno cutoff must remain five seconds.");
        Require(slots.Select(slot => slot.DrawId).Distinct().Count() == slots.Length,
            "Fast Keno draw identities must be globally unique in the schedule window.");
    }

    private static void TestHotSpotSchedule(AuthoritativeScheduleCalculator calculator)
    {
        var definition = Definition(DurableSchedulerProductKind.HotSpot, "HOT_SPOT_V1", active: true);
        var slots = calculator.MaterializeWindow(
            definition,
            DateTimeOffset.Parse("2026-08-24T09:00:00Z"),
            DateTimeOffset.Parse("2026-08-25T11:00:00Z")).ToArray();
        var zone = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
        Require(slots.Length > 100, "Hot Spot operational window must materialize a full draw sequence.");
        Require(slots.All(slot => slot.ScheduledExecutionAt - slot.CutoffAt == TimeSpan.FromSeconds(15)),
            "Hot Spot cutoff must remain fifteen seconds.");
        Require(slots.All(slot =>
        {
            var local = TimeZoneInfo.ConvertTime(slot.ScheduledExecutionAt, zone).TimeOfDay;
            return local >= TimeSpan.FromHours(6) || local <= TimeSpan.FromHours(2);
        }), "Hot Spot must not schedule draws in the 02:00-06:00 maintenance window.");
    }

    private static void TestDaylightSavingTransitions(AuthoritativeScheduleCalculator calculator)
    {
        var fast = Definition(DurableSchedulerProductKind.FastKeno, "FAST_KENO_V1", active: true);
        var spring = calculator.MaterializeWindow(
            fast,
            DateTimeOffset.Parse("2026-03-08T05:00:00Z"),
            DateTimeOffset.Parse("2026-03-09T04:00:00Z")).ToArray();
        var fall = calculator.MaterializeWindow(
            fast,
            DateTimeOffset.Parse("2026-11-01T04:00:00Z"),
            DateTimeOffset.Parse("2026-11-02T05:00:00Z")).ToArray();
        Require(spring.Select(slot => slot.ScheduledExecutionAt).Distinct().Count() == spring.Length,
            "Spring-forward schedule instants must remain unique.");
        Require(fall.Select(slot => slot.ScheduledExecutionAt).Distinct().Count() == fall.Length,
            "Fall-back schedule instants must remain unique.");
        Require(spring.Zip(spring.Skip(1)).All(pair =>
            pair.Second.ScheduledExecutionAt - pair.First.ScheduledExecutionAt == TimeSpan.FromSeconds(25)),
            "Spring-forward must not introduce cadence drift.");
        Require(fall.Zip(fall.Skip(1)).All(pair =>
            pair.Second.ScheduledExecutionAt - pair.First.ScheduledExecutionAt == TimeSpan.FromSeconds(25)),
            "Fall-back must not introduce cadence drift.");
    }

    private static async Task TestActivationAndConcurrencyAsync(AuthoritativeScheduleCalculator calculator)
    {
        var now = DateTimeOffset.Parse("2026-08-24T12:00:00Z");
        var inactive = Definition(DurableSchedulerProductKind.FastKeno, "FAST_KENO_V1", active: false);
        var inactiveRepository = new InMemoryDurableSchedulerRepository([inactive]);
        var inactiveRuntime = Runtime(inactiveRepository, calculator, new MutableClock(now), execute: false);
        var inactiveCycle = await inactiveRuntime.RunCycleAsync("inactive-test", CancellationToken.None);
        Require(inactiveCycle.EligibleScheduleCount == 0 && inactiveRepository.Draws.Count == 0,
            "Published but inactive/unassigned products must not materialize runtime draws.");

        var active = Definition(DurableSchedulerProductKind.FastKeno, "FAST_KENO_V1", active: true);
        var repository = new InMemoryDurableSchedulerRepository([active]);
        var slots = calculator.MaterializeWindow(active, now, now.AddMinutes(1));
        await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => repository.MaterializeAsync(
            active, slots, TimeSpan.FromMinutes(10), CancellationToken.None)));
        Require(repository.Draws.Count == slots.Count,
            "Concurrent materialization must not duplicate authoritative draw identities.");
        Require(repository.Draws.Select(draw => draw.PublicDrawNumber).Distinct().Count() == repository.Draws.Count,
            "Public draw numbers must remain unique under concurrent materialization.");

        var first = repository.Draws.First();
        await repository.AdvanceTimeStatesAsync(first.Slot.ScheduledExecutionAt, CancellationToken.None);
        var claims = await Task.WhenAll(Enumerable.Range(0, 20).Select(index => repository.TryClaimExecutionAsync(
            first.Slot.DrawId,
            $"owner-{index}",
            TimeSpan.FromSeconds(30),
            first.Slot.ScheduledExecutionAt,
            CancellationToken.None)));
        Require(claims.Count(claim => claim.Status == DurableSchedulerClaimStatus.Acquired) == 1,
            "Only one scheduler owner may claim a due draw.");
    }

    private static async Task TestRecoveryPolicyAsync(AuthoritativeScheduleCalculator calculator)
    {
        var now = DateTimeOffset.Parse("2026-08-24T12:00:00Z");
        var definition = Definition(DurableSchedulerProductKind.FastKeno, "FAST_KENO_V1", active: true);
        var pastSlot = calculator.MaterializeWindow(
            definition,
            now.Subtract(TimeSpan.FromMinutes(20)),
            now.Subtract(TimeSpan.FromMinutes(20))).Single();

        var emptyRepository = new InMemoryDurableSchedulerRepository([definition]);
        await emptyRepository.MaterializeAsync(definition, [pastSlot], TimeSpan.FromMinutes(10), CancellationToken.None);
        await Runtime(emptyRepository, calculator, new MutableClock(now), execute: false)
            .RunCycleAsync("recovery-empty", CancellationToken.None);
        Require(emptyRepository.Draws.Single(draw => draw.Slot.DrawId == pastSlot.DrawId).State ==
            DurableSchedulerDrawState.SkippedNoWagers,
            "Missed draws without funded wagers must be skipped without fabricated outcomes.");

        var fundedRepository = new InMemoryDurableSchedulerRepository([definition]);
        await fundedRepository.MaterializeAsync(definition, [pastSlot], TimeSpan.FromMinutes(10), CancellationToken.None);
        fundedRepository.FundedDraws.Add(pastSlot.DrawId);
        await Runtime(fundedRepository, calculator, new MutableClock(now), execute: false)
            .RunCycleAsync("recovery-funded", CancellationToken.None);
        Require(fundedRepository.Draws.Single(draw => draw.Slot.DrawId == pastSlot.DrawId).State ==
            DurableSchedulerDrawState.RecoveryRequired,
            "Missed draws with funded wagers must fail closed into governed recovery.");
    }

    private static async Task TestExactlyOnceInvocationAsync(AuthoritativeScheduleCalculator calculator)
    {
        var now = DateTimeOffset.Parse("2026-08-24T12:00:00Z");
        var definition = Definition(DurableSchedulerProductKind.FastKeno, "FAST_KENO_V1", active: true);
        var slot = calculator.MaterializeWindow(definition, now, now).Single();
        var repository = new InMemoryDurableSchedulerRepository();
        await repository.MaterializeAsync(definition, [slot], TimeSpan.FromMinutes(10), CancellationToken.None);
        var invoker = new CountingExecutionInvoker();
        var runtime = new DurableSchedulerRuntime(
            repository,
            calculator,
            invoker,
            new MutableClock(now),
            new DurableSchedulerOptions(
                HostedRuntimeEnabled: true,
                ProductionExecutionEnabled: true,
                TimeSpan.FromMinutes(2),
                TimeSpan.FromHours(8),
                TimeSpan.FromMinutes(10),
                TimeSpan.FromSeconds(30),
                TimeSpan.FromSeconds(1)));

        await runtime.RunCycleAsync("scheduler-a", CancellationToken.None);
        await runtime.RunCycleAsync("scheduler-b", CancellationToken.None);
        Require(invoker.InvocationCount == 1,
            "Scheduler retries must not invoke canonical draw execution twice after durable progress.");
        Require(repository.Draws.Single().State == DurableSchedulerDrawState.SettlementTriggered,
            "Scheduler must preserve the canonical settlement-triggered state.");
    }

    private static async Task TestPurposeSeparatedRuntimeAsync(AuthoritativeScheduleCalculator calculator)
    {
        var now = DateTimeOffset.Parse("2026-08-24T12:00:00Z");
        var definition = Definition(DurableSchedulerProductKind.HotSpot, "HOT_SPOT_V1", active: true);
        var repository = new InMemoryDurableSchedulerRepository([definition]);
        var slots = calculator.GetNextSlots(definition, now, 20);
        await repository.MaterializeAsync(definition, slots, TimeSpan.FromMinutes(10), CancellationToken.None);
        await repository.AdvanceTimeStatesAsync(now, CancellationToken.None);

        var drbg = new HmacDrbgRuntime();
        var randomness = new PurposeSeparatedRandomnessService(
            new AutoOsEntropyProvider(),
            drbg,
            new CertifiedCsprngSampler(drbg));
        var clock = new MutableClock(now);
        var quickPickAuthority = new HotSpotQuickPickAuthority(repository, randomness, clock);
        var request = new HotSpotQuickPickRequest(
            Guid.NewGuid(), "quick-pick-retry", 10, "sha256:product-version", "qa-player");
        var quickPick = await quickPickAuthority.GenerateAsync(request, CancellationToken.None);
        var quickPickRetry = await quickPickAuthority.GenerateAsync(request, CancellationToken.None);
        Require(quickPick.Numbers.Count == 10 && quickPick.Numbers.Distinct().Count() == 10 &&
            quickPick.Numbers.All(number => number is >= 1 and <= 80),
            "Quick Pick must produce a unique 1-80 selection of the requested size.");
        Require(quickPickRetry.Duplicate && quickPickRetry.SelectionHash == quickPick.SelectionHash,
            "Quick Pick retry must return immutable evidence rather than regenerate numbers.");

        var bullseyeAuthority = new HotSpotBullseyeAuthority(repository, randomness, clock);
        var draw = repository.Draws.First();
        var certified = Enumerable.Range(1, 20).ToArray();
        var bullseye = await bullseyeAuthority.DesignateAsync(
            draw.Slot.DrawId,
            Guid.NewGuid(),
            certified,
            "sha256:primary-result",
            "sha256:provider-configuration",
            CancellationToken.None);
        var bullseyeRetry = await bullseyeAuthority.DesignateAsync(
            draw.Slot.DrawId,
            bullseye.ExecutionManifestId,
            certified,
            bullseye.PrimaryResultHash,
            bullseye.ProviderConfigurationHash,
            CancellationToken.None);
        Require(certified.Contains(bullseye.BullseyeNumber),
            "Bullseye must designate a number from the same certified 20-number result.");
        Require(bullseyeRetry.Duplicate && bullseyeRetry.CanonicalEvidenceHash == bullseye.CanonicalEvidenceHash,
            "Bullseye retry must return immutable evidence.");

        var multiDrawAuthority = new HotSpotMultiDrawAuthority(repository, clock);
        var plan = await multiDrawAuthority.BindAsync(
            Guid.NewGuid(), Guid.NewGuid(), 20, 100, quickPick, CancellationToken.None);
        var planRetry = await multiDrawAuthority.BindAsync(
            plan.PurchaseId, plan.TicketId, 20, 100, quickPick, CancellationToken.None);
        Require(plan.Bindings.Count == 20 && plan.TotalReservationMinor == 2_000,
            "Multi-draw must bind the exact next draw sequence and reserve the full purchase total.");
        Require(plan.Bindings.Select(binding => binding.DrawId).Distinct().Count() == 20 &&
            plan.Bindings.Select(binding => binding.Sequence).SequenceEqual(Enumerable.Range(1, 20)),
            "Multi-draw bindings must be ordered, unique, and gap-free.");
        Require(planRetry.Duplicate && planRetry.CanonicalPlanHash == plan.CanonicalPlanHash,
            "Multi-draw retry must return the same immutable plan.");
    }

    private static DurableSchedulerRuntime Runtime(
        InMemoryDurableSchedulerRepository repository,
        AuthoritativeScheduleCalculator calculator,
        IClock clock,
        bool execute) => new(
            repository,
            calculator,
            new DisabledScheduledDrawExecutionInvoker(),
            clock,
            new DurableSchedulerOptions(
                HostedRuntimeEnabled: true,
                ProductionExecutionEnabled: execute,
                TimeSpan.FromMinutes(2),
                TimeSpan.FromHours(8),
                TimeSpan.FromMinutes(10),
                TimeSpan.FromSeconds(30),
                TimeSpan.FromSeconds(1)));

    private static DurableSchedulerProductDefinition Definition(
        DurableSchedulerProductKind kind,
        string code,
        bool active) => new(
            kind,
            AuthoritativeScheduleCalculator.StableGuid($"product|{code}"),
            AuthoritativeScheduleCalculator.StableGuid($"product-version|{code}"),
            code,
            AuthoritativeScheduleCalculator.StableGuid($"schedule|{code}"),
            AuthoritativeScheduleCalculator.StableGuid($"schedule-version|{code}"),
            AuthoritativeScheduleCalculator.StableGuid($"assignment|{code}"),
            "America/New_York",
            kind == DurableSchedulerProductKind.FastKeno ? 25 : 240,
            kind == DurableSchedulerProductKind.FastKeno ? 5 : 15,
            TimeOnly.MinValue,
            kind == DurableSchedulerProductKind.HotSpot ? new TimeOnly(6, 0) : null,
            kind == DurableSchedulerProductKind.HotSpot ? new TimeOnly(2, 0) : null,
            kind == DurableSchedulerProductKind.HotSpot ? [1, 5, 10, 20] : [1],
            Published: true,
            Active: active,
            Assigned: active,
            EffectiveFrom: null,
            EffectiveTo: null,
            $"sha256:schedule-{code}",
            $"sha256:product-{code}");

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private sealed class MutableClock(DateTimeOffset utcNow) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;
    }

    private sealed class CountingExecutionInvoker : IScheduledDrawExecutionInvoker
    {
        public int InvocationCount { get; private set; }

        public Task<ScheduledDrawInvocationResult> InvokeAsync(
            DurableScheduledDraw draw,
            CancellationToken cancellationToken)
        {
            InvocationCount += 1;
            return Task.FromResult(new ScheduledDrawInvocationResult(
                DurableSchedulerDrawState.SettlementTriggered,
                AuthoritativeScheduleCalculator.Hash($"settlement|{draw.Slot.DrawId:N}"),
                Duplicate: false,
                SettlementTriggered: true));
        }
    }
}
