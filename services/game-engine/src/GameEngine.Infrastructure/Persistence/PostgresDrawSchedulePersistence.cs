using System.Security.Cryptography;
using System.Text;
using GameEngine.Application.Interfaces;
using GameEngine.Domain.Model;
using Npgsql;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresDrawScheduleRepository(string connectionString) : IDrawScheduleRepository
{
    public async Task<IReadOnlyCollection<DrawSchedule>> ListAsync(CancellationToken cancellationToken)
    {
        return await QueryManyAsync(string.Empty, null, cancellationToken);
    }

    public async Task<DrawSchedule?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return (await QueryManyAsync("where id = @id", command => command.Parameters.AddWithValue("id", id), cancellationToken))
            .FirstOrDefault();
    }

    public async Task<DrawSchedule> UpsertAsync(DrawSchedule schedule, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await EnsureSupportRowsAsync(connection, schedule, cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var scheduleHash = Hash(
            $"published-schedule:v1|{schedule.DrawAuthorityAssignmentId:N}|{schedule.GameDefinitionId:N}|" +
            $"{schedule.SalesCloseAt - schedule.SalesOpenAt}|{schedule.DrawAt - schedule.SalesCloseAt}");
        var scheduleVersionId = StableGuid(
            $"published-schedule-version:{schedule.DrawAuthorityAssignmentId:N}:{scheduleHash}");
        var drawIdentityHash = Hash(
            $"draw-instance:v1|{scheduleVersionId:N}|{schedule.DrawAt.UtcDateTime:O}");

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
select pg_advisory_xact_lock(hashtextextended('published-draw-schedule:' || @schedule_id::text, 0));

insert into game_engine.published_draw_schedule_versions (
  schedule_version_id, schedule_id, version_number, game_definition_id,
  draw_authority_assignment_id, schedule_kind, schedule_configuration,
  time_zone_id, schedule_hash, published_at
) values (
  @schedule_version_id,
  @schedule_id,
  (
    select coalesce(max(version_number), 0) + 1
    from game_engine.published_draw_schedule_versions
    where schedule_id = @schedule_id
  ),
  @game_definition_id,
  @draw_authority_assignment_id, 'CANONICAL_RUNTIME',
  jsonb_build_object(
    'salesOpenDuration', @sales_open_duration,
    'salesCloseToDrawDuration', @sales_close_to_draw_duration),
  'UTC', @schedule_hash, @published_at
)
on conflict (schedule_id, schedule_hash) do nothing;

insert into game_engine.draw_schedules (
  id,
  game_definition_id,
  draw_authority_assignment_id,
  sales_open_at,
  sales_close_at,
  draw_at,
  status,
  schedule_version_id,
  scheduled_execution_at,
  schedule_hash,
  draw_identity_hash
) values (
  @id,
  @game_definition_id,
  @draw_authority_assignment_id,
  @sales_open_at,
  @sales_close_at,
  @draw_at,
  @status,
  @schedule_version_id,
  @draw_at,
  @schedule_hash,
  @draw_identity_hash
)
on conflict (id) do nothing;

update game_engine.draw_schedules
set status = @status
where id = @id
  and status <> @status;

insert into game_engine.draw_execution_manifests (
  execution_manifest_id, draw_id, schedule_version_id,
  game_definition_version_id, draw_authority_version_id,
  engine_name, engine_version, outcome_provider_id, outcome_provider_version,
  provider_configuration_version, evaluator_version, paytable_version, scheduled_execution_at,
  schedule_hash, draw_identity_hash, canonical_manifest_hash, created_at)
select
  @execution_manifest_id, draw.id, draw.schedule_version_id,
  definition_version.id, assignment.draw_authority_version_id,
  module.code, module_version.version, authority.code, authority_version.provider_version,
  '1', definition_version.evaluator_version, definition_version.paytable_version,
  draw.scheduled_execution_at, draw.schedule_hash, draw.draw_identity_hash,
  @execution_manifest_hash, @published_at
from game_engine.draw_schedules draw
join game_engine.game_definitions definition on definition.id = draw.game_definition_id
join game_engine.game_modules module on module.id = definition.game_module_id
join game_engine.game_module_versions module_version on module_version.id = module.active_version_id
join game_engine.game_definition_versions definition_version on definition_version.id = definition.active_version_id
join game_engine.draw_authority_assignments assignment on assignment.id = draw.draw_authority_assignment_id
join game_engine.draw_authority_versions authority_version on authority_version.id = assignment.draw_authority_version_id
join game_engine.draw_authorities authority on authority.id = assignment.draw_authority_id
where draw.id = @id
on conflict (draw_id) do nothing;
""";
        command.Parameters.AddWithValue("id", schedule.Id);
        command.Parameters.AddWithValue("schedule_version_id", scheduleVersionId);
        command.Parameters.AddWithValue("schedule_id", schedule.DrawAuthorityAssignmentId);
        command.Parameters.AddWithValue("game_definition_id", schedule.GameDefinitionId);
        command.Parameters.AddWithValue("draw_authority_assignment_id", schedule.DrawAuthorityAssignmentId);
        command.Parameters.AddWithValue("sales_open_at", schedule.SalesOpenAt);
        command.Parameters.AddWithValue("sales_close_at", schedule.SalesCloseAt);
        command.Parameters.AddWithValue("draw_at", schedule.DrawAt);
        command.Parameters.AddWithValue("status", schedule.Status.ToString());
        command.Parameters.AddWithValue("sales_open_duration", (schedule.SalesCloseAt - schedule.SalesOpenAt).ToString());
        command.Parameters.AddWithValue("sales_close_to_draw_duration", (schedule.DrawAt - schedule.SalesCloseAt).ToString());
        command.Parameters.AddWithValue("schedule_hash", scheduleHash);
        command.Parameters.AddWithValue("draw_identity_hash", drawIdentityHash);
        command.Parameters.AddWithValue("published_at", schedule.SalesOpenAt);
        command.Parameters.AddWithValue("execution_manifest_id", StableGuid($"execution-manifest:{schedule.Id:N}"));
        command.Parameters.AddWithValue(
            "execution_manifest_hash",
            Hash($"execution-manifest:v1|{schedule.Id:N}|{scheduleVersionId:N}|1|{drawIdentityHash}"));
        await command.ExecuteNonQueryAsync(cancellationToken);

        await using var verify = connection.CreateCommand();
        verify.Transaction = transaction;
        verify.CommandText = """
select
  game_definition_id,
  draw_authority_assignment_id,
  sales_open_at,
  sales_close_at,
  draw_at
from game_engine.draw_schedules
where id = @id;
""";
        verify.Parameters.AddWithValue("id", schedule.Id);
        await using (var reader = await verify.ExecuteReaderAsync(cancellationToken))
        {
            if (!await reader.ReadAsync(cancellationToken))
            {
                throw new InvalidOperationException(
                    $"Draw Instance {schedule.Id} was not persisted.");
            }

            if (reader.GetGuid(0) != schedule.GameDefinitionId ||
                reader.GetGuid(1) != schedule.DrawAuthorityAssignmentId ||
                reader.GetFieldValue<DateTimeOffset>(2) != schedule.SalesOpenAt ||
                reader.GetFieldValue<DateTimeOffset>(3) != schedule.SalesCloseAt ||
                reader.GetFieldValue<DateTimeOffset>(4) != schedule.DrawAt)
            {
                throw new InvalidOperationException(
                    $"Conflicting immutable Draw Instance identity for {schedule.Id}. " +
                    $"Persisted={reader.GetGuid(0)}/{reader.GetGuid(1)}/" +
                    $"{reader.GetFieldValue<DateTimeOffset>(2):O}/" +
                    $"{reader.GetFieldValue<DateTimeOffset>(3):O}/" +
                    $"{reader.GetFieldValue<DateTimeOffset>(4):O}; " +
                    $"Requested={schedule.GameDefinitionId}/{schedule.DrawAuthorityAssignmentId}/" +
                    $"{schedule.SalesOpenAt:O}/{schedule.SalesCloseAt:O}/{schedule.DrawAt:O}.");
            }
        }

        await transaction.CommitAsync(cancellationToken);
        return await GetAsync(schedule.Id, cancellationToken) ?? schedule;
    }

    private async Task<IReadOnlyCollection<DrawSchedule>> QueryManyAsync(
        string whereClause,
        Action<NpgsqlCommand>? configure,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
select id, game_definition_id, draw_authority_assignment_id, sales_open_at, sales_close_at, draw_at, status
from game_engine.draw_schedules
{whereClause}
order by draw_at, id;
""";
        configure?.Invoke(command);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var schedules = new List<DrawSchedule>();
        while (await reader.ReadAsync(cancellationToken))
        {
            schedules.Add(new DrawSchedule(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetGuid(2),
                reader.GetFieldValue<DateTimeOffset>(3),
                reader.GetFieldValue<DateTimeOffset>(4),
                reader.GetFieldValue<DateTimeOffset>(5),
                Enum.Parse<DrawLifecycleStatus>(reader.GetString(6), ignoreCase: true)));
        }

        return schedules;
    }

    private async Task EnsureSupportRowsAsync(NpgsqlConnection connection, DrawSchedule schedule, CancellationToken cancellationToken)
    {
        var moduleId = StableGuid("scheduler-persistence-module");
        var moduleVersionId = StableGuid("scheduler-persistence-module:1");
        var gameDefinitionVersionId = StableGuid($"scheduler-game-definition-version:{schedule.GameDefinitionId:N}");
        var drawAuthorityId = StableGuid($"scheduler-draw-authority:{schedule.DrawAuthorityAssignmentId:N}");
        var drawAuthorityVersionId = StableGuid($"scheduler-draw-authority-version:{schedule.DrawAuthorityAssignmentId:N}");

        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.game_modules (id, code, display_name, lifecycle_status, active_version_id, created_at)
values (@module_id, @module_code, 'Scheduler Persistence Module', 'ACTIVE', @module_version_id, @created_at)
on conflict (id) do nothing;

insert into game_engine.game_module_versions (id, game_module_id, version, sdk_version, manifest_hash, lifecycle_status, created_at)
values (@module_version_id, @module_id, '1', 'scheduler', @module_version_hash, 'ACTIVE', @created_at)
on conflict (game_module_id, version) do nothing;

insert into game_engine.game_definitions (id, code, display_name, active_version_id, game_module_id, created_at)
values (@game_definition_id, @game_definition_code, 'Scheduler Persistence Definition', @game_definition_version_id, @module_id, @created_at)
on conflict (id) do nothing;

insert into game_engine.game_definition_versions (
  id,
  game_definition_id,
  version_number,
  definition_hash,
  paytable_version,
  evaluator_version,
  draw_generator_version,
  effective_from
) values (
  @game_definition_version_id,
  @game_definition_id,
  1,
  @game_definition_hash,
  'scheduler',
  'scheduler',
  'scheduler',
  @created_at
)
on conflict (game_definition_id, version_number) do nothing;

insert into game_engine.draw_authorities (id, code, display_name, provider_type, status, active_version_id, created_at)
values (@draw_authority_id, @draw_authority_code, 'Scheduler Persistence Authority', 'ManualCertifiedEntry', 'Testing', @draw_authority_version_id, @created_at)
on conflict (id) do nothing;

insert into game_engine.draw_authority_versions (id, draw_authority_id, version, provider_version, configuration_hash, status, created_at)
values (@draw_authority_version_id, @draw_authority_id, '1', 'scheduler', @draw_authority_version_hash, 'Testing', @created_at)
on conflict (draw_authority_id, version) do nothing;

insert into game_engine.draw_authority_assignments (
  id,
  game_definition_id,
  draw_authority_id,
  draw_authority_version_id,
  settlement_trigger_policy,
  effective_from
) values (
  @draw_authority_assignment_id,
  @game_definition_id,
  @draw_authority_id,
  @draw_authority_version_id,
  'Manual',
  @created_at
)
on conflict (id) do nothing;

insert into game_engine.outcome_provider_definitions (
  id,
  provider_id,
  provider_version,
  provider_type,
  lifecycle_state,
  production_eligible,
  supported_outcome_primitive_types,
  evidence_requirements,
  health_readiness_capabilities,
  idempotency_model,
  custody_support,
  signing_requirements,
  replayability_support,
  failure_mode,
  capability_markers,
  content_hash,
  canonical_provider_category)
values (
  @outcome_provider_definition_id,
  @draw_authority_code,
  'scheduler',
  'EXTERNAL_OFFICIAL_RESULT',
  'Draft',
  false,
  '["UniqueNumberSet","OrderedNumberSequence","UniqueSymbolSet","OrderedSymbolSequence","CompositeOutcomeGraph","ConstraintValidation"]'::jsonb,
  '{"providerResultHash":true,"operatorCertificationEvidence":true}'::jsonb,
  '["immutable-configuration","durable-evidence"]'::jsonb,
  'PerExternalResult',
  '["Requested","Ingested","Sealed","Certified","Disputed"]'::jsonb,
  '{"signatureRequired":true,"dualApprovalRequired":true}'::jsonb,
  true,
  'FailClosed',
  '{"generatesOutcomes":false,"ingestsExternalOutcomes":true,"supportsPlayerVerificationReceipt":false,"supportsDeterministicReplay":true,"supportsProviderHealthEvidence":true,"supportsDisputeHandling":true,"supportsExternalSourceEvidence":true,"supportsPhysicalDrawEvidence":false}'::jsonb,
  @outcome_provider_content_hash,
  'MANUAL_CERTIFIED')
on conflict (provider_id, provider_version) do nothing;

insert into game_engine.outcome_provider_configuration_versions (
  provider_id,
  provider_version,
  configuration_version,
  canonical_provider_category,
  configuration_hash,
  supported_capabilities,
  evidence_requirements,
  readiness_capabilities,
  production_ready,
  failure_mode)
values (
  @draw_authority_code,
  'scheduler',
  '1',
  'MANUAL_CERTIFIED',
  @outcome_provider_configuration_hash,
  '["UniqueNumberSet","OrderedNumberSequence","UniqueSymbolSet","OrderedSymbolSequence","CompositeOutcomeGraph","ConstraintValidation"]'::jsonb,
  '{"providerResultHash":true,"operatorCertificationEvidence":true}'::jsonb,
  '["immutable-configuration","durable-evidence"]'::jsonb,
  false,
  'FAIL_CLOSED')
on conflict (provider_id, provider_version, configuration_version) do nothing;
""";
        command.Parameters.AddWithValue("module_id", moduleId);
        command.Parameters.AddWithValue("module_code", $"scheduler-module-{moduleId:N}");
        command.Parameters.AddWithValue("module_version_id", moduleVersionId);
        command.Parameters.AddWithValue("module_version_hash", moduleVersionId.ToString("N"));
        command.Parameters.AddWithValue("game_definition_id", schedule.GameDefinitionId);
        command.Parameters.AddWithValue("game_definition_code", $"scheduler-game-{schedule.GameDefinitionId:N}");
        command.Parameters.AddWithValue("game_definition_version_id", gameDefinitionVersionId);
        command.Parameters.AddWithValue("game_definition_hash", gameDefinitionVersionId.ToString("N"));
        command.Parameters.AddWithValue("draw_authority_id", drawAuthorityId);
        command.Parameters.AddWithValue("draw_authority_code", $"scheduler-authority-{drawAuthorityId:N}");
        command.Parameters.AddWithValue("draw_authority_version_id", drawAuthorityVersionId);
        command.Parameters.AddWithValue("draw_authority_version_hash", drawAuthorityVersionId.ToString("N"));
        command.Parameters.AddWithValue("draw_authority_assignment_id", schedule.DrawAuthorityAssignmentId);
        command.Parameters.AddWithValue(
            "outcome_provider_definition_id",
            StableGuid($"canonical-outcome-provider:{drawAuthorityId:N}"));
        command.Parameters.AddWithValue(
            "outcome_provider_content_hash",
            Hash($"canonical-outcome-provider:v1:{drawAuthorityId:N}"));
        command.Parameters.AddWithValue(
            "outcome_provider_configuration_hash",
            Hash($"canonical-outcome-provider-configuration:v1:{drawAuthorityId:N}:1"));
        command.Parameters.AddWithValue("created_at", schedule.SalesOpenAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static Guid StableGuid(string value)
    {
        var bytes = MD5.HashData(Encoding.UTF8.GetBytes(value));
        return new Guid(bytes);
    }

    private static string Hash(string value)
    {
        return $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()}";
    }
}
