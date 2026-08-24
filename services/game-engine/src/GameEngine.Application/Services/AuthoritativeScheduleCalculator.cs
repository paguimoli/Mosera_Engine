using System.Security.Cryptography;
using System.Text;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed class AuthoritativeScheduleCalculator
{
    public IReadOnlyCollection<AuthoritativeDrawSlot> MaterializeWindow(
        DurableSchedulerProductDefinition definition,
        DateTimeOffset fromInclusive,
        DateTimeOffset toInclusive)
    {
        ValidateDefinition(definition);
        if (toInclusive < fromInclusive)
        {
            throw new ArgumentException("Scheduler window end must not precede its start.");
        }

        var zone = ResolveIanaTimeZone(definition.TimeZoneId);
        var instants = definition.ProductKind switch
        {
            DurableSchedulerProductKind.FastKeno => EnumerateFastKeno(
                definition,
                zone,
                fromInclusive,
                toInclusive),
            DurableSchedulerProductKind.HotSpot => EnumerateHotSpot(
                definition,
                zone,
                fromInclusive,
                toInclusive),
            _ => throw new InvalidOperationException("Unsupported durable scheduler product kind.")
        };

        return instants
            .Distinct()
            .OrderBy(value => value)
            .Select(instant => BuildSlot(definition, instant))
            .ToArray();
    }

    public IReadOnlyCollection<AuthoritativeDrawSlot> GetNextSlots(
        DurableSchedulerProductDefinition definition,
        DateTimeOffset afterExclusive,
        int count)
    {
        if (count <= 0 || count > 1000)
        {
            throw new ArgumentOutOfRangeException(nameof(count), "Draw count must be between 1 and 1000.");
        }

        var horizon = definition.ProductKind == DurableSchedulerProductKind.FastKeno
            ? TimeSpan.FromHours(12)
            : TimeSpan.FromDays(8);
        var candidates = MaterializeWindow(
                definition,
                afterExclusive.AddTicks(1),
                afterExclusive.Add(horizon))
            .Where(slot => slot.ScheduledExecutionAt > afterExclusive)
            .Take(count)
            .ToArray();
        if (candidates.Length != count)
        {
            throw new InvalidOperationException("The bounded schedule horizon did not contain the requested draws.");
        }

        return candidates;
    }

    public static TimeZoneInfo ResolveIanaTimeZone(string timeZoneId)
    {
        if (string.IsNullOrWhiteSpace(timeZoneId) ||
            !timeZoneId.Contains('/', StringComparison.Ordinal))
        {
            throw new InvalidOperationException("A valid IANA time-zone identifier is required.");
        }

        try
        {
            var zone = TimeZoneInfo.FindSystemTimeZoneById(timeZoneId);
            if (!string.Equals(zone.Id, timeZoneId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Time-zone aliases are not accepted for authoritative schedules.");
            }

            return zone;
        }
        catch (TimeZoneNotFoundException error)
        {
            throw new InvalidOperationException($"IANA time zone {timeZoneId} is unavailable.", error);
        }
        catch (InvalidTimeZoneException error)
        {
            throw new InvalidOperationException($"IANA time zone {timeZoneId} is invalid.", error);
        }
    }

    private static IEnumerable<DateTimeOffset> EnumerateFastKeno(
        DurableSchedulerProductDefinition definition,
        TimeZoneInfo zone,
        DateTimeOffset fromInclusive,
        DateTimeOffset toInclusive)
    {
        var firstLocalDate = DateOnly.FromDateTime(
            TimeZoneInfo.ConvertTime(fromInclusive, zone).DateTime).AddDays(-1);
        var lastLocalDate = DateOnly.FromDateTime(
            TimeZoneInfo.ConvertTime(toInclusive, zone).DateTime).AddDays(1);
        for (var date = firstLocalDate; date <= lastLocalDate; date = date.AddDays(1))
        {
            var anchor = ResolveLocalBoundary(date, definition.AnchorLocalTime, zone, allowInvalidBoundaryAdvance: false).Instant;
            var nextAnchor = ResolveLocalBoundary(
                date.AddDays(1),
                definition.AnchorLocalTime,
                zone,
                allowInvalidBoundaryAdvance: false).Instant;
            for (var instant = anchor; instant < nextAnchor; instant = instant.AddSeconds(definition.IntervalSeconds))
            {
                if (instant >= fromInclusive && instant <= toInclusive)
                {
                    yield return instant;
                }
            }
        }
    }

    private static IEnumerable<DateTimeOffset> EnumerateHotSpot(
        DurableSchedulerProductDefinition definition,
        TimeZoneInfo zone,
        DateTimeOffset fromInclusive,
        DateTimeOffset toInclusive)
    {
        var startTime = definition.ServiceWindowStart
            ?? throw new InvalidOperationException("Hot Spot requires a service-window start.");
        var endTime = definition.ServiceWindowEnd
            ?? throw new InvalidOperationException("Hot Spot requires a service-window end.");
        var firstLocalDate = DateOnly.FromDateTime(
            TimeZoneInfo.ConvertTime(fromInclusive, zone).DateTime).AddDays(-1);
        var lastLocalDate = DateOnly.FromDateTime(
            TimeZoneInfo.ConvertTime(toInclusive, zone).DateTime).AddDays(1);

        for (var date = firstLocalDate; date <= lastLocalDate; date = date.AddDays(1))
        {
            var start = ResolveLocalBoundary(date, startTime, zone, allowInvalidBoundaryAdvance: false);
            var endDate = endTime <= startTime ? date.AddDays(1) : date;
            var end = ResolveLocalBoundary(endDate, endTime, zone, allowInvalidBoundaryAdvance: true);
            for (var instant = start.Instant;
                 end.WasInvalid ? instant < end.Instant : instant <= end.Instant;
                 instant = instant.AddSeconds(definition.IntervalSeconds))
            {
                if (instant >= fromInclusive && instant <= toInclusive)
                {
                    yield return instant;
                }
            }
        }
    }

    private static (DateTimeOffset Instant, bool WasInvalid) ResolveLocalBoundary(
        DateOnly date,
        TimeOnly time,
        TimeZoneInfo zone,
        bool allowInvalidBoundaryAdvance)
    {
        var local = DateTime.SpecifyKind(date.ToDateTime(time), DateTimeKind.Unspecified);
        var wasInvalid = zone.IsInvalidTime(local);
        if (wasInvalid && !allowInvalidBoundaryAdvance)
        {
            throw new InvalidOperationException($"Authoritative local schedule boundary {local:O} does not exist in {zone.Id}.");
        }

        while (zone.IsInvalidTime(local))
        {
            local = local.AddMinutes(1);
        }

        if (zone.IsAmbiguousTime(local))
        {
            throw new InvalidOperationException($"Authoritative local schedule boundary {local:O} is ambiguous in {zone.Id}.");
        }

        var offset = zone.GetUtcOffset(local);
        return (new DateTimeOffset(local, offset).ToUniversalTime(), wasInvalid);
    }

    private static AuthoritativeDrawSlot BuildSlot(
        DurableSchedulerProductDefinition definition,
        DateTimeOffset scheduledAt)
    {
        var canonicalInstant = scheduledAt.ToUniversalTime();
        var identitySource =
            $"durable-scheduler:v1|{definition.ProductCode}|{definition.ProductVersionId:N}|" +
            $"{definition.ScheduleVersionId:N}|{canonicalInstant:O}";
        return new AuthoritativeDrawSlot(
            StableGuid(identitySource),
            definition.ProductId,
            definition.ProductVersionId,
            definition.ProductCode,
            definition.ScheduleVersionId,
            definition.DrawAuthorityAssignmentId,
            canonicalInstant.AddSeconds(-definition.IntervalSeconds),
            canonicalInstant.AddSeconds(-definition.CutoffSeconds),
            canonicalInstant,
            Hash(identitySource),
            definition.ScheduleHash);
    }

    private static void ValidateDefinition(DurableSchedulerProductDefinition definition)
    {
        if (definition.ProductId == Guid.Empty || definition.ProductVersionId == Guid.Empty ||
            definition.ScheduleId == Guid.Empty || definition.ScheduleVersionId == Guid.Empty ||
            definition.DrawAuthorityAssignmentId == Guid.Empty)
        {
            throw new InvalidOperationException("Authoritative product and schedule identities are required.");
        }
        if (string.IsNullOrWhiteSpace(definition.ProductCode) ||
            string.IsNullOrWhiteSpace(definition.ProductVersionHash) ||
            string.IsNullOrWhiteSpace(definition.ScheduleHash))
        {
            throw new InvalidOperationException("Authoritative product and schedule hashes are required.");
        }
        if (definition.IntervalSeconds <= 0 || definition.CutoffSeconds <= 0 ||
            definition.CutoffSeconds >= definition.IntervalSeconds)
        {
            throw new InvalidOperationException("Schedule interval and cutoff configuration is invalid.");
        }
        if (definition.ProductKind == DurableSchedulerProductKind.FastKeno &&
            (definition.IntervalSeconds != 25 || definition.CutoffSeconds != 5 ||
             definition.AnchorLocalTime != TimeOnly.MinValue))
        {
            throw new InvalidOperationException("Fast Keno must retain the approved 25-second midnight-anchor schedule and five-second cutoff.");
        }
        if (definition.ProductKind == DurableSchedulerProductKind.HotSpot &&
            (definition.IntervalSeconds != 240 || definition.CutoffSeconds != 15 ||
             definition.ServiceWindowStart != new TimeOnly(6, 0) ||
             definition.ServiceWindowEnd != new TimeOnly(2, 0)))
        {
            throw new InvalidOperationException("Hot Spot must retain the approved four-minute 06:00-02:00 schedule and fifteen-second cutoff.");
        }
    }

    public static Guid StableGuid(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes.AsSpan(0, 16));
    }

    public static string Hash(string value) =>
        $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
}
