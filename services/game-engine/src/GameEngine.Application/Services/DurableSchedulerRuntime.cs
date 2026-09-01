using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GameEngine.Application.Interfaces;
using GameEngine.Domain.Model;

namespace GameEngine.Application.Services;

public sealed record DurableSchedulerOptions(
    bool HostedRuntimeEnabled,
    bool ProductionExecutionEnabled,
    TimeSpan FastKenoHorizon,
    TimeSpan HotSpotHorizon,
    TimeSpan RecoveryWindow,
    TimeSpan ClaimLease,
    TimeSpan PollInterval)
{
    public static DurableSchedulerOptions Disabled { get; } = new(
        false,
        false,
        TimeSpan.FromMinutes(15),
        TimeSpan.FromHours(24),
        TimeSpan.FromMinutes(10),
        TimeSpan.FromSeconds(20),
        TimeSpan.FromSeconds(2));
}

public interface IDurableSchedulerRepository
{
    Task<bool> CheckReadinessAsync(CancellationToken cancellationToken);

    Task<IReadOnlyCollection<DurableSchedulerProductDefinition>> ListProductDefinitionsAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken);

    Task<IReadOnlyCollection<DurableScheduledDraw>> MaterializeAsync(
        DurableSchedulerProductDefinition definition,
        IReadOnlyCollection<AuthoritativeDrawSlot> slots,
        TimeSpan recoveryWindow,
        CancellationToken cancellationToken);

    Task AdvanceTimeStatesAsync(DateTimeOffset now, CancellationToken cancellationToken);

    Task<IReadOnlyCollection<DurableScheduledDraw>> ListDueAsync(
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken);

    Task<bool> HasFundedAcceptedWagersAsync(Guid drawId, CancellationToken cancellationToken);

    Task<DurableSchedulerExecutionClaim> TryClaimExecutionAsync(
        Guid drawId,
        string ownerId,
        TimeSpan lease,
        DateTimeOffset now,
        CancellationToken cancellationToken);

    Task RecordExecutionStateAsync(
        Guid drawId,
        DurableSchedulerDrawState state,
        string reasonCode,
        string evidenceHash,
        DateTimeOffset occurredAt,
        CancellationToken cancellationToken);

    Task<DurableSchedulerOperationalStatus> GetOperationalStatusAsync(
        bool hostedRuntimeEnabled,
        bool productionExecutionEnabled,
        DateTimeOffset now,
        CancellationToken cancellationToken);
}

public interface IScheduledDrawExecutionInvoker
{
    Task<ScheduledDrawInvocationResult> InvokeAsync(
        DurableScheduledDraw draw,
        CancellationToken cancellationToken);
}

public sealed record ScheduledDrawInvocationResult(
    DurableSchedulerDrawState State,
    string EvidenceHash,
    bool Duplicate,
    bool SettlementTriggered);

public sealed class CanonicalScheduledDrawExecutionInvoker(
    CanonicalDrawExecutionAuthority authority,
    CanonicalOutcomeCertificateAuthority certificateAuthority,
    SchedulerOutcomeCompletionFanout fanout,
    SchedulerOutcomeFanoutOptions options) : IScheduledDrawExecutionInvoker
{
    public async Task<ScheduledDrawInvocationResult> InvokeAsync(
        DurableScheduledDraw draw,
        CancellationToken cancellationToken)
    {
        var correlationId = $"durable-scheduler:{draw.Slot.DrawId:N}";
        var command = new CanonicalDrawExecutionCommand(
            draw.Slot.DrawId,
            $"{draw.Slot.ProductCode}:{draw.Slot.ProductVersionId:N}",
            $"durable-scheduler-execution:{draw.Slot.DrawId:N}",
            OutcomeCertificateId: null,
            SettlementInputId: null,
            correlationId,
            $"schedule:{draw.Slot.ScheduleVersionId:N}",
            $"scheduler-audit:{draw.Slot.DrawIdentityHash}",
            "SYSTEM:DURABLE_SCHEDULER",
            "AUTHORITATIVE_SCHEDULE_DUE");
        var result = await authority.ExecuteAsync(command, cancellationToken);
        var duplicate = result.ExistingGeneration;
        if (result.Status == CanonicalDrawExecutionStatus.AwaitingCertification)
        {
            var issued = await certificateAuthority.IssueAsync(result, cancellationToken);
            duplicate |= issued.Duplicate;
            result = await authority.ExecuteAsync(
                command with { OutcomeCertificateId = issued.Certificate.CertificateId },
                cancellationToken);
            if (options.ShouldInjectFailure("AfterCertificateBeforeFanout"))
            {
                throw new InvalidOperationException(
                    "PR-04A qualification failure injected after certification and before fanout.");
            }
        }
        if (result.Outcome is null || result.Status != CanonicalDrawExecutionStatus.Published)
        {
            throw new InvalidOperationException(
                "Canonical scheduler execution did not reach an authoritative published outcome.");
        }

        var fanoutResult = await fanout.ExecuteAsync(result.Outcome, cancellationToken);
        var state = fanoutResult.SettlementRequestCount > 0
            ? DurableSchedulerDrawState.SettlementTriggered
            : DurableSchedulerDrawState.AuthoritativeResult;
        return new ScheduledDrawInvocationResult(
            state,
            fanoutResult.EvidenceHash,
            duplicate,
            fanoutResult.SettlementRequestCount > 0);
    }
}

public interface IHotSpotRuntimeEvidenceRepository
{
    Task<HotSpotQuickPickSelection?> FindQuickPickAsync(
        string idempotencyKey,
        CancellationToken cancellationToken);

    Task<HotSpotQuickPickSelection> PersistQuickPickAsync(
        HotSpotQuickPickSelection selection,
        CancellationToken cancellationToken);

    Task<HotSpotBullseyeEvidence?> FindBullseyeAsync(
        Guid drawId,
        CancellationToken cancellationToken);

    Task<HotSpotBullseyeEvidence> PersistBullseyeAsync(
        HotSpotBullseyeEvidence evidence,
        CancellationToken cancellationToken);

    Task<IReadOnlyCollection<DurableScheduledDraw>> ListNextAcceptingHotSpotDrawsAsync(
        Guid ticketId,
        DateTimeOffset after,
        int count,
        CancellationToken cancellationToken);

    Task<HotSpotMultiDrawPlan?> FindMultiDrawPlanAsync(
        Guid purchaseId,
        CancellationToken cancellationToken);

    Task<HotSpotMultiDrawPlan> PersistMultiDrawPlanAsync(
        HotSpotMultiDrawPlan plan,
        CancellationToken cancellationToken);

    Task<HotSpotMultiDrawCancellationResult> CancelFutureParticipationsAsync(
        HotSpotMultiDrawCancellationRequest request,
        DateTimeOffset cancelledAt,
        CancellationToken cancellationToken);
}

public sealed class SystemClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}

public sealed class DurableSchedulerRuntime(
    IDurableSchedulerRepository repository,
    AuthoritativeScheduleCalculator calculator,
    IScheduledDrawExecutionInvoker executionInvoker,
    IClock clock,
    DurableSchedulerOptions options)
{
    public async Task<DurableSchedulerCycleResult> RunCycleAsync(
        string ownerId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(ownerId))
        {
            throw new ArgumentException("Scheduler owner id is required.", nameof(ownerId));
        }

        var startedAt = clock.UtcNow;
        if (!options.HostedRuntimeEnabled)
        {
            return new DurableSchedulerCycleResult(
                0, 0, 0, 0, 0, 0, false, startedAt, clock.UtcNow,
                ["Durable scheduler hosted runtime is disabled by configuration."]);
        }
        if (!await repository.CheckReadinessAsync(cancellationToken))
        {
            throw new InvalidOperationException("Durable scheduler persistence or advisory locking is unavailable.");
        }

        var definitions = await repository.ListProductDefinitionsAsync(startedAt, cancellationToken);
        var eligible = definitions
            .Where(definition => definition.Published && definition.Active && definition.Assigned)
            .Where(definition => definition.EffectiveFrom is null || definition.EffectiveFrom <= startedAt)
            .Where(definition => definition.EffectiveTo is null || definition.EffectiveTo > startedAt)
            .ToArray();
        var materializedCount = 0;
        var blockers = new List<string>();
        foreach (var definition in eligible)
        {
            var horizon = definition.ProductKind == DurableSchedulerProductKind.FastKeno
                ? options.FastKenoHorizon
                : options.HotSpotHorizon;
            var slots = calculator.MaterializeWindow(
                definition,
                startedAt,
                startedAt.Add(horizon));
            materializedCount += (await repository.MaterializeAsync(
                definition,
                slots,
                options.RecoveryWindow,
                cancellationToken)).Count;
        }

        await repository.AdvanceTimeStatesAsync(startedAt, cancellationToken);
        var due = await repository.ListDueAsync(startedAt, 100, cancellationToken);
        var claimed = 0;
        var duplicates = 0;
        var recovery = 0;
        foreach (var draw in due)
        {
            if (startedAt > draw.RecoveryDeadlineAt &&
                draw.State != DurableSchedulerDrawState.RecoveryRequired)
            {
                var funded = await repository.HasFundedAcceptedWagersAsync(draw.Slot.DrawId, cancellationToken);
                var state = funded
                    ? DurableSchedulerDrawState.RecoveryRequired
                    : DurableSchedulerDrawState.SkippedNoWagers;
                await repository.RecordExecutionStateAsync(
                    draw.Slot.DrawId,
                    state,
                    funded ? "MISSED_DRAW_FUNDED_WAGERS" : "MISSED_DRAW_NO_WAGERS",
                    Hash($"{draw.Slot.DrawIdentityHash}|{state}|{startedAt:O}"),
                    startedAt,
                    cancellationToken);
                recovery += funded ? 1 : 0;
                continue;
            }

            if (!options.ProductionExecutionEnabled)
            {
                continue;
            }

            var claim = await repository.TryClaimExecutionAsync(
                draw.Slot.DrawId,
                ownerId,
                options.ClaimLease,
                startedAt,
                cancellationToken);
            if (claim.Status != DurableSchedulerClaimStatus.Acquired)
            {
                duplicates += claim.Status == DurableSchedulerClaimStatus.Duplicate ? 1 : 0;
                continue;
            }

            claimed += 1;
            try
            {
                var result = await executionInvoker.InvokeAsync(draw, cancellationToken);
                await repository.RecordExecutionStateAsync(
                    draw.Slot.DrawId,
                    result.State,
                    result.SettlementTriggered ? "SETTLEMENT_TRIGGERED" : "CANONICAL_EXECUTION_PROGRESS",
                    result.EvidenceHash,
                    clock.UtcNow,
                    cancellationToken);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                blockers.Add($"Draw {draw.Slot.DrawId}: {error.GetType().Name}: {error.Message}");
                await repository.RecordExecutionStateAsync(
                    draw.Slot.DrawId,
                    DurableSchedulerDrawState.RecoveryRequired,
                    "CANONICAL_EXECUTION_FAILED",
                    Hash($"{draw.Slot.DrawIdentityHash}|{error.GetType().Name}|{error.Message}"),
                    clock.UtcNow,
                    cancellationToken);
                recovery += 1;
            }
        }

        return new DurableSchedulerCycleResult(
            eligible.Length,
            materializedCount,
            due.Count,
            claimed,
            duplicates,
            recovery,
            options.ProductionExecutionEnabled,
            startedAt,
            clock.UtcNow,
            blockers);
    }

    private static string Hash(string value) => AuthoritativeScheduleCalculator.Hash(value);
}

public sealed class PurposeSeparatedRandomnessService(
    IOsEntropyProvider entropyProvider,
    IHmacDrbgRuntime drbgRuntime,
    ICertifiedCsprngSampler sampler)
{
    private const int EntropyBytes = 48;
    private const int NonceBytes = 32;

    public IReadOnlyList<int> SelectUnique(
        string purposeDomain,
        string identity,
        IReadOnlyList<int> universe,
        int count)
    {
        if (string.IsNullOrWhiteSpace(purposeDomain) || string.IsNullOrWhiteSpace(identity))
        {
            throw new ArgumentException("Purpose domain and immutable identity are required.");
        }
        if (universe.Count == 0 || universe.Distinct().Count() != universe.Count || count <= 0 || count > universe.Count)
        {
            throw new ArgumentException("Secure selection universe and count are invalid.");
        }

        var entropy = new byte[EntropyBytes];
        var nonce = new byte[NonceBytes];
        var reseed = new byte[EntropyBytes];
        var personalization = Encoding.UTF8.GetBytes($"{purposeDomain}|{identity}");
        HmacDrbgSession? session = null;
        try
        {
            entropyProvider.Fill(entropy);
            entropyProvider.Fill(nonce);
            entropyProvider.Fill(reseed);
            session = drbgRuntime.Instantiate(
                CertifiedCsprngHashAlgorithm.Sha256,
                entropy,
                nonce,
                personalization,
                256);
            drbgRuntime.Reseed(session, reseed, personalization);
            return sampler.SelectNumbers(
                session,
                universe,
                count,
                unique: true,
                withReplacement: false,
                OutcomeNumberOrdering.Ascending);
        }
        finally
        {
            if (session is not null)
            {
                drbgRuntime.Destroy(session);
            }

            CryptographicOperations.ZeroMemory(entropy);
            CryptographicOperations.ZeroMemory(nonce);
            CryptographicOperations.ZeroMemory(reseed);
            CryptographicOperations.ZeroMemory(personalization);
        }
    }
}

public sealed class HotSpotQuickPickAuthority(
    IHotSpotRuntimeEvidenceRepository repository,
    PurposeSeparatedRandomnessService randomness,
    IClock clock)
{
    public const string PurposeDomain = "HOT_SPOT_QUICK_PICK_V1";

    public async Task<HotSpotQuickPickSelection> GenerateAsync(
        HotSpotQuickPickRequest request,
        CancellationToken cancellationToken)
    {
        if (request.TicketRequestId == Guid.Empty || string.IsNullOrWhiteSpace(request.IdempotencyKey) ||
            string.IsNullOrWhiteSpace(request.ProductVersionHash) || request.SpotCount is < 1 or > 10)
        {
            throw new ArgumentException("Hot Spot Quick Pick request is invalid.");
        }

        var existing = await repository.FindQuickPickAsync(request.IdempotencyKey, cancellationToken);
        if (existing is not null)
        {
            if (existing.TicketRequestId != request.TicketRequestId || existing.SpotCount != request.SpotCount ||
                !string.Equals(existing.ProductVersionHash, request.ProductVersionHash, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Quick Pick idempotency payload conflict.");
            }

            return existing with { Duplicate = true };
        }

        var numbers = randomness.SelectUnique(
            PurposeDomain,
            $"{request.TicketRequestId:N}|{request.IdempotencyKey}|{request.ProductVersionHash}",
            Enumerable.Range(1, 80).ToArray(),
            request.SpotCount);
        var generatedAt = clock.UtcNow;
        var hash = Hash(JsonSerializer.Serialize(new
        {
            request.TicketRequestId,
            request.IdempotencyKey,
            request.SpotCount,
            Numbers = numbers,
            PurposeDomain,
            request.ProductVersionHash
        }));
        return await repository.PersistQuickPickAsync(
            new HotSpotQuickPickSelection(
                StableGuid($"quick-pick|{request.IdempotencyKey}"),
                request.TicketRequestId,
                request.IdempotencyKey,
                request.SpotCount,
                numbers,
                PurposeDomain,
                request.ProductVersionHash,
                hash,
                generatedAt,
                Duplicate: false),
            cancellationToken);
    }

    private static Guid StableGuid(string value) => AuthoritativeScheduleCalculator.StableGuid(value);
    private static string Hash(string value) => AuthoritativeScheduleCalculator.Hash(value);
}

public sealed class HotSpotBullseyeAuthority(
    IHotSpotRuntimeEvidenceRepository repository,
    PurposeSeparatedRandomnessService randomness,
    IClock clock)
{
    public const string PurposeDomain = "HOT_SPOT_BULLSEYE_V1";

    public async Task<HotSpotBullseyeEvidence> DesignateAsync(
        Guid drawId,
        Guid executionManifestId,
        IReadOnlyList<int> certifiedNumbers,
        string primaryResultHash,
        string providerConfigurationHash,
        CancellationToken cancellationToken)
    {
        if (drawId == Guid.Empty || executionManifestId == Guid.Empty ||
            certifiedNumbers.Count != 20 || certifiedNumbers.Distinct().Count() != 20 ||
            certifiedNumbers.Any(number => number is < 1 or > 80) ||
            string.IsNullOrWhiteSpace(primaryResultHash) || string.IsNullOrWhiteSpace(providerConfigurationHash))
        {
            throw new ArgumentException("Hot Spot Bullseye requires an exact certified 20-of-80 result and immutable lineage.");
        }

        var existing = await repository.FindBullseyeAsync(drawId, cancellationToken);
        if (existing is not null)
        {
            if (existing.ExecutionManifestId != executionManifestId ||
                !string.Equals(existing.PrimaryResultHash, primaryResultHash, StringComparison.Ordinal) ||
                !string.Equals(existing.ProviderConfigurationHash, providerConfigurationHash, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Bullseye immutable draw evidence conflicts with the retry request.");
            }

            return existing with { Duplicate = true };
        }

        var bullseye = randomness.SelectUnique(
            PurposeDomain,
            $"{drawId:N}|{executionManifestId:N}|{primaryResultHash}|{providerConfigurationHash}",
            certifiedNumbers,
            1).Single();
        var generatedAt = clock.UtcNow;
        var evidenceHash = Hash(
            $"{PurposeDomain}|{drawId:N}|{executionManifestId:N}|{bullseye}|" +
            $"{primaryResultHash}|{providerConfigurationHash}");
        return await repository.PersistBullseyeAsync(
            new HotSpotBullseyeEvidence(
                StableGuid($"bullseye|{drawId:N}"),
                drawId,
                executionManifestId,
                bullseye,
                PurposeDomain,
                primaryResultHash,
                providerConfigurationHash,
                evidenceHash,
                generatedAt,
                Duplicate: false),
            cancellationToken);
    }

    private static Guid StableGuid(string value) => AuthoritativeScheduleCalculator.StableGuid(value);
    private static string Hash(string value) => AuthoritativeScheduleCalculator.Hash(value);
}

public sealed class HotSpotMultiDrawAuthority(
    IHotSpotRuntimeEvidenceRepository repository,
    IClock clock)
{
    private static readonly int[] AllowedCounts = [1, 5, 10, 20];

    public async Task<HotSpotMultiDrawPlan> BindAsync(
        Guid purchaseId,
        Guid ticketId,
        int drawCount,
        long stakePerDrawMinor,
        HotSpotQuickPickSelection? quickPick,
        CancellationToken cancellationToken)
    {
        if (purchaseId == Guid.Empty || ticketId == Guid.Empty || !AllowedCounts.Contains(drawCount) || stakePerDrawMinor <= 0)
        {
            throw new ArgumentException("Hot Spot multi-draw request is invalid.");
        }

        var existing = await repository.FindMultiDrawPlanAsync(purchaseId, cancellationToken);
        if (existing is not null)
        {
            if (existing.TicketId != ticketId || existing.DrawCount != drawCount ||
                existing.StakePerDrawMinor != stakePerDrawMinor ||
                existing.QuickPick?.SelectionHash != quickPick?.SelectionHash)
            {
                throw new InvalidOperationException("Multi-draw idempotency payload conflict.");
            }

            return existing with { Duplicate = true };
        }

        var now = clock.UtcNow;
        var draws = await repository.ListNextAcceptingHotSpotDrawsAsync(ticketId, now, drawCount, cancellationToken);
        if (draws.Count != drawCount)
        {
            throw new InvalidOperationException("The exact next valid Hot Spot draw sequence is unavailable.");
        }

        var bindings = draws.OrderBy(draw => draw.Slot.ScheduledExecutionAt)
            .Select((draw, index) => new HotSpotMultiDrawBinding(
                StableGuid($"multi-draw-binding|{purchaseId:N}|{draw.Slot.DrawId:N}"),
                purchaseId,
                ticketId,
                draw.Slot.DrawId,
                index + 1,
                draw.PublicDrawNumber,
                draw.Slot.DrawIdentityHash,
                Hash($"{purchaseId:N}|{ticketId:N}|{index + 1}|{draw.Slot.DrawIdentityHash}"),
                now))
            .ToArray();
        var total = checked(stakePerDrawMinor * drawCount);
        var planHash = Hash(string.Join('|', new[]
        {
            purchaseId.ToString("N"),
            ticketId.ToString("N"),
            drawCount.ToString(),
            stakePerDrawMinor.ToString(),
            total.ToString(),
            quickPick?.SelectionHash ?? "manual"
        }.Concat(bindings.Select(binding => binding.BindingHash))));
        return await repository.PersistMultiDrawPlanAsync(
            new HotSpotMultiDrawPlan(
                purchaseId,
                ticketId,
                drawCount,
                stakePerDrawMinor,
                total,
                quickPick,
                bindings,
                planHash,
                Duplicate: false),
            cancellationToken);
    }

    public Task<HotSpotMultiDrawCancellationResult> CancelFutureAsync(
        HotSpotMultiDrawCancellationRequest request,
        CancellationToken cancellationToken)
    {
        if (request.PurchaseId == Guid.Empty ||
            string.IsNullOrWhiteSpace(request.IdempotencyKey) ||
            string.IsNullOrWhiteSpace(request.ReasonCode) ||
            string.IsNullOrWhiteSpace(request.RequestedBy) ||
            string.IsNullOrWhiteSpace(request.CorrelationId))
        {
            throw new ArgumentException("Hot Spot future cancellation request is invalid.", nameof(request));
        }

        return repository.CancelFutureParticipationsAsync(request, clock.UtcNow, cancellationToken);
    }

    private static Guid StableGuid(string value) => AuthoritativeScheduleCalculator.StableGuid(value);
    private static string Hash(string value) => AuthoritativeScheduleCalculator.Hash(value);
}
