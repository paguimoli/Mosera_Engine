using GameEngine.Application.Interfaces;
using GameEngine.Domain.Model;
using Npgsql;

namespace GameEngine.Infrastructure.Persistence;

public sealed class PostgresDrawAuthorityRepository(string connectionString) : IDrawAuthorityRepository
{
    public async Task<IReadOnlyCollection<DrawAuthority>> ListAsync(CancellationToken cancellationToken)
    {
        return await QueryManyAsync(string.Empty, null, cancellationToken);
    }

    public async Task<DrawAuthority?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return (await QueryManyAsync("where id = @id", command => command.Parameters.AddWithValue("id", id), cancellationToken))
            .FirstOrDefault();
    }

    public async Task<DrawAuthority> UpsertAsync(DrawAuthority authority, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.draw_authorities (
  id,
  code,
  display_name,
  provider_type,
  status,
  active_version_id
) values (
  @id,
  @code,
  @display_name,
  @provider_type,
  @status,
  @active_version_id
)
on conflict (code) do update set
  display_name = excluded.display_name,
  provider_type = excluded.provider_type,
  status = excluded.status,
  active_version_id = excluded.active_version_id;
""";
        command.Parameters.AddWithValue("id", authority.Id);
        command.Parameters.AddWithValue("code", authority.Code);
        command.Parameters.AddWithValue("display_name", authority.DisplayName);
        command.Parameters.AddWithValue("provider_type", authority.ProviderType.ToString());
        command.Parameters.AddWithValue("status", authority.Status.ToString());
        command.Parameters.AddWithValue("active_version_id", authority.ActiveVersionId);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return await GetAsync(authority.Id, cancellationToken)
            ?? (await QueryManyAsync("where code = @code", command => command.Parameters.AddWithValue("code", authority.Code), cancellationToken)).FirstOrDefault()
            ?? authority;
    }

    private async Task<IReadOnlyCollection<DrawAuthority>> QueryManyAsync(
        string whereClause,
        Action<NpgsqlCommand>? configure,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
select id, code, display_name, provider_type, status, active_version_id
from game_engine.draw_authorities
{whereClause}
order by code, id;
""";
        configure?.Invoke(command);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var authorities = new List<DrawAuthority>();
        while (await reader.ReadAsync(cancellationToken))
        {
            authorities.Add(new DrawAuthority(
                reader.GetGuid(0),
                reader.GetString(1),
                reader.GetString(2),
                Enum.Parse<DrawProviderType>(reader.GetString(3), ignoreCase: true),
                Enum.Parse<DrawAuthorityStatus>(reader.GetString(4), ignoreCase: true),
                reader.GetGuid(5)));
        }

        return authorities;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}

public sealed class PostgresDrawAuthorityVersionRepository(string connectionString) : IDrawAuthorityVersionRepository
{
    public async Task<IReadOnlyCollection<DrawAuthorityVersion>> ListAsync(Guid drawAuthorityId, CancellationToken cancellationToken)
    {
        return await QueryManyAsync("where draw_authority_id = @draw_authority_id", command => command.Parameters.AddWithValue("draw_authority_id", drawAuthorityId), cancellationToken);
    }

    public async Task<DrawAuthorityVersion?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return (await QueryManyAsync("where id = @id", command => command.Parameters.AddWithValue("id", id), cancellationToken))
            .FirstOrDefault();
    }

    public async Task<DrawAuthorityVersion> UpsertAsync(DrawAuthorityVersion version, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.draw_authority_versions (
  id,
  draw_authority_id,
  version,
  provider_version,
  configuration_hash,
  status,
  created_at
) values (
  @id,
  @draw_authority_id,
  @version,
  @provider_version,
  @configuration_hash,
  @status,
  @created_at
)
on conflict (draw_authority_id, version) do update set
  provider_version = excluded.provider_version,
  configuration_hash = excluded.configuration_hash,
  status = excluded.status;
""";
        command.Parameters.AddWithValue("id", version.Id);
        command.Parameters.AddWithValue("draw_authority_id", version.DrawAuthorityId);
        command.Parameters.AddWithValue("version", version.Version);
        command.Parameters.AddWithValue("provider_version", version.ProviderVersion);
        command.Parameters.AddWithValue("configuration_hash", version.ConfigurationHash);
        command.Parameters.AddWithValue("status", version.Status.ToString());
        command.Parameters.AddWithValue("created_at", version.CreatedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return await GetAsync(version.Id, cancellationToken)
            ?? (await QueryManyAsync(
                "where draw_authority_id = @draw_authority_id and version = @version",
                command =>
                {
                    command.Parameters.AddWithValue("draw_authority_id", version.DrawAuthorityId);
                    command.Parameters.AddWithValue("version", version.Version);
                },
                cancellationToken)).FirstOrDefault()
            ?? version;
    }

    private async Task<IReadOnlyCollection<DrawAuthorityVersion>> QueryManyAsync(
        string whereClause,
        Action<NpgsqlCommand>? configure,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
select id, draw_authority_id, version, provider_version, configuration_hash, status, created_at
from game_engine.draw_authority_versions
{whereClause}
order by draw_authority_id, version, id;
""";
        configure?.Invoke(command);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var versions = new List<DrawAuthorityVersion>();
        while (await reader.ReadAsync(cancellationToken))
        {
            versions.Add(new DrawAuthorityVersion(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                Enum.Parse<DrawAuthorityStatus>(reader.GetString(5), ignoreCase: true),
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

public sealed class PostgresDrawAuthorityAssignmentRepository(string connectionString) : IDrawAuthorityAssignmentRepository
{
    public async Task<IReadOnlyCollection<DrawAuthorityAssignment>> ListAsync(Guid gameDefinitionId, CancellationToken cancellationToken)
    {
        return await QueryManyAsync("where game_definition_id = @game_definition_id", command => command.Parameters.AddWithValue("game_definition_id", gameDefinitionId), cancellationToken);
    }

    public async Task<DrawAuthorityAssignment?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        return (await QueryManyAsync("where id = @id", command => command.Parameters.AddWithValue("id", id), cancellationToken))
            .FirstOrDefault();
    }

    public async Task<DrawAuthorityAssignment> UpsertAsync(DrawAuthorityAssignment assignment, CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into game_engine.draw_authority_assignments (
  id,
  game_definition_id,
  draw_authority_id,
  draw_authority_version_id,
  settlement_trigger_policy,
  effective_from,
  effective_to
) values (
  @id,
  @game_definition_id,
  @draw_authority_id,
  @draw_authority_version_id,
  @settlement_trigger_policy,
  @effective_from,
  @effective_to
)
on conflict (id) do update set
  game_definition_id = excluded.game_definition_id,
  draw_authority_id = excluded.draw_authority_id,
  draw_authority_version_id = excluded.draw_authority_version_id,
  settlement_trigger_policy = excluded.settlement_trigger_policy,
  effective_from = excluded.effective_from,
  effective_to = excluded.effective_to;
""";
        command.Parameters.AddWithValue("id", assignment.Id);
        command.Parameters.AddWithValue("game_definition_id", assignment.GameDefinitionId);
        command.Parameters.AddWithValue("draw_authority_id", assignment.DrawAuthorityId);
        command.Parameters.AddWithValue("draw_authority_version_id", assignment.DrawAuthorityVersionId);
        command.Parameters.AddWithValue("settlement_trigger_policy", assignment.SettlementTriggerPolicy.ToString());
        command.Parameters.AddWithValue("effective_from", assignment.EffectiveFrom);
        command.Parameters.AddWithValue("effective_to", assignment.EffectiveTo is null ? DBNull.Value : assignment.EffectiveTo.Value);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return await GetAsync(assignment.Id, cancellationToken) ?? assignment;
    }

    private async Task<IReadOnlyCollection<DrawAuthorityAssignment>> QueryManyAsync(
        string whereClause,
        Action<NpgsqlCommand>? configure,
        CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = $"""
select id, game_definition_id, draw_authority_id, draw_authority_version_id, settlement_trigger_policy, effective_from, effective_to
from game_engine.draw_authority_assignments
{whereClause}
order by game_definition_id, effective_from, id;
""";
        configure?.Invoke(command);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var assignments = new List<DrawAuthorityAssignment>();
        while (await reader.ReadAsync(cancellationToken))
        {
            assignments.Add(new DrawAuthorityAssignment(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetGuid(2),
                reader.GetGuid(3),
                Enum.Parse<SettlementTriggerPolicy>(reader.GetString(4), ignoreCase: true),
                reader.GetFieldValue<DateTimeOffset>(5),
                reader.IsDBNull(6) ? null : reader.GetFieldValue<DateTimeOffset>(6)));
        }

        return assignments;
    }

    private async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(PostgresConnectionString.Normalize(connectionString));
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}
