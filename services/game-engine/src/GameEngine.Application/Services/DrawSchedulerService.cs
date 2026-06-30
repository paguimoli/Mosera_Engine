using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class DrawSchedulerService
{
    private readonly GameModuleRegistry gameModuleRegistry;
    private readonly DrawAuthorityRegistry drawAuthorityRegistry;
    private readonly List<DrawScheduleDefinition> schedules = [];
    private readonly Dictionary<Guid, DrawLifecycleRecord> manualLifecycleOverrides = new();

    public DrawSchedulerService(GameModuleRegistry gameModuleRegistry, DrawAuthorityRegistry drawAuthorityRegistry)
    {
        this.gameModuleRegistry = gameModuleRegistry;
        this.drawAuthorityRegistry = drawAuthorityRegistry;
        SeedSchedules();
    }

    public IReadOnlyCollection<DrawScheduleDefinition> GetSchedules() => schedules.ToArray();

    public DrawScheduleDefinition? GetSchedule(Guid id) => schedules.FirstOrDefault(schedule => schedule.Id == id);

    public DrawSchedulePreview PreviewSchedule(Guid scheduleId, int count = 5)
    {
        var schedule = GetSchedule(scheduleId) ?? throw new InvalidOperationException("Draw schedule not found.");
        return new DrawSchedulePreview(
            schedule.Id,
            schedule.Code,
            GenerateUpcomingDraws(schedule, count, DateTimeOffset.UtcNow),
            DateTimeOffset.UtcNow);
    }

    public IReadOnlyCollection<DrawLifecycleRecord> GetLifecycle()
    {
        return schedules.SelectMany(schedule => GenerateLifecycleWindow(schedule, DateTimeOffset.UtcNow)).ToArray();
    }

    public DrawLifecycleRecord? GetLifecycle(Guid drawId)
    {
        if (manualLifecycleOverrides.TryGetValue(drawId, out var manual))
        {
            return manual;
        }

        return GetLifecycle().FirstOrDefault(draw => draw.DrawId == drawId);
    }

    public DrawLifecycleRecord MarkMissed(Guid drawId)
    {
        var current = GetLifecycle(drawId) ?? throw new InvalidOperationException("Draw lifecycle record not found.");
        var marked = current with
        {
            Status = DrawLifecycleStatus.ManualReviewRequired,
            MissedDrawWindow = true,
            ManualRecoveryMarked = true,
            SalesAllowed = false,
            InternalGenerationEligible = false,
            Reasons = current.Reasons
                .Concat(["Manual recovery marker applied; no settlement or result mutation performed."])
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            UpdatedAt = DateTimeOffset.UtcNow
        };
        manualLifecycleOverrides[drawId] = marked;
        return marked;
    }

    public DrawLifecycleTransitionResult ValidateTransition(Guid drawId, DrawLifecycleStatus requestedStatus)
    {
        var current = GetLifecycle(drawId) ?? throw new InvalidOperationException("Draw lifecycle record not found.");
        var accepted = IsForwardTransition(current.Status, requestedStatus);
        return new DrawLifecycleTransitionResult(
            drawId,
            current.Status,
            requestedStatus,
            accepted,
            accepted ? [] : [$"Invalid lifecycle transition from {current.Status} to {requestedStatus}."],
            DateTimeOffset.UtcNow);
    }

    public DrawSchedulerStatus GetSchedulerStatus()
    {
        var lifecycle = GetLifecycle();
        var reasons = new List<string>
        {
            "Scheduler state is in-memory only.",
            "Production scheduler activation is disabled.",
            "Settlement integration is disabled."
        };

        if (lifecycle.Any(draw => draw.MissedDrawWindow))
        {
            reasons.Add("One or more draw windows require manual review.");
        }

        return new DrawSchedulerStatus(
            DrawSchedulerHealth.Warning,
            schedules.Count,
            lifecycle.Count,
            lifecycle.Count(draw => draw.MissedDrawWindow),
            ProductionActivationEnabled: false,
            SettlementIntegrationEnabled: false,
            reasons,
            DateTimeOffset.UtcNow);
    }

    public bool CanAcceptSales(Guid drawId)
    {
        return GetLifecycle(drawId)?.SalesAllowed == true;
    }

    public bool CanGenerateInternalResult(Guid drawId)
    {
        return GetLifecycle(drawId)?.InternalGenerationEligible == true;
    }

    private IReadOnlyCollection<DrawLifecycleRecord> GenerateLifecycleWindow(DrawScheduleDefinition schedule, DateTimeOffset now)
    {
        var upcoming = GenerateUpcomingDraws(schedule, 4, now).ToList();
        var previousDrawAt = schedule.ScheduleKind == DrawScheduleKind.FixedInterval
            ? GetNextIntervalDrawAt(schedule, now).AddMinutes(-(schedule.IntervalMinutes ?? 5))
            : GetPreviousDailyDrawAt(schedule, now);
        upcoming.Insert(0, BuildLifecycleRecord(schedule, previousDrawAt, now, drawNumberOffset: -1));
        return upcoming.Select(draw => manualLifecycleOverrides.TryGetValue(draw.DrawId, out var manual) ? manual : draw).ToArray();
    }

    private IReadOnlyCollection<DrawLifecycleRecord> GenerateUpcomingDraws(DrawScheduleDefinition schedule, int count, DateTimeOffset now)
    {
        var draws = new List<DrawLifecycleRecord>();
        var currentDrawAt = schedule.ScheduleKind == DrawScheduleKind.FixedInterval
            ? GetNextIntervalDrawAt(schedule, now)
            : GetNextDailyDrawAt(schedule, now);

        for (var index = 0; index < count; index += 1)
        {
            var drawAt = schedule.ScheduleKind == DrawScheduleKind.FixedInterval
                ? currentDrawAt.AddMinutes((schedule.IntervalMinutes ?? 5) * index)
                : GetDailyDrawAtOffset(schedule, currentDrawAt, index);
            draws.Add(BuildLifecycleRecord(schedule, drawAt, now, index));
        }

        return draws.Select(draw => manualLifecycleOverrides.TryGetValue(draw.DrawId, out var manual) ? manual : draw).ToArray();
    }

    private DrawLifecycleRecord BuildLifecycleRecord(DrawScheduleDefinition schedule, DateTimeOffset drawAt, DateTimeOffset now, int drawNumberOffset)
    {
        var salesOpenAt = drawAt.Subtract(schedule.SalesOpenBeforeDraw);
        var salesCutoffAt = drawAt.Subtract(schedule.SalesCutoffBeforeDraw);
        var salesCloseAt = salesCutoffAt;
        var resultExpectedAt = drawAt.Add(schedule.ResultExpectedAfterDraw);
        var status = DetermineStatus(schedule, now, salesOpenAt, salesCutoffAt, drawAt, resultExpectedAt);
        var missed = status == DrawLifecycleStatus.ManualReviewRequired && now > resultExpectedAt;
        var salesAllowed = now >= salesOpenAt && now < salesCutoffAt && status == DrawLifecycleStatus.SalesOpen;
        var internalEligible = schedule.ResultSource == DrawResultSource.InternalGenerated
            && now >= salesCloseAt
            && status is DrawLifecycleStatus.SalesClosed or DrawLifecycleStatus.AwaitingResult or DrawLifecycleStatus.ManualReviewRequired;
        var reasons = BuildReasons(schedule, status, salesAllowed, internalEligible, missed);

        return new DrawLifecycleRecord(
            StableGuid($"{schedule.Code}:{drawAt.UtcDateTime:O}"),
            schedule.Id,
            schedule.GameBindingId,
            drawAt.ToUnixTimeSeconds() + drawNumberOffset,
            schedule.ResultSource,
            salesOpenAt,
            salesCutoffAt,
            salesCloseAt,
            drawAt,
            resultExpectedAt,
            status,
            salesAllowed,
            internalEligible,
            missed,
            ManualRecoveryMarked: false,
            reasons,
            DateTimeOffset.UtcNow);
    }

    private static DrawLifecycleStatus DetermineStatus(
        DrawScheduleDefinition schedule,
        DateTimeOffset now,
        DateTimeOffset salesOpenAt,
        DateTimeOffset salesCutoffAt,
        DateTimeOffset drawAt,
        DateTimeOffset resultExpectedAt)
    {
        if (now < salesOpenAt)
        {
            return DrawLifecycleStatus.Scheduled;
        }

        if (now < salesCutoffAt)
        {
            return DrawLifecycleStatus.SalesOpen;
        }

        if (now < drawAt)
        {
            return DrawLifecycleStatus.SalesClosed;
        }

        if (now <= resultExpectedAt)
        {
            return schedule.ResultSource == DrawResultSource.InternalGenerated
                ? DrawLifecycleStatus.SalesClosed
                : DrawLifecycleStatus.AwaitingResult;
        }

        return DrawLifecycleStatus.ManualReviewRequired;
    }

    private static IReadOnlyCollection<string> BuildReasons(
        DrawScheduleDefinition schedule,
        DrawLifecycleStatus status,
        bool salesAllowed,
        bool internalEligible,
        bool missed)
    {
        var reasons = new List<string>();
        if (!salesAllowed)
        {
            reasons.Add("Sales are closed or not yet open for this draw.");
        }

        if (schedule.ResultSource == DrawResultSource.InternalGenerated)
        {
            reasons.Add(internalEligible
                ? "Internal draw generation is eligible after sales close; production activation remains disabled."
                : "Internal draw generation is not eligible before sales close.");
        }
        else if (status is DrawLifecycleStatus.AwaitingResult or DrawLifecycleStatus.ManualReviewRequired)
        {
            reasons.Add("Official-feed/manual-result draw is awaiting result after sales close.");
        }

        if (missed)
        {
            reasons.Add("Result expected window has passed; manual recovery review is required.");
        }

        if (!schedule.ProductionActivationEnabled)
        {
            reasons.Add("Production scheduler activation is disabled.");
        }

        return reasons;
    }

    private static bool IsForwardTransition(DrawLifecycleStatus current, DrawLifecycleStatus requested)
    {
        var order = new[]
        {
            DrawLifecycleStatus.Scheduled,
            DrawLifecycleStatus.SalesOpen,
            DrawLifecycleStatus.SalesClosed,
            DrawLifecycleStatus.AwaitingResult,
            DrawLifecycleStatus.ResultSubmitted,
            DrawLifecycleStatus.Certified,
            DrawLifecycleStatus.EvaluationPending,
            DrawLifecycleStatus.EvaluationInProgress,
            DrawLifecycleStatus.EvaluationCompleted,
            DrawLifecycleStatus.SettlementReady
        };
        var currentIndex = Array.IndexOf(order, current);
        var requestedIndex = Array.IndexOf(order, requested);
        return currentIndex >= 0 && requestedIndex >= 0 && requestedIndex >= currentIndex;
    }

    private DateTimeOffset GetNextIntervalDrawAt(DrawScheduleDefinition schedule, DateTimeOffset now)
    {
        var interval = schedule.IntervalMinutes ?? 5;
        var roundedMinute = (now.Minute / interval) * interval;
        var candidate = new DateTimeOffset(now.Year, now.Month, now.Day, now.Hour, roundedMinute, 0, TimeSpan.Zero).AddMinutes(interval);
        return candidate <= now ? candidate.AddMinutes(interval) : candidate;
    }

    private DateTimeOffset GetNextDailyDrawAt(DrawScheduleDefinition schedule, DateTimeOffset now)
    {
        var zone = ResolveTimeZone(schedule.TimeZoneId);
        var localNow = TimeZoneInfo.ConvertTime(now, zone);
        foreach (var time in schedule.DailyDrawTimes.OrderBy(time => time))
        {
            var localCandidate = new DateTimeOffset(localNow.Year, localNow.Month, localNow.Day, time.Hour, time.Minute, 0, localNow.Offset);
            var candidate = TimeZoneInfo.ConvertTime(localCandidate, TimeZoneInfo.Utc);
            if (candidate > now)
            {
                return candidate;
            }
        }

        var firstTomorrow = schedule.DailyDrawTimes.OrderBy(time => time).First();
        var tomorrow = localNow.Date.AddDays(1);
        var nextLocal = new DateTimeOffset(tomorrow.Year, tomorrow.Month, tomorrow.Day, firstTomorrow.Hour, firstTomorrow.Minute, 0, localNow.Offset);
        return TimeZoneInfo.ConvertTime(nextLocal, TimeZoneInfo.Utc);
    }

    private DateTimeOffset GetPreviousDailyDrawAt(DrawScheduleDefinition schedule, DateTimeOffset now)
    {
        var zone = ResolveTimeZone(schedule.TimeZoneId);
        var localNow = TimeZoneInfo.ConvertTime(now, zone);
        foreach (var time in schedule.DailyDrawTimes.OrderByDescending(time => time))
        {
            var localCandidate = new DateTimeOffset(localNow.Year, localNow.Month, localNow.Day, time.Hour, time.Minute, 0, localNow.Offset);
            var candidate = TimeZoneInfo.ConvertTime(localCandidate, TimeZoneInfo.Utc);
            if (candidate < now)
            {
                return candidate;
            }
        }

        var lastYesterday = schedule.DailyDrawTimes.OrderByDescending(time => time).First();
        var yesterday = localNow.Date.AddDays(-1);
        var previousLocal = new DateTimeOffset(yesterday.Year, yesterday.Month, yesterday.Day, lastYesterday.Hour, lastYesterday.Minute, 0, localNow.Offset);
        return TimeZoneInfo.ConvertTime(previousLocal, TimeZoneInfo.Utc);
    }

    private DateTimeOffset GetDailyDrawAtOffset(DrawScheduleDefinition schedule, DateTimeOffset firstDrawAt, int offset)
    {
        var zone = ResolveTimeZone(schedule.TimeZoneId);
        var localFirst = TimeZoneInfo.ConvertTime(firstDrawAt, zone);
        var ordered = schedule.DailyDrawTimes.OrderBy(time => time).ToArray();
        var firstIndex = Array.FindIndex(ordered, time => time.Hour == localFirst.Hour && time.Minute == localFirst.Minute);
        if (firstIndex < 0)
        {
            firstIndex = 0;
        }

        var nextIndex = firstIndex + offset;
        var dayOffset = nextIndex / ordered.Length;
        var timeForDraw = ordered[nextIndex % ordered.Length];
        var localDate = localFirst.Date.AddDays(dayOffset);
        var localDraw = new DateTimeOffset(localDate.Year, localDate.Month, localDate.Day, timeForDraw.Hour, timeForDraw.Minute, 0, localFirst.Offset);
        return TimeZoneInfo.ConvertTime(localDraw, TimeZoneInfo.Utc);
    }

    private static TimeZoneInfo ResolveTimeZone(string timeZoneId)
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(timeZoneId);
        }
        catch (TimeZoneNotFoundException)
        {
            return TimeZoneInfo.Utc;
        }
        catch (InvalidTimeZoneException)
        {
            return TimeZoneInfo.Utc;
        }
    }

    private void SeedSchedules()
    {
        var bindings = gameModuleRegistry.GetGameBindings().ToArray();
        var testBinding = bindings.FirstOrDefault(binding => binding.GameType == GameType.Test) ?? bindings.First();
        var hotSpotBinding = bindings.FirstOrDefault(binding => binding.GameType == GameType.HotSpot) ?? bindings.First();
        var authorities = drawAuthorityRegistry.GetRegisteredAuthorities();
        var internalAuthority = authorities.Single(authority => authority.Authority.Code == "internal-test-prng");
        var manualAuthority = authorities.Single(authority => authority.Authority.Code == "manual-certified-entry");

        schedules.Add(new DrawScheduleDefinition(
            StableGuid("schedule:test-fixed-interval"),
            "test-fixed-interval",
            "Test Fixed Interval Draw Schedule",
            testBinding.Id,
            DrawScheduleKind.FixedInterval,
            DrawResultSource.InternalGenerated,
            DrawProviderType.InternalTestPrng,
            internalAuthority.Authority.Id,
            "UTC",
            IntervalMinutes: 5,
            DailyDrawTimes: [],
            SalesOpenBeforeDraw: TimeSpan.FromMinutes(5),
            SalesCutoffBeforeDraw: TimeSpan.FromMinutes(1),
            ResultExpectedAfterDraw: TimeSpan.FromMinutes(2),
            DrawRecoveryPolicy.ManualReview,
            ProductionActivationEnabled: false,
            DateTimeOffset.UnixEpoch));

        schedules.Add(new DrawScheduleDefinition(
            StableGuid("schedule:manual-daily"),
            "manual-daily",
            "Manual Certified Daily Draw Schedule",
            hotSpotBinding.Id,
            DrawScheduleKind.FixedDailyTime,
            DrawResultSource.ManualCertified,
            DrawProviderType.ManualCertifiedEntry,
            manualAuthority.Authority.Id,
            "UTC",
            IntervalMinutes: null,
            DailyDrawTimes: [new TimeOnly(12, 0), new TimeOnly(18, 0)],
            SalesOpenBeforeDraw: TimeSpan.FromHours(12),
            SalesCutoffBeforeDraw: TimeSpan.FromMinutes(15),
            ResultExpectedAfterDraw: TimeSpan.FromMinutes(30),
            DrawRecoveryPolicy.AwaitOfficialResult,
            ProductionActivationEnabled: false,
            DateTimeOffset.UnixEpoch));
    }

    private static Guid StableGuid(string input)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(input));
        return new Guid(bytes[..16]);
    }
}
