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

        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.draw_schedules (
  id,
  game_definition_id,
  draw_authority_assignment_id,
  sales_open_at,
  sales_close_at,
  draw_at,
  status
) values (
  @id,
  @game_definition_id,
  @draw_authority_assignment_id,
  @sales_open_at,
  @sales_close_at,
  @draw_at,
  @status
)
on conflict (id) do update set
  game_definition_id = excluded.game_definition_id,
  draw_authority_assignment_id = excluded.draw_authority_assignment_id,
  sales_open_at = excluded.sales_open_at,
  sales_close_at = excluded.sales_close_at,
  draw_at = excluded.draw_at,
  status = excluded.status;
""";
        command.Parameters.AddWithValue("id", schedule.Id);
        command.Parameters.AddWithValue("game_definition_id", schedule.GameDefinitionId);
        command.Parameters.AddWithValue("draw_authority_assignment_id", schedule.DrawAuthorityAssignmentId);
        command.Parameters.AddWithValue("sales_open_at", schedule.SalesOpenAt);
        command.Parameters.AddWithValue("sales_close_at", schedule.SalesCloseAt);
        command.Parameters.AddWithValue("draw_at", schedule.DrawAt);
        command.Parameters.AddWithValue("status", schedule.Status.ToString());
        await command.ExecuteNonQueryAsync(cancellationToken);
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
}
