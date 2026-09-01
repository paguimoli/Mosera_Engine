using System.Text.Json;
using GameEngine.Application.Services;
using GameEngine.Domain.Model;
using Npgsql;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresDurableSchedulerRepository(string connectionString) :
    IDurableSchedulerRepository,
    IHotSpotRuntimeEvidenceRepository
{
    public async Task<bool> CheckReadinessAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select
  to_regclass('game_engine.durable_scheduler_draws') is not null
  and to_regclass('game_engine.durable_scheduler_events') is not null
  and to_regclass('game_engine.durable_scheduler_execution_leases') is not null
  and to_regclass('game_engine.durable_scheduler_execution_attempts') is not null
  and to_regprocedure('game_engine.durable_scheduler_advance_time(timestamp with time zone)') is not null;
""";
            return await command.ExecuteScalarAsync(cancellationToken) is true;
        }
        catch (Exception error) when (error is NpgsqlException or TimeoutException)
        {
            return false;
        }
    }

    public async Task<IReadOnlyCollection<DurableSchedulerProductDefinition>> ListProductDefinitionsAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  definition.id,
  version.id,
  definition.code,
  schedule.schedule_id,
  schedule.schedule_version_id,
  schedule.draw_authority_assignment_id,
  schedule.time_zone_id,
  schedule.schedule_configuration::text,
  version.publication_state,
  version.activation_state,
  version.assignment_state,
  version.effective_from,
  version.effective_to,
  schedule.schedule_hash,
  version.definition_hash,
  definition.active_version_id
from game_engine.game_definitions definition
join game_engine.game_definition_versions version
  on version.game_definition_id = definition.id
join game_engine.published_draw_schedule_versions schedule
  on schedule.schedule_version_id = version.schedule_version_id
where definition.code in ('FAST_KENO_V1', 'HOT_SPOT_V1')
  and version.publication_state = 'PUBLISHED'
order by definition.code, version.version_number desc;
""";
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var definitions = new List<DurableSchedulerProductDefinition>();
        while (await reader.ReadAsync(cancellationToken))
        {
            using var configuration = JsonDocument.Parse(reader.GetString(7));
            var root = configuration.RootElement;
            var productCode = reader.GetString(2);
            var isFastKeno = string.Equals(productCode, "FAST_KENO_V1", StringComparison.Ordinal);
            definitions.Add(new DurableSchedulerProductDefinition(
                isFastKeno ? DurableSchedulerProductKind.FastKeno : DurableSchedulerProductKind.HotSpot,
                reader.GetGuid(0),
                reader.GetGuid(1),
                productCode,
                reader.GetGuid(3),
                reader.GetGuid(4),
                reader.GetGuid(5),
                reader.GetString(6),
                isFastKeno ? root.GetProperty("intervalSeconds").GetInt32() : checked(root.GetProperty("intervalMinutes").GetInt32() * 60),
                root.GetProperty("cutoffSeconds").GetInt32(),
                isFastKeno
                    ? TimeOnly.Parse(root.GetProperty("anchorLocalTime").GetString()!)
                    : TimeOnly.MinValue,
                isFastKeno ? null : TimeOnly.Parse(root.GetProperty("firstDrawLocalTime").GetString()!),
                isFastKeno ? null : TimeOnly.Parse(root.GetProperty("finalDrawLocalTime").GetString()!),
                isFastKeno
                    ? []
                    : root.GetProperty("multiDrawCounts").EnumerateArray().Select(value => value.GetInt32()).ToArray(),
                string.Equals(reader.GetString(8), "PUBLISHED", StringComparison.Ordinal),
                string.Equals(reader.GetString(9), "ACTIVE", StringComparison.Ordinal) &&
                    !reader.IsDBNull(15) && reader.GetGuid(15) == reader.GetGuid(1),
                string.Equals(reader.GetString(10), "ASSIGNED", StringComparison.Ordinal),
                reader.IsDBNull(11) ? null : reader.GetFieldValue<DateTimeOffset>(11),
                reader.IsDBNull(12) ? null : reader.GetFieldValue<DateTimeOffset>(12),
                reader.GetString(13),
                reader.GetString(14)));
        }

        return definitions;
    }

    public async Task<IReadOnlyCollection<DurableScheduledDraw>> MaterializeAsync(
        DurableSchedulerProductDefinition definition,
        IReadOnlyCollection<AuthoritativeDrawSlot> slots,
        TimeSpan recoveryWindow,
        CancellationToken cancellationToken)
    {
        var draws = new List<DurableScheduledDraw>();
        if (slots.Count == 0)
        {
            return draws;
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var lockCommand = connection.CreateCommand())
        {
            lockCommand.Transaction = transaction;
            lockCommand.CommandText = "select pg_advisory_xact_lock(hashtextextended('durable-scheduler-materialize:' || @product_code, 0));";
            lockCommand.Parameters.AddWithValue("product_code", definition.ProductCode);
            await lockCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        var orderedSlots = slots.OrderBy(item => item.ScheduledExecutionAt).ToArray();
        var existingInstants = new HashSet<DateTimeOffset>();
        await using (var existingCommand = connection.CreateCommand())
        {
            existingCommand.Transaction = transaction;
            existingCommand.CommandText = """
select scheduled_execution_at
from game_engine.durable_scheduler_draws
where schedule_version_id = @schedule_version_id
  and scheduled_execution_at between @window_start and @window_end;
""";
            existingCommand.Parameters.AddWithValue("schedule_version_id", definition.ScheduleVersionId);
            existingCommand.Parameters.AddWithValue("window_start", orderedSlots[0].ScheduledExecutionAt);
            existingCommand.Parameters.AddWithValue("window_end", orderedSlots[^1].ScheduledExecutionAt);
            await using var reader = await existingCommand.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                existingInstants.Add(reader.GetFieldValue<DateTimeOffset>(0));
            }
        }

        foreach (var slot in orderedSlots.Where(item => !existingInstants.Contains(item.ScheduledExecutionAt)))
        {
            await using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
with eligible_version as (
  select version.id
  from game_engine.game_definition_versions version
  join game_engine.game_definitions definition
    on definition.id = version.game_definition_id
  where version.id = @product_version_id
    and definition.id = @product_id
    and definition.active_version_id = version.id
    and version.publication_state = 'PUBLISHED'
    and version.activation_state = 'ACTIVE'
    and version.assignment_state = 'ASSIGNED'
    and (version.effective_from is null or version.effective_from <= clock_timestamp())
    and (version.effective_to is null or version.effective_to > clock_timestamp())
), existing as (
  select draw_id, public_draw_number
  from game_engine.durable_scheduler_draws
  where schedule_version_id = @schedule_version_id
    and scheduled_execution_at = @scheduled_execution_at
), allocated as (
  insert into game_engine.durable_scheduler_product_sequences(
    product_code, next_public_draw_number)
  select @product_code,
    coalesce((
      select max(runtime.public_draw_number) + 2
      from game_engine.durable_scheduler_draws runtime
      where runtime.product_code = @product_code
    ), 2)
  from eligible_version
  where not exists (select 1 from existing)
  on conflict (product_code) do update
    set next_public_draw_number =
      greatest(
        game_engine.durable_scheduler_product_sequences.next_public_draw_number + 1,
        excluded.next_public_draw_number)
  returning next_public_draw_number - 1 as public_draw_number
), inserted_draw as (
  insert into game_engine.draw_schedules(
    id, game_definition_id, draw_authority_assignment_id,
    sales_open_at, sales_close_at, draw_at, status,
    schedule_version_id, scheduled_execution_at, schedule_hash, draw_identity_hash)
  select
    @draw_id, @product_id, @draw_authority_assignment_id,
    @sales_open_at, @cutoff_at, @scheduled_execution_at,
    case
      when clock_timestamp() < @sales_open_at then 'Scheduled'
      when clock_timestamp() < @cutoff_at then 'SalesOpen'
      when clock_timestamp() < @scheduled_execution_at then 'SalesClosed'
      else 'AwaitingResult'
    end,
    @schedule_version_id, @scheduled_execution_at, @schedule_hash, @draw_identity_hash
  where exists (select 1 from eligible_version)
    and not exists (select 1 from existing)
  on conflict (schedule_version_id, scheduled_execution_at) do nothing
  returning id
), inserted_runtime as (
  insert into game_engine.durable_scheduler_draws(
    draw_id, product_id, product_version_id, product_code,
    schedule_version_id, public_draw_number, sales_open_at, cutoff_at,
    scheduled_execution_at, draw_identity_hash, scheduler_state,
    recovery_deadline_at, materialized_at)
  select
    @draw_id, @product_id, @product_version_id, @product_code,
    @schedule_version_id, allocated.public_draw_number, @sales_open_at, @cutoff_at,
    @scheduled_execution_at, @draw_identity_hash,
    case
      when clock_timestamp() < @sales_open_at then 'Scheduled'
      when clock_timestamp() < @cutoff_at then 'Accepting'
      when clock_timestamp() < @scheduled_execution_at then 'Cutoff'
      else 'ExecutionDue'
    end,
    @recovery_deadline_at, clock_timestamp()
  from allocated
  where exists (select 1 from inserted_draw)
  on conflict (schedule_version_id, scheduled_execution_at) do nothing
  returning
    draw_id, product_id, product_version_id, product_code,
    schedule_version_id, sales_open_at, cutoff_at,
    scheduled_execution_at, draw_identity_hash, public_draw_number,
    scheduler_state, recovery_deadline_at, materialized_at,
    authoritative_result_at, settlement_requested_at, wallet_available_at
), selected_runtime as (
  select * from inserted_runtime
  union all
  select
    runtime.draw_id, runtime.product_id, runtime.product_version_id,
    runtime.product_code, runtime.schedule_version_id, runtime.sales_open_at,
    runtime.cutoff_at, runtime.scheduled_execution_at,
    runtime.draw_identity_hash, runtime.public_draw_number,
    runtime.scheduler_state, runtime.recovery_deadline_at,
    runtime.materialized_at, runtime.authoritative_result_at,
    runtime.settlement_requested_at, runtime.wallet_available_at
  from game_engine.durable_scheduler_draws runtime
  where runtime.schedule_version_id = @schedule_version_id
    and runtime.scheduled_execution_at = @scheduled_execution_at
    and not exists (select 1 from inserted_runtime)
), inserted_manifest as (
  insert into game_engine.draw_execution_manifests(
    execution_manifest_id, draw_id, schedule_version_id,
    game_definition_version_id, draw_authority_version_id,
    engine_name, engine_version, outcome_provider_id, outcome_provider_version,
    provider_configuration_version, evaluator_version, paytable_version,
    scheduled_execution_at, schedule_hash, draw_identity_hash,
    canonical_manifest_hash, created_at)
  select
    @execution_manifest_id, runtime.draw_id, @schedule_version_id,
    version.id, assignment.draw_authority_version_id,
    module.code, module_version.version,
    version.outcome_provider_id, version.outcome_provider_version,
    version.provider_configuration_version, version.evaluator_version,
    version.paytable_version, @scheduled_execution_at, @schedule_hash,
    @draw_identity_hash, @execution_manifest_hash, runtime.materialized_at
  from selected_runtime runtime
  join game_engine.game_definition_versions version on version.id = @product_version_id
  join game_engine.game_definitions definition on definition.id = version.game_definition_id
  join game_engine.game_modules module on module.id = definition.game_module_id
  join game_engine.game_module_versions module_version
    on module_version.game_module_id = module.id
   and module_version.version = version.product_configuration->>'engineVersion'
  join game_engine.draw_authority_assignments assignment
    on assignment.id = @draw_authority_assignment_id
  on conflict (draw_id) do nothing
  returning execution_manifest_id
), inserted_event as (
  insert into game_engine.durable_scheduler_events(
    event_id, draw_id, previous_state, scheduler_state, reason_code,
    owner_id, evidence_hash, occurred_at)
  select
    @materialized_event_id, runtime.draw_id, null, runtime.scheduler_state,
    'AUTHORITATIVE_SLOT_MATERIALIZED', 'durable-scheduler',
    @materialized_evidence_hash, runtime.materialized_at
  from inserted_runtime runtime
  on conflict (event_id) do nothing
)
select
  runtime.draw_id, runtime.product_id, runtime.product_version_id,
  runtime.product_code, runtime.schedule_version_id,
  @draw_authority_assignment_id, runtime.sales_open_at,
  runtime.cutoff_at, runtime.scheduled_execution_at,
  runtime.draw_identity_hash, @schedule_hash,
  runtime.public_draw_number, runtime.scheduler_state,
  runtime.recovery_deadline_at, runtime.materialized_at,
  runtime.authoritative_result_at, runtime.settlement_requested_at,
  runtime.wallet_available_at
from selected_runtime runtime;
""";
            AddSlotParameters(command, definition, slot, recoveryWindow);
            DurableScheduledDraw persisted;
            await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
            {
                if (!await reader.ReadAsync(cancellationToken))
                {
                    throw new InvalidOperationException("Durable scheduler failed to materialize or recover an authoritative slot.");
                }

                persisted = ReadDraw(reader);
            }
            draws.Add(persisted);
        }

        await transaction.CommitAsync(cancellationToken);
        return draws;
    }

    public async Task AdvanceTimeStatesAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "select game_engine.durable_scheduler_advance_time(@observed_at);";
        command.Parameters.AddWithValue("observed_at", now);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<IReadOnlyCollection<DurableScheduledDraw>> ListDueAsync(
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
{DrawSelect}
where (runtime.scheduler_state in ('ExecutionDue', 'RecoveryRequired')
    or (runtime.scheduler_state = 'Executing' and exists (
      select 1
      from game_engine.durable_scheduler_execution_leases lease
      where lease.draw_id = runtime.draw_id
        and lease.lease_expires_at <= @now)))
  and runtime.scheduled_execution_at <= @now
order by runtime.scheduled_execution_at, runtime.draw_id
limit @limit;
""";
        command.Parameters.AddWithValue("now", now);
        command.Parameters.AddWithValue("limit", limit);
        return await ReadDrawsAsync(command, cancellationToken);
    }

    public async Task<bool> HasFundedAcceptedWagersAsync(Guid drawId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select exists(
  select 1
  from ticket_authority.tickets ticket
  join public.credit_reservations reservation on reservation.id = ticket.reservation_id
  where ticket.draw_id = @draw_id
    and ticket.status in ('ACCEPTED', 'AWAITING_DRAW', 'CLOSED', 'SETTLEMENT_PENDING')
    and reservation.status in ('RESERVED', 'PARTIALLY_SETTLED')
);
""";
        command.Parameters.AddWithValue("draw_id", drawId);
        return await command.ExecuteScalarAsync(cancellationToken) is true;
    }

    public async Task<DurableSchedulerExecutionClaim> TryClaimExecutionAsync(
        Guid drawId,
        string ownerId,
        TimeSpan lease,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "select * from game_engine.claim_durable_scheduler_execution(@draw_id, @owner_id, @claimed_at, @lease);";
        command.Parameters.AddWithValue("draw_id", drawId);
        command.Parameters.AddWithValue("owner_id", ownerId);
        command.Parameters.AddWithValue("claimed_at", now);
        command.Parameters.AddWithValue("lease", lease);
        DurableSchedulerExecutionClaim result;
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            if (!await reader.ReadAsync(cancellationToken))
            {
                throw new InvalidOperationException("Durable scheduler claim returned no result.");
            }

            result = new DurableSchedulerExecutionClaim(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetString(2),
                Enum.Parse<DurableSchedulerClaimStatus>(reader.GetString(3), true),
                reader.GetFieldValue<DateTimeOffset>(4),
                reader.GetFieldValue<DateTimeOffset>(5),
                reader.GetInt32(6),
                reader.GetString(7));
        }
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

    public async Task RecordExecutionStateAsync(
        Guid drawId,
        DurableSchedulerDrawState state,
        string reasonCode,
        string evidenceHash,
        DateTimeOffset occurredAt,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "select game_engine.record_durable_scheduler_state(@draw_id, @state, @reason_code, @evidence_hash, @occurred_at);";
        command.Parameters.AddWithValue("draw_id", drawId);
        command.Parameters.AddWithValue("state", state.ToString());
        command.Parameters.AddWithValue("reason_code", reasonCode);
        command.Parameters.AddWithValue("evidence_hash", evidenceHash);
        command.Parameters.AddWithValue("occurred_at", occurredAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<DurableSchedulerOperationalStatus> GetOperationalStatusAsync(
        bool hostedRuntimeEnabled,
        bool productionExecutionEnabled,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var ready = await CheckReadinessAsync(cancellationToken);
        if (!ready)
        {
            return new DurableSchedulerOperationalStatus(
                false, false, hostedRuntimeEnabled, productionExecutionEnabled,
                0, 0, 0, 0, 0, TimeSpan.Zero, null, now,
                ["Durable scheduler PostgreSQL persistence is unavailable."]);
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select
  count(*)::integer,
  count(*) filter (where scheduler_state = 'Accepting')::integer,
  count(*) filter (where scheduler_state = 'ExecutionDue')::integer,
  count(*) filter (where scheduler_state = 'RecoveryRequired')::integer,
  count(*) filter (where scheduler_state in ('AuthoritativeResult', 'SettlementTriggered'))::integer,
  coalesce(extract(epoch from greatest(@now - min(scheduled_execution_at)
    filter (where scheduler_state = 'ExecutionDue'), interval '0 seconds')), 0)::double precision,
  extract(epoch from @now - min(authoritative_result_at)
    filter (where scheduler_state in ('AuthoritativeResult', 'SettlementTriggered')))
from game_engine.durable_scheduler_draws;
""";
        command.Parameters.AddWithValue("now", now);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);
        return new DurableSchedulerOperationalStatus(
            true,
            true,
            hostedRuntimeEnabled,
            productionExecutionEnabled,
            reader.GetInt32(0),
            reader.GetInt32(1),
            reader.GetInt32(2),
            reader.GetInt32(3),
            reader.GetInt32(4),
            TimeSpan.FromSeconds(reader.GetDouble(5)),
            reader.IsDBNull(6) ? null : TimeSpan.FromSeconds(reader.GetDouble(6)),
            now,
            productionExecutionEnabled ? [] : ["Production scheduler execution remains disabled."]);
    }

    public async Task<HotSpotQuickPickSelection?> FindQuickPickAsync(
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select selection_id, ticket_request_id, idempotency_key, spot_count,
  numbers, purpose_domain, product_version_hash, selection_hash, generated_at
from game_engine.hot_spot_quick_pick_selections
where idempotency_key = @idempotency_key;
""";
        command.Parameters.AddWithValue("idempotency_key", idempotencyKey);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadQuickPick(reader, duplicate: true) : null;
    }

    public async Task<HotSpotQuickPickSelection> PersistQuickPickAsync(
        HotSpotQuickPickSelection selection,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.hot_spot_quick_pick_selections(
  selection_id, ticket_request_id, idempotency_key, spot_count, numbers,
  purpose_domain, product_version_hash, selection_hash, generated_at)
values (
  @selection_id, @ticket_request_id, @idempotency_key, @spot_count, @numbers,
  @purpose_domain, @product_version_hash, @selection_hash, @generated_at)
on conflict (idempotency_key) do nothing;

select selection_id, ticket_request_id, idempotency_key, spot_count,
  numbers, purpose_domain, product_version_hash, selection_hash, generated_at
from game_engine.hot_spot_quick_pick_selections
where idempotency_key = @idempotency_key;
""";
        command.Parameters.AddWithValue("selection_id", selection.SelectionId);
        command.Parameters.AddWithValue("ticket_request_id", selection.TicketRequestId);
        command.Parameters.AddWithValue("idempotency_key", selection.IdempotencyKey);
        command.Parameters.AddWithValue("spot_count", selection.SpotCount);
        command.Parameters.AddWithValue("numbers", selection.Numbers.ToArray());
        command.Parameters.AddWithValue("purpose_domain", selection.PurposeDomain);
        command.Parameters.AddWithValue("product_version_hash", selection.ProductVersionHash);
        command.Parameters.AddWithValue("selection_hash", selection.SelectionHash);
        command.Parameters.AddWithValue("generated_at", selection.GeneratedAt);
        HotSpotQuickPickSelection persisted;
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            await reader.ReadAsync(cancellationToken);
            persisted = ReadQuickPick(reader, duplicate: false);
        }
        await transaction.CommitAsync(cancellationToken);
        if (persisted.TicketRequestId != selection.TicketRequestId || persisted.SpotCount != selection.SpotCount ||
            !string.Equals(persisted.ProductVersionHash, selection.ProductVersionHash, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Quick Pick idempotency payload conflict.");
        }
        return persisted;
    }

    public async Task<HotSpotBullseyeEvidence?> FindBullseyeAsync(Guid drawId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"{BullseyeSelect} where draw_id = @draw_id;";
        command.Parameters.AddWithValue("draw_id", drawId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadBullseye(reader, duplicate: true) : null;
    }

    public async Task<HotSpotBullseyeEvidence> PersistBullseyeAsync(
        HotSpotBullseyeEvidence evidence,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"""
insert into game_engine.hot_spot_bullseye_evidence(
  evidence_id, draw_id, execution_manifest_id, bullseye_number,
  purpose_domain, primary_result_hash, provider_configuration_hash,
  canonical_evidence_hash, generated_at)
values (
  @evidence_id, @draw_id, @execution_manifest_id, @bullseye_number,
  @purpose_domain, @primary_result_hash, @provider_configuration_hash,
  @canonical_evidence_hash, @generated_at)
on conflict (draw_id) do nothing;

{BullseyeSelect}
where draw_id = @draw_id;
""";
        command.Parameters.AddWithValue("evidence_id", evidence.EvidenceId);
        command.Parameters.AddWithValue("draw_id", evidence.DrawId);
        command.Parameters.AddWithValue("execution_manifest_id", evidence.ExecutionManifestId);
        command.Parameters.AddWithValue("bullseye_number", evidence.BullseyeNumber);
        command.Parameters.AddWithValue("purpose_domain", evidence.PurposeDomain);
        command.Parameters.AddWithValue("primary_result_hash", evidence.PrimaryResultHash);
        command.Parameters.AddWithValue("provider_configuration_hash", evidence.ProviderConfigurationHash);
        command.Parameters.AddWithValue("canonical_evidence_hash", evidence.CanonicalEvidenceHash);
        command.Parameters.AddWithValue("generated_at", evidence.GeneratedAt);
        HotSpotBullseyeEvidence persisted;
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            await reader.ReadAsync(cancellationToken);
            persisted = ReadBullseye(reader, duplicate: false);
        }
        await transaction.CommitAsync(cancellationToken);
        if (persisted.ExecutionManifestId != evidence.ExecutionManifestId ||
            !string.Equals(persisted.PrimaryResultHash, evidence.PrimaryResultHash, StringComparison.Ordinal) ||
            !string.Equals(persisted.ProviderConfigurationHash, evidence.ProviderConfigurationHash, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Bullseye immutable draw evidence conflicts with the retry request.");
        }
        return persisted;
    }

    public async Task<IReadOnlyCollection<DurableScheduledDraw>> ListNextAcceptingHotSpotDrawsAsync(
        Guid ticketId,
        DateTimeOffset after,
        int count,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
with accepted_ticket_draw as (
  select ticket.draw_id, accepted.scheduled_execution_at
  from ticket_authority.tickets ticket
  join game_engine.durable_scheduler_draws accepted on accepted.draw_id = ticket.draw_id
  where ticket.ticket_id = @ticket_id
    and accepted.product_code = 'HOT_SPOT_V1'
    and accepted.scheduler_state in ('Scheduled', 'Accepting')
    and accepted.cutoff_at > @after
)
{DrawSelect}
cross join accepted_ticket_draw accepted
where runtime.product_code = 'HOT_SPOT_V1'
  and runtime.scheduler_state in ('Scheduled', 'Accepting')
  and runtime.cutoff_at > @after
  and (runtime.draw_id = accepted.draw_id
    or runtime.scheduled_execution_at > accepted.scheduled_execution_at)
order by case when runtime.draw_id = accepted.draw_id then 0 else 1 end,
  runtime.scheduled_execution_at, runtime.draw_id
limit @count;
""";
        command.Parameters.AddWithValue("ticket_id", ticketId);
        command.Parameters.AddWithValue("after", after);
        command.Parameters.AddWithValue("count", count);
        return await ReadDrawsAsync(command, cancellationToken);
    }

    public async Task<HotSpotMultiDrawPlan?> FindMultiDrawPlanAsync(Guid purchaseId, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select purchase_id, ticket_id, draw_count, stake_per_draw_minor,
  total_reservation_minor, quick_pick_selection_id, canonical_plan_hash, created_at
from game_engine.hot_spot_multi_draw_purchases
where purchase_id = @purchase_id;
""";
        command.Parameters.AddWithValue("purchase_id", purchaseId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        var ticketId = reader.GetGuid(1);
        var drawCount = reader.GetInt32(2);
        var stake = reader.GetInt64(3);
        var total = reader.GetInt64(4);
        var quickPickId = reader.IsDBNull(5) ? (Guid?)null : reader.GetGuid(5);
        var hash = reader.GetString(6);
        var createdAt = reader.GetFieldValue<DateTimeOffset>(7);
        await reader.DisposeAsync();
        var quickPick = quickPickId is null ? null : await FindQuickPickByIdAsync(connection, quickPickId.Value, cancellationToken);
        var bindings = await ListBindingsAsync(connection, purchaseId, cancellationToken);
        return new HotSpotMultiDrawPlan(
            purchaseId, ticketId, drawCount, stake, total, quickPick, bindings, hash, Duplicate: true);
    }

    public async Task<HotSpotMultiDrawPlan> PersistMultiDrawPlanAsync(
        HotSpotMultiDrawPlan plan,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into game_engine.hot_spot_multi_draw_purchases(
  purchase_id, ticket_id, draw_count, stake_per_draw_minor,
  total_reservation_minor, quick_pick_selection_id, canonical_plan_hash, created_at)
values (
  @purchase_id, @ticket_id, @draw_count, @stake_per_draw_minor,
  @total_reservation_minor, @quick_pick_selection_id, @canonical_plan_hash, @created_at)
on conflict (purchase_id) do nothing;
""";
        command.Parameters.AddWithValue("purchase_id", plan.PurchaseId);
        command.Parameters.AddWithValue("ticket_id", plan.TicketId);
        command.Parameters.AddWithValue("draw_count", plan.DrawCount);
        command.Parameters.AddWithValue("stake_per_draw_minor", plan.StakePerDrawMinor);
        command.Parameters.AddWithValue("total_reservation_minor", plan.TotalReservationMinor);
        command.Parameters.AddWithValue("quick_pick_selection_id", (object?)plan.QuickPick?.SelectionId ?? DBNull.Value);
        command.Parameters.AddWithValue("canonical_plan_hash", plan.CanonicalPlanHash);
        command.Parameters.AddWithValue("created_at", plan.Bindings.Min(binding => binding.BoundAt));
        await command.ExecuteNonQueryAsync(cancellationToken);

        foreach (var binding in plan.Bindings)
        {
            await using var bindingCommand = connection.CreateCommand();
            bindingCommand.Transaction = transaction;
            bindingCommand.CommandText = """
insert into game_engine.hot_spot_multi_draw_bindings(
  binding_id, purchase_id, ticket_id, draw_id, sequence,
  public_draw_number, draw_identity_hash, binding_hash, bound_at)
values (
  @binding_id, @purchase_id, @ticket_id, @draw_id, @sequence,
  @public_draw_number, @draw_identity_hash, @binding_hash, @bound_at)
on conflict (purchase_id, sequence) do nothing;
""";
            bindingCommand.Parameters.AddWithValue("binding_id", binding.BindingId);
            bindingCommand.Parameters.AddWithValue("purchase_id", binding.PurchaseId);
            bindingCommand.Parameters.AddWithValue("ticket_id", binding.TicketId);
            bindingCommand.Parameters.AddWithValue("draw_id", binding.DrawId);
            bindingCommand.Parameters.AddWithValue("sequence", binding.Sequence);
            bindingCommand.Parameters.AddWithValue("public_draw_number", binding.PublicDrawNumber);
            bindingCommand.Parameters.AddWithValue("draw_identity_hash", binding.DrawIdentityHash);
            bindingCommand.Parameters.AddWithValue("binding_hash", binding.BindingHash);
            bindingCommand.Parameters.AddWithValue("bound_at", binding.BoundAt);
            await bindingCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var participationCommand = connection.CreateCommand())
        {
            participationCommand.Transaction = transaction;
            participationCommand.CommandText = """
with base_items as materialized (
  select item.ticket_item_id base_ticket_item_id, item.item_index,
    item.wager_type, item.wager_version, item.normalized_selections,
    item.stake_minor, item.created_at
  from ticket_authority.ticket_items item
  where item.ticket_id = @ticket_id
    and not exists (
      select 1 from game_engine.hot_spot_multi_draw_participations existing
      where existing.ticket_item_id = item.ticket_item_id
    )
    and item.item_index < 1000
), expanded as materialized (
  select binding.binding_id, binding.draw_id, binding.sequence,
    binding.bound_at, base.*
  from game_engine.hot_spot_multi_draw_bindings binding
  cross join base_items base
  where binding.purchase_id = @purchase_id
), inserted_items as (
  insert into ticket_authority.ticket_items(
    ticket_item_id, ticket_id, item_index, wager_type, wager_version,
    normalized_selections, stake_minor, item_hash, created_at)
  select gen_random_uuid(), @ticket_id,
    expanded.item_index + ((expanded.sequence - 1) * 1000),
    expanded.wager_type, expanded.wager_version, expanded.normalized_selections,
    expanded.stake_minor,
    ticket_authority.hash_json(jsonb_build_object(
      'ticketId', @ticket_id,
      'baseTicketItemId', expanded.base_ticket_item_id,
      'drawId', expanded.draw_id,
      'drawSequence', expanded.sequence,
      'wagerType', expanded.wager_type,
      'wagerVersion', expanded.wager_version,
      'selections', expanded.normalized_selections,
      'stakeMinor', expanded.stake_minor
    )), expanded.bound_at
  from expanded
  where expanded.sequence > 1
  on conflict (ticket_id, item_index) do nothing
  returning ticket_item_id, item_index
), participation_items as (
  select expanded.binding_id, expanded.draw_id, expanded.sequence,
    expanded.bound_at, expanded.base_ticket_item_id,
    expanded.base_ticket_item_id ticket_item_id, expanded.stake_minor
  from expanded where expanded.sequence = 1
  union all
  select expanded.binding_id, expanded.draw_id, expanded.sequence,
    expanded.bound_at, expanded.base_ticket_item_id,
    inserted.ticket_item_id, expanded.stake_minor
  from expanded
  join inserted_items inserted
    on inserted.item_index = expanded.item_index + ((expanded.sequence - 1) * 1000)
  where expanded.sequence > 1
)
insert into game_engine.hot_spot_multi_draw_participations(
  participation_id, purchase_id, binding_id, ticket_id, ticket_item_id,
  base_ticket_item_id, draw_id, draw_sequence, allocated_stake_minor,
  participation_hash, created_at)
select gen_random_uuid(), @purchase_id, item.binding_id, @ticket_id,
  item.ticket_item_id, item.base_ticket_item_id, item.draw_id, item.sequence,
  item.stake_minor,
  ticket_authority.hash_json(jsonb_build_object(
    'purchaseId', @purchase_id,
    'bindingId', item.binding_id,
    'ticketId', @ticket_id,
    'ticketItemId', item.ticket_item_id,
    'baseTicketItemId', item.base_ticket_item_id,
    'drawId', item.draw_id,
    'drawSequence', item.sequence,
    'allocatedStakeMinor', item.stake_minor
  )), item.bound_at
from participation_items item
on conflict (purchase_id, binding_id, base_ticket_item_id) do nothing;
""";
            participationCommand.Parameters.AddWithValue("purchase_id", plan.PurchaseId);
            participationCommand.Parameters.AddWithValue("ticket_id", plan.TicketId);
            await participationCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var validationCommand = connection.CreateCommand())
        {
            validationCommand.Transaction = transaction;
            validationCommand.CommandText = """
select
  (select count(*) from game_engine.hot_spot_multi_draw_bindings
    where purchase_id = @purchase_id),
  (select count(*) from game_engine.hot_spot_multi_draw_participations
    where purchase_id = @purchase_id),
  (select count(*) from ticket_authority.ticket_items
    where ticket_id = @ticket_id and item_index < 1000),
  (select coalesce(sum(allocated_stake_minor), 0)
    from game_engine.hot_spot_multi_draw_participations
    where purchase_id = @purchase_id),
  (select ticket.draw_id = binding.draw_id
    from ticket_authority.tickets ticket
    join game_engine.hot_spot_multi_draw_bindings binding
      on binding.purchase_id = @purchase_id and binding.sequence = 1
    where ticket.ticket_id = @ticket_id);
""";
            validationCommand.Parameters.AddWithValue("purchase_id", plan.PurchaseId);
            validationCommand.Parameters.AddWithValue("ticket_id", plan.TicketId);
            await using var reader = await validationCommand.ExecuteReaderAsync(cancellationToken);
            await reader.ReadAsync(cancellationToken);
            var bindingCount = reader.GetInt64(0);
            var participationCount = reader.GetInt64(1);
            var baseItemCount = reader.GetInt64(2);
            var allocatedTotal = reader.GetInt64(3);
            var startsAtAcceptedDraw = reader.GetBoolean(4);
            if (bindingCount != plan.DrawCount ||
                participationCount != plan.DrawCount * baseItemCount ||
                allocatedTotal != plan.TotalReservationMinor ||
                !startsAtAcceptedDraw)
            {
                throw new InvalidOperationException(
                    "Hot Spot multi-draw participation fanout did not preserve the exact reservation allocation.");
            }
        }

        await transaction.CommitAsync(cancellationToken);
        return await FindMultiDrawPlanAsync(plan.PurchaseId, cancellationToken)
            ?? throw new InvalidOperationException("Hot Spot multi-draw plan was not persisted.");
    }

    public async Task<HotSpotMultiDrawCancellationResult> CancelFutureParticipationsAsync(
        HotSpotMultiDrawCancellationRequest request,
        DateTimeOffset cancelledAt,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select game_engine.cancel_hot_spot_future_participations(
  @purchase_id, @idempotency_key, @reason_code, @requested_by,
  @correlation_id, @cancelled_at)::text;
""";
        command.Parameters.AddWithValue("purchase_id", request.PurchaseId);
        command.Parameters.AddWithValue("idempotency_key", request.IdempotencyKey.Trim());
        command.Parameters.AddWithValue("reason_code", request.ReasonCode.Trim());
        command.Parameters.AddWithValue("requested_by", request.RequestedBy.Trim());
        command.Parameters.AddWithValue("correlation_id", request.CorrelationId.Trim());
        command.Parameters.AddWithValue("cancelled_at", cancelledAt);
        var json = (string?)await command.ExecuteScalarAsync(cancellationToken)
            ?? throw new InvalidOperationException("Hot Spot future cancellation returned no evidence.");
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        return new HotSpotMultiDrawCancellationResult(
            root.GetProperty("cancellationId").GetGuid(),
            root.GetProperty("purchaseId").GetGuid(),
            root.GetProperty("cancelledParticipationCount").GetInt32(),
            root.GetProperty("releasedAmountMinor").GetInt64(),
            root.GetProperty("walletOperationId").GetGuid(),
            root.GetProperty("evidenceHash").GetString()!,
            root.GetProperty("cancelledAt").GetDateTimeOffset(),
            root.GetProperty("duplicate").GetBoolean());
    }

    private static void AddSlotParameters(
        NpgsqlCommand command,
        DurableSchedulerProductDefinition definition,
        AuthoritativeDrawSlot slot,
        TimeSpan recoveryWindow)
    {
        command.Parameters.AddWithValue("draw_id", slot.DrawId);
        command.Parameters.AddWithValue("product_id", slot.ProductId);
        command.Parameters.AddWithValue("product_version_id", slot.ProductVersionId);
        command.Parameters.AddWithValue("product_code", slot.ProductCode);
        command.Parameters.AddWithValue("schedule_version_id", slot.ScheduleVersionId);
        command.Parameters.AddWithValue("draw_authority_assignment_id", slot.DrawAuthorityAssignmentId);
        command.Parameters.AddWithValue("sales_open_at", slot.SalesOpenAt);
        command.Parameters.AddWithValue("cutoff_at", slot.CutoffAt);
        command.Parameters.AddWithValue("scheduled_execution_at", slot.ScheduledExecutionAt);
        command.Parameters.AddWithValue("schedule_hash", slot.ScheduleHash);
        command.Parameters.AddWithValue("draw_identity_hash", slot.DrawIdentityHash);
        command.Parameters.AddWithValue("recovery_deadline_at", slot.ScheduledExecutionAt.Add(recoveryWindow));
        command.Parameters.AddWithValue(
            "execution_manifest_id",
            AuthoritativeScheduleCalculator.StableGuid($"scheduler-execution-manifest|{slot.DrawId:N}"));
        command.Parameters.AddWithValue(
            "execution_manifest_hash",
            AuthoritativeScheduleCalculator.Hash(
                $"scheduler-execution-manifest:v1|{slot.DrawId:N}|{slot.ProductVersionId:N}|" +
                $"{slot.ScheduleVersionId:N}|{slot.DrawIdentityHash}"));
        command.Parameters.AddWithValue(
            "materialized_event_id",
            AuthoritativeScheduleCalculator.StableGuid($"scheduler-materialized|{slot.DrawId:N}"));
        command.Parameters.AddWithValue(
            "materialized_evidence_hash",
            AuthoritativeScheduleCalculator.Hash(
                $"scheduler-materialized:v1|{slot.DrawIdentityHash}|{definition.ProductVersionHash}|{slot.ScheduleHash}"));
    }

    private static async Task<IReadOnlyCollection<DurableScheduledDraw>> ReadDrawsAsync(
        NpgsqlCommand command,
        CancellationToken cancellationToken)
    {
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var draws = new List<DurableScheduledDraw>();
        while (await reader.ReadAsync(cancellationToken))
        {
            draws.Add(ReadDraw(reader));
        }
        return draws;
    }

    private static DurableScheduledDraw ReadDraw(NpgsqlDataReader reader)
    {
        var slot = new AuthoritativeDrawSlot(
            reader.GetGuid(0),
            reader.GetGuid(1),
            reader.GetGuid(2),
            reader.GetString(3),
            reader.GetGuid(4),
            reader.GetGuid(5),
            reader.GetFieldValue<DateTimeOffset>(6),
            reader.GetFieldValue<DateTimeOffset>(7),
            reader.GetFieldValue<DateTimeOffset>(8),
            reader.GetString(9),
            reader.GetString(10));
        return new DurableScheduledDraw(
            slot,
            reader.GetInt64(11),
            Enum.Parse<DurableSchedulerDrawState>(reader.GetString(12), true),
            reader.GetFieldValue<DateTimeOffset>(13),
            reader.GetFieldValue<DateTimeOffset>(14),
            reader.IsDBNull(15) ? null : reader.GetFieldValue<DateTimeOffset>(15),
            reader.IsDBNull(16) ? null : reader.GetFieldValue<DateTimeOffset>(16),
            reader.IsDBNull(17) ? null : reader.GetFieldValue<DateTimeOffset>(17));
    }

    private static HotSpotQuickPickSelection ReadQuickPick(NpgsqlDataReader reader, bool duplicate) => new(
        reader.GetGuid(0),
        reader.GetGuid(1),
        reader.GetString(2),
        reader.GetInt32(3),
        reader.GetFieldValue<int[]>(4),
        reader.GetString(5),
        reader.GetString(6),
        reader.GetString(7),
        reader.GetFieldValue<DateTimeOffset>(8),
        duplicate);

    private static HotSpotBullseyeEvidence ReadBullseye(NpgsqlDataReader reader, bool duplicate) => new(
        reader.GetGuid(0),
        reader.GetGuid(1),
        reader.GetGuid(2),
        reader.GetInt32(3),
        reader.GetString(4),
        reader.GetString(5),
        reader.GetString(6),
        reader.GetString(7),
        reader.GetFieldValue<DateTimeOffset>(8),
        duplicate);

    private static async Task<HotSpotQuickPickSelection?> FindQuickPickByIdAsync(
        NpgsqlConnection connection,
        Guid selectionId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select selection_id, ticket_request_id, idempotency_key, spot_count,
  numbers, purpose_domain, product_version_hash, selection_hash, generated_at
from game_engine.hot_spot_quick_pick_selections
where selection_id = @selection_id;
""";
        command.Parameters.AddWithValue("selection_id", selectionId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadQuickPick(reader, duplicate: true) : null;
    }

    private static async Task<IReadOnlyCollection<HotSpotMultiDrawBinding>> ListBindingsAsync(
        NpgsqlConnection connection,
        Guid purchaseId,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
select binding_id, purchase_id, ticket_id, draw_id, sequence,
  public_draw_number, draw_identity_hash, binding_hash, bound_at
from game_engine.hot_spot_multi_draw_bindings
where purchase_id = @purchase_id
order by sequence;
""";
        command.Parameters.AddWithValue("purchase_id", purchaseId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var bindings = new List<HotSpotMultiDrawBinding>();
        while (await reader.ReadAsync(cancellationToken))
        {
            bindings.Add(new HotSpotMultiDrawBinding(
                reader.GetGuid(0), reader.GetGuid(1), reader.GetGuid(2), reader.GetGuid(3),
                reader.GetInt32(4), reader.GetInt64(5), reader.GetString(6), reader.GetString(7),
                reader.GetFieldValue<DateTimeOffset>(8)));
        }
        return bindings;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private const string DrawSelect = """
select
  runtime.draw_id, runtime.product_id, runtime.product_version_id,
  runtime.product_code, runtime.schedule_version_id,
  schedule.draw_authority_assignment_id, runtime.sales_open_at,
  runtime.cutoff_at, runtime.scheduled_execution_at,
  runtime.draw_identity_hash, schedule.schedule_hash,
  runtime.public_draw_number, runtime.scheduler_state,
  runtime.recovery_deadline_at, runtime.materialized_at,
  runtime.authoritative_result_at, runtime.settlement_requested_at,
  runtime.wallet_available_at
from game_engine.durable_scheduler_draws runtime
join game_engine.draw_schedules schedule on schedule.id = runtime.draw_id
""";

    private const string BullseyeSelect = """
select evidence_id, draw_id, execution_manifest_id, bullseye_number,
  purpose_domain, primary_result_hash, provider_configuration_hash,
  canonical_evidence_hash, generated_at
from game_engine.hot_spot_bullseye_evidence
""";
}
