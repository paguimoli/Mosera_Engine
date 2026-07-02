using GameEngine.Application.Interfaces;
using GameEngine.Domain.Model;
using Npgsql;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresGameModuleRepository(string connectionString) : IGameModuleRepository
{
    public async Task<IReadOnlyCollection<GameModule>> ListAsync(CancellationToken cancellationToken)
    {
        return await QueryManyAsync(string.Empty, null, cancellationToken);
    }

    public async Task<GameModule?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return (await QueryManyAsync("where id = @id", command => command.Parameters.AddWithValue("id", id), cancellationToken))
            .FirstOrDefault();
    }

    public async Task<GameModule> UpsertAsync(GameModule module, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.game_modules (
  id,
  code,
  display_name,
  lifecycle_status,
  active_version_id
) values (
  @id,
  @code,
  @display_name,
  @lifecycle_status,
  @active_version_id
)
on conflict (code) do update set
  code = excluded.code,
  display_name = excluded.display_name,
  lifecycle_status = excluded.lifecycle_status,
  active_version_id = excluded.active_version_id;
""";
        command.Parameters.AddWithValue("id", module.Id);
        command.Parameters.AddWithValue("code", module.Code);
        command.Parameters.AddWithValue("display_name", module.DisplayName);
        command.Parameters.AddWithValue("lifecycle_status", CatalogLifecycleStatus.ToDatabase(module.LifecycleStatus));
        command.Parameters.AddWithValue("active_version_id", module.ActiveVersionId);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return await GetAsync(module.Id, cancellationToken)
            ?? (await QueryManyAsync("where code = @code", command => command.Parameters.AddWithValue("code", module.Code), cancellationToken)).FirstOrDefault()
            ?? module;
    }

    private async Task<IReadOnlyCollection<GameModule>> QueryManyAsync(
        string whereClause,
        Action<NpgsqlCommand>? configure,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
select id, code, display_name, lifecycle_status, active_version_id
from game_engine.game_modules
{whereClause}
order by code, id;
""";
        configure?.Invoke(command);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var modules = new List<GameModule>();
        while (await reader.ReadAsync(cancellationToken))
        {
            modules.Add(new GameModule(
                reader.GetGuid(0),
                reader.GetString(1),
                reader.GetString(2),
                CatalogLifecycleStatus.FromDatabase(reader.GetString(3)),
                reader.GetGuid(4)));
        }

        return modules;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}

public sealed class PostgresGameModuleVersionRepository(string connectionString) : IGameModuleVersionRepository
{
    public async Task<IReadOnlyCollection<GameModuleVersion>> ListAsync(Guid gameModuleId, CancellationToken cancellationToken)
    {
        return await QueryManyAsync("where game_module_id = @game_module_id", command => command.Parameters.AddWithValue("game_module_id", gameModuleId), cancellationToken);
    }

    public async Task<GameModuleVersion?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return (await QueryManyAsync("where id = @id", command => command.Parameters.AddWithValue("id", id), cancellationToken))
            .FirstOrDefault();
    }

    public async Task<GameModuleVersion> UpsertAsync(GameModuleVersion version, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.game_module_versions (
  id,
  game_module_id,
  version,
  sdk_version,
  manifest_hash,
  lifecycle_status,
  created_at
) values (
  @id,
  @game_module_id,
  @version,
  @sdk_version,
  @manifest_hash,
  @lifecycle_status,
  @created_at
)
on conflict (game_module_id, version) do update set
  sdk_version = excluded.sdk_version,
  manifest_hash = excluded.manifest_hash,
  lifecycle_status = excluded.lifecycle_status;
""";
        command.Parameters.AddWithValue("id", version.Id);
        command.Parameters.AddWithValue("game_module_id", version.GameModuleId);
        command.Parameters.AddWithValue("version", version.Version);
        command.Parameters.AddWithValue("sdk_version", version.SdkVersion);
        command.Parameters.AddWithValue("manifest_hash", version.ManifestHash);
        command.Parameters.AddWithValue("lifecycle_status", CatalogLifecycleStatus.ToDatabase(version.LifecycleStatus));
        command.Parameters.AddWithValue("created_at", version.CreatedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return await GetAsync(version.Id, cancellationToken) ?? version;
    }

    private async Task<IReadOnlyCollection<GameModuleVersion>> QueryManyAsync(
        string whereClause,
        Action<NpgsqlCommand>? configure,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
select id, game_module_id, version, sdk_version, manifest_hash, lifecycle_status, created_at
from game_engine.game_module_versions
{whereClause}
order by game_module_id, version, id;
""";
        configure?.Invoke(command);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var versions = new List<GameModuleVersion>();
        while (await reader.ReadAsync(cancellationToken))
        {
            versions.Add(new GameModuleVersion(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                CatalogLifecycleStatus.FromDatabase(reader.GetString(5)),
                reader.GetFieldValue<DateTimeOffset>(6)));
        }

        return versions;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}

public sealed class PostgresGameDefinitionRepository(string connectionString) : IGameDefinitionRepository
{
    public async Task<IReadOnlyCollection<GameDefinition>> ListAsync(CancellationToken cancellationToken)
    {
        return await QueryManyAsync(string.Empty, null, cancellationToken);
    }

    public async Task<GameDefinition?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return (await QueryManyAsync("where id = @id", command => command.Parameters.AddWithValue("id", id), cancellationToken))
            .FirstOrDefault();
    }

    public async Task<GameDefinition> UpsertAsync(GameDefinition definition, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.game_definitions (
  id,
  code,
  display_name,
  active_version_id,
  game_module_id,
  created_at
) values (
  @id,
  @code,
  @display_name,
  @active_version_id,
  @game_module_id,
  @created_at
)
on conflict (code) do update set
  code = excluded.code,
  display_name = excluded.display_name,
  active_version_id = excluded.active_version_id,
  game_module_id = excluded.game_module_id;
""";
        command.Parameters.AddWithValue("id", definition.Id);
        command.Parameters.AddWithValue("code", definition.Code);
        command.Parameters.AddWithValue("display_name", definition.DisplayName);
        command.Parameters.AddWithValue("active_version_id", definition.ActiveVersionId);
        command.Parameters.AddWithValue("game_module_id", definition.GameModuleId);
        command.Parameters.AddWithValue("created_at", definition.CreatedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return await GetAsync(definition.Id, cancellationToken)
            ?? (await QueryManyAsync("where code = @code", command => command.Parameters.AddWithValue("code", definition.Code), cancellationToken)).FirstOrDefault()
            ?? definition;
    }

    private async Task<IReadOnlyCollection<GameDefinition>> QueryManyAsync(
        string whereClause,
        Action<NpgsqlCommand>? configure,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
select id, code, display_name, active_version_id, game_module_id, created_at
from game_engine.game_definitions
{whereClause}
order by code, id;
""";
        configure?.Invoke(command);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var definitions = new List<GameDefinition>();
        while (await reader.ReadAsync(cancellationToken))
        {
            definitions.Add(new GameDefinition(
                reader.GetGuid(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetGuid(3),
                reader.GetGuid(4),
                reader.GetFieldValue<DateTimeOffset>(5)));
        }

        return definitions;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}

public sealed class PostgresGameDefinitionVersionRepository(string connectionString) : IGameDefinitionVersionRepository
{
    public async Task<IReadOnlyCollection<GameDefinitionVersion>> ListAsync(Guid gameDefinitionId, CancellationToken cancellationToken)
    {
        return await QueryManyAsync("where game_definition_id = @game_definition_id", command => command.Parameters.AddWithValue("game_definition_id", gameDefinitionId), cancellationToken);
    }

    public async Task<GameDefinitionVersion?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return (await QueryManyAsync("where id = @id", command => command.Parameters.AddWithValue("id", id), cancellationToken))
            .FirstOrDefault();
    }

    public async Task<GameDefinitionVersion> UpsertAsync(GameDefinitionVersion version, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.game_definition_versions (
  id,
  game_definition_id,
  version_number,
  definition_hash,
  paytable_version,
  evaluator_version,
  draw_generator_version,
  effective_from,
  effective_to
) values (
  @id,
  @game_definition_id,
  @version_number,
  @definition_hash,
  @paytable_version,
  @evaluator_version,
  @draw_generator_version,
  @effective_from,
  @effective_to
)
on conflict (game_definition_id, version_number) do update set
  definition_hash = excluded.definition_hash,
  paytable_version = excluded.paytable_version,
  evaluator_version = excluded.evaluator_version,
  draw_generator_version = excluded.draw_generator_version,
  effective_from = excluded.effective_from,
  effective_to = excluded.effective_to;
""";
        command.Parameters.AddWithValue("id", version.Id);
        command.Parameters.AddWithValue("game_definition_id", version.GameDefinitionId);
        command.Parameters.AddWithValue("version_number", version.VersionNumber);
        command.Parameters.AddWithValue("definition_hash", version.DefinitionHash);
        command.Parameters.AddWithValue("paytable_version", version.PaytableVersion);
        command.Parameters.AddWithValue("evaluator_version", version.EvaluatorVersion);
        command.Parameters.AddWithValue("draw_generator_version", version.DrawGeneratorVersion);
        command.Parameters.AddWithValue("effective_from", version.EffectiveFrom);
        command.Parameters.AddWithValue("effective_to", version.EffectiveTo is null ? DBNull.Value : version.EffectiveTo.Value);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return await GetAsync(version.Id, cancellationToken) ?? version;
    }

    private async Task<IReadOnlyCollection<GameDefinitionVersion>> QueryManyAsync(
        string whereClause,
        Action<NpgsqlCommand>? configure,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
select id, game_definition_id, version_number, definition_hash, paytable_version, evaluator_version, draw_generator_version, effective_from, effective_to
from game_engine.game_definition_versions
{whereClause}
order by game_definition_id, version_number, id;
""";
        configure?.Invoke(command);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var versions = new List<GameDefinitionVersion>();
        while (await reader.ReadAsync(cancellationToken))
        {
            versions.Add(new GameDefinitionVersion(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetInt32(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetString(5),
                reader.GetString(6),
                reader.GetFieldValue<DateTimeOffset>(7),
                reader.IsDBNull(8) ? null : reader.GetFieldValue<DateTimeOffset>(8)));
        }

        return versions;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}

internal static class CatalogLifecycleStatus
{
    public static string ToDatabase(GameModuleLifecycleStatus status)
    {
        return status switch
        {
            GameModuleLifecycleStatus.ProductionActive or GameModuleLifecycleStatus.Approved => "ACTIVE",
            GameModuleLifecycleStatus.Retired => "RETIRED",
            GameModuleLifecycleStatus.InternalTesting or GameModuleLifecycleStatus.QaCertified => "DRAFT",
            _ => "DISABLED"
        };
    }

    public static GameModuleLifecycleStatus FromDatabase(string status)
    {
        return status switch
        {
            "ACTIVE" => GameModuleLifecycleStatus.ProductionActive,
            "RETIRED" => GameModuleLifecycleStatus.Retired,
            "DRAFT" => GameModuleLifecycleStatus.InternalTesting,
            "DISABLED" => GameModuleLifecycleStatus.Development,
            _ when Enum.TryParse<GameModuleLifecycleStatus>(status, ignoreCase: true, out var parsed) => parsed,
            _ => GameModuleLifecycleStatus.Development
        };
    }
}
