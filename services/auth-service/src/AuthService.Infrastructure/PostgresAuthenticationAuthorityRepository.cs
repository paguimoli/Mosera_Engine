using AuthService.Application.Contracts;
using AuthService.Domain.Models;
using Npgsql;
using NpgsqlTypes;
using System.Text.Json;

namespace AuthService.Infrastructure;

public sealed class PostgresAuthenticationAuthorityRepository(string connectionString) : IAuthenticationAuthorityRepository
{
    private readonly string connectionString = AuthPostgresConnectionString.Normalize(connectionString);
    public bool RuntimeAvailable => true;

    public async Task<CanonicalIdentity?> FindIdentityByIdentifier(string normalizedIdentifier, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = IdentitySelect + " where p.normalized_username = @identifier or p.normalized_email = @identifier limit 1";
        command.Parameters.AddWithValue("identifier", normalizedIdentifier);
        return await ReadIdentity(command, cancellationToken);
    }

    public async Task<CanonicalIdentity?> FindIdentityById(Guid identityId, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = IdentitySelect + " where p.identity_id = @identity_id limit 1";
        command.Parameters.AddWithValue("identity_id", identityId);
        return await ReadIdentity(command, cancellationToken);
    }

    public async Task<PasswordCredentialVersion?> FindActivePasswordCredential(Guid identityId, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = CredentialSelect + " where identity_id = @identity_id order by version desc limit 1";
        command.Parameters.AddWithValue("identity_id", identityId);
        return await ReadCredential(command, cancellationToken);
    }

    public async Task<IReadOnlyCollection<PasswordCredentialVersion>> ListPasswordHistory(Guid identityId, int limit, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = CredentialSelect + " where identity_id = @identity_id order by version desc limit @limit";
        command.Parameters.AddWithValue("identity_id", identityId);
        command.Parameters.AddWithValue("limit", Math.Clamp(limit, 1, 24));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var result = new List<PasswordCredentialVersion>();
        while (await reader.ReadAsync(cancellationToken)) result.Add(MapCredential(reader));
        return result;
    }

    public async Task<CanonicalIdentity> CreateIdentity(CanonicalIdentity identity, PasswordCredentialVersion credential, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var identityCommand = connection.CreateCommand())
        {
            identityCommand.Transaction = transaction;
            identityCommand.CommandText = """
insert into auth_service.identities (id, login_id, identity_type, lifecycle_state, metadata, created_at)
values (@id, @login_id, @identity_type, @lifecycle_state, '{}'::jsonb, @created_at);
insert into auth_service.identity_profiles (
  identity_id, tenant_id, brand_id, username, normalized_username, email, normalized_email,
  account_type, account_status, credential_status, mfa_status, created_at, disabled_at, review_due_at
) values (
  @id, @tenant_id, @brand_id, @username, @normalized_username, @email, @normalized_email,
  @account_type, @account_status, @credential_status, @mfa_status, @created_at, @disabled_at, @review_due_at
);
insert into auth_service.identity_roles (id, identity_id, role_id, scope_type, scope_id, effective_from)
select @emergency_role_assignment_id, @id, r.id, 'TENANT', @tenant_id::text, @created_at
from auth_service.roles r
where @account_type = 'EMERGENCY' and r.code = 'PLATFORM_SUPER_ADMIN' and r.disabled_at is null;
""";
            AddIdentityParameters(identityCommand, identity);
            identityCommand.Parameters.AddWithValue("emergency_role_assignment_id", Guid.NewGuid());
            await identityCommand.ExecuteNonQueryAsync(cancellationToken);
        }
        await InsertCredential(connection, transaction, credential, cancellationToken);
        await InsertAudit(connection, transaction, evidence, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return identity;
    }

    public async Task<PasswordCredentialVersion> RotatePassword(Guid identityId, PasswordCredentialVersion credential, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var lockCommand = connection.CreateCommand())
        {
            lockCommand.Transaction = transaction;
            lockCommand.CommandText = "select identity_id from auth_service.identity_profiles where identity_id = @identity_id for update";
            lockCommand.Parameters.AddWithValue("identity_id", identityId);
            if (await lockCommand.ExecuteScalarAsync(cancellationToken) is null) throw new InvalidOperationException("identity_not_found");
        }
        await InsertCredential(connection, transaction, credential, cancellationToken);
        await InsertAudit(connection, transaction, evidence, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return credential;
    }

    public async Task CreatePasswordResetRequest(PasswordResetAuthorityRecord reset, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
insert into auth_service.password_reset_requests (id, identity_id, token_hash, expires_at, created_at)
values (@id, @identity_id, @token_hash, @expires_at, @created_at);
""";
            command.Parameters.AddWithValue("id", reset.ResetId);
            command.Parameters.AddWithValue("identity_id", reset.IdentityId);
            command.Parameters.AddWithValue("token_hash", reset.TokenHash);
            command.Parameters.AddWithValue("expires_at", reset.ExpiresAt);
            command.Parameters.AddWithValue("created_at", reset.CreatedAt);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        await InsertAudit(connection, transaction, evidence, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<PasswordResetAuthorityRecord?> FindActivePasswordResetByHash(string tokenHash, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select r.id, r.identity_id, r.token_hash, r.expires_at, r.created_at
from auth_service.password_reset_requests r
left join auth_service.password_reset_consumptions c on c.reset_request_id = r.id
where r.token_hash = @token_hash and r.expires_at > now() and c.id is null
limit 1;
""";
        command.Parameters.AddWithValue("token_hash", tokenHash);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new PasswordResetAuthorityRecord(reader.GetGuid(0), reader.GetGuid(1), reader.GetString(2), reader.GetFieldValue<DateTimeOffset>(3), reader.GetFieldValue<DateTimeOffset>(4))
            : null;
    }

    public async Task<PasswordCredentialVersion> ConsumePasswordReset(PasswordResetAuthorityRecord reset, PasswordCredentialVersion credential, AuthenticationAuditEvidence resetEvidence, AuthenticationAuditEvidence logoutEvidence, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var consume = connection.CreateCommand())
        {
            consume.Transaction = transaction;
            consume.CommandText = """
insert into auth_service.password_reset_consumptions (id, reset_request_id, identity_id, consumed_at)
select @id, r.id, r.identity_id, now()
from auth_service.password_reset_requests r
where r.id = @reset_id and r.identity_id = @identity_id and r.expires_at > now()
  and not exists (select 1 from auth_service.password_reset_consumptions c where c.reset_request_id = r.id)
on conflict (reset_request_id) do nothing;
""";
            consume.Parameters.AddWithValue("id", Guid.NewGuid());
            consume.Parameters.AddWithValue("reset_id", reset.ResetId);
            consume.Parameters.AddWithValue("identity_id", reset.IdentityId);
            if (await consume.ExecuteNonQueryAsync(cancellationToken) != 1) throw new InvalidOperationException("invalid_password_reset_token");
        }
        await InsertCredential(connection, transaction, credential, cancellationToken);
        await using (var sessions = connection.CreateCommand())
        {
            sessions.Transaction = transaction;
            sessions.CommandText = """
update auth_service.canonical_sessions set revoked_at = now(), revoked_reason = 'password_reset' where identity_id = @identity_id and revoked_at is null;
update auth_service.sessions set state = 'REVOKED', revoked_at = now() where identity_id = @identity_id and revoked_at is null;
""";
            sessions.Parameters.AddWithValue("identity_id", reset.IdentityId);
            await sessions.ExecuteNonQueryAsync(cancellationToken);
        }
        await InsertAudit(connection, transaction, resetEvidence, cancellationToken);
        await InsertAudit(connection, transaction, logoutEvidence, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return credential;
    }

    public async Task<CanonicalIdentity> TransitionIdentity(Guid identityId, CanonicalIdentityStatus expectedStatus, CanonicalIdentityStatus targetStatus, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var credentialCompromise = connection.CreateCommand())
        {
            credentialCompromise.Transaction = transaction;
            credentialCompromise.CommandText = """
insert into auth_service.password_credential_versions (
  id, identity_id, version, password_hash, algorithm, memory_cost_kib, iterations,
  parallelism, compromised, created_at, rotated_at, retired_at
)
select @credential_event_id, c.identity_id, c.version + 1, c.password_hash, c.algorithm,
       c.memory_cost_kib, c.iterations, c.parallelism, true, now(), now(), null
from auth_service.password_credential_versions c
join auth_service.identity_profiles p on p.identity_id = c.identity_id
where c.identity_id = @identity_id
  and p.account_status = @expected_status
  and @target_status = 'COMPROMISED'
order by c.version desc
limit 1;
""";
            credentialCompromise.Parameters.AddWithValue("credential_event_id", Guid.NewGuid());
            credentialCompromise.Parameters.AddWithValue("identity_id", identityId);
            credentialCompromise.Parameters.AddWithValue("expected_status", ToDatabaseStatus(expectedStatus));
            credentialCompromise.Parameters.AddWithValue("target_status", ToDatabaseStatus(targetStatus));
            await credentialCompromise.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
update auth_service.identity_profiles
set account_status = @target_status,
    credential_status = case
      when @target_status = 'COMPROMISED' then 'COMPROMISED'
      when @expected_status = 'COMPROMISED' and @target_status = 'ACTIVE' then 'ACTIVE'
      else credential_status
    end,
    disabled_at = case when @target_status in ('DISABLED', 'DELETED') then now() else null end,
    review_due_at = now() + interval '90 days'
where identity_id = @identity_id and account_status = @expected_status
  and (
    @expected_status <> 'COMPROMISED' or @target_status <> 'ACTIVE' or
    exists (
      select 1 from auth_service.password_credential_versions c
      where c.identity_id = @identity_id
      order by c.version desc
      limit 1
    ) and not (
      select c.compromised from auth_service.password_credential_versions c
      where c.identity_id = @identity_id
      order by c.version desc
      limit 1
    )
  );
update auth_service.identities
set lifecycle_state = @legacy_status, updated_at = now(), deleted_at = case when @target_status = 'DELETED' then now() else null end
where id = @identity_id and exists (
  select 1 from auth_service.identity_profiles where identity_id = @identity_id and account_status = @target_status
);
""";
            command.Parameters.AddWithValue("identity_id", identityId);
            command.Parameters.AddWithValue("expected_status", ToDatabaseStatus(expectedStatus));
            command.Parameters.AddWithValue("target_status", ToDatabaseStatus(targetStatus));
            command.Parameters.AddWithValue("legacy_status", ToLegacyStatus(targetStatus));
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        var transitioned = await FindIdentityWithinTransaction(connection, transaction, identityId, cancellationToken);
        if (transitioned is null || transitioned.Status != targetStatus) throw new InvalidOperationException("identity_lifecycle_conflict");
        await InsertLifecycleEvidence(connection, transaction, evidence, expectedStatus, targetStatus, cancellationToken);
        await InsertAudit(connection, transaction, evidence, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return transitioned;
    }

    public async Task<CanonicalSession> EstablishSession(CanonicalIdentity identity, CanonicalSession session, CanonicalTokenArtifacts tokens, AuthenticationAuditEvidence loginEvidence, AuthenticationAuditEvidence sessionEvidence, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        int replaced;
        await using (var revoke = connection.CreateCommand())
        {
            revoke.Transaction = transaction;
            revoke.CommandText = """
update auth_service.canonical_sessions
set revoked_at = now(), revoked_reason = 'session_replaced'
where identity_id = @identity_id and revoked_at is null;
""";
            revoke.Parameters.AddWithValue("identity_id", identity.IdentityId);
            replaced = await revoke.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var revokeLegacy = connection.CreateCommand())
        {
            revokeLegacy.Transaction = transaction;
            revokeLegacy.CommandText = "update auth_service.sessions set state = 'REVOKED', revoked_at = now() where identity_id = @identity_id and state = 'ACTIVE' and revoked_at is null";
            revokeLegacy.Parameters.AddWithValue("identity_id", identity.IdentityId);
            await revokeLegacy.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var insert = connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
insert into auth_service.canonical_sessions (
  id, identity_id, session_token_hash, created_at, last_seen_at, idle_expires_at,
  absolute_expires_at, ip_address, user_agent, device_metadata
) values (
  @id, @identity_id, @session_token_hash, @created_at, @created_at, @idle_expires_at,
  @absolute_expires_at, @ip_address, @user_agent, @device_metadata
);
""";
            AddSessionParameters(insert, session);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var legacySession = connection.CreateCommand())
        {
            legacySession.Transaction = transaction;
            legacySession.CommandText = """
insert into auth_service.sessions (id, identity_id, state, policy_code, created_at, expires_at, metadata)
values (@id, @identity_id, 'ACTIVE', 'canonical-single-session', @created_at, @expires_at, @metadata);
""";
            legacySession.Parameters.AddWithValue("id", session.SessionId);
            legacySession.Parameters.AddWithValue("identity_id", session.IdentityId);
            legacySession.Parameters.AddWithValue("created_at", session.CreatedAt);
            legacySession.Parameters.AddWithValue("expires_at", session.AbsoluteExpiresAt);
            legacySession.Parameters.AddWithValue("metadata", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(new { canonicalSession = true, idleExpiresAt = session.IdleExpiresAt }));
            await legacySession.ExecuteNonQueryAsync(cancellationToken);
        }
        await InsertTokens(connection, transaction, identity, session, tokens, cancellationToken);
        await InsertAudit(connection, transaction, loginEvidence, cancellationToken);
        await InsertAudit(connection, transaction, sessionEvidence, cancellationToken);
        if (replaced > 0)
        {
            await InsertAudit(connection, transaction, sessionEvidence with { EvidenceId = Guid.NewGuid(), Action = "SESSION_REPLACED", Reason = $"replaced_count:{replaced}" }, cancellationToken);
        }
        await transaction.CommitAsync(cancellationToken);
        return session;
    }

    public async Task<CanonicalSession?> FindSessionByHash(string tokenHash, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = SessionSelect + " where session_token_hash = @token_hash limit 1";
        command.Parameters.AddWithValue("token_hash", tokenHash);
        return await ReadSession(command, cancellationToken);
    }

    public async Task<CanonicalSession?> RenewSession(string tokenHash, DateTimeOffset idleExpiresAt, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
update auth_service.canonical_sessions
set last_seen_at = now(), idle_expires_at = least(@idle_expires_at, absolute_expires_at)
where session_token_hash = @token_hash and revoked_at is null and idle_expires_at > now() and absolute_expires_at > now();
""";
        command.Parameters.AddWithValue("token_hash", tokenHash);
        command.Parameters.AddWithValue("idle_expires_at", idleExpiresAt);
        if (await command.ExecuteNonQueryAsync(cancellationToken) == 0) return null;
        return await FindSessionByHash(tokenHash, cancellationToken);
    }

    public async Task<int> RevokeSession(string tokenHash, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        int count;
        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "update auth_service.canonical_sessions set revoked_at = now(), revoked_reason = @reason where session_token_hash = @token_hash and revoked_at is null";
            command.Parameters.AddWithValue("reason", evidence.Reason);
            command.Parameters.AddWithValue("token_hash", tokenHash);
            count = await command.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var legacy = connection.CreateCommand())
        {
            legacy.Transaction = transaction;
            legacy.CommandText = "update auth_service.sessions set state = 'REVOKED', revoked_at = now() where id in (select id from auth_service.canonical_sessions where session_token_hash = @token_hash) and revoked_at is null";
            legacy.Parameters.AddWithValue("token_hash", tokenHash);
            await legacy.ExecuteNonQueryAsync(cancellationToken);
        }
        if (count > 0) await InsertAudit(connection, transaction, evidence, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return count;
    }

    public async Task<int> RevokeAllSessions(Guid identityId, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        int count;
        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "update auth_service.canonical_sessions set revoked_at = now(), revoked_reason = @reason where identity_id = @identity_id and revoked_at is null";
            command.Parameters.AddWithValue("identity_id", identityId);
            command.Parameters.AddWithValue("reason", evidence.Reason);
            count = await command.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var legacy = connection.CreateCommand())
        {
            legacy.Transaction = transaction;
            legacy.CommandText = "update auth_service.sessions set state = 'REVOKED', revoked_at = now() where identity_id = @identity_id and revoked_at is null";
            legacy.Parameters.AddWithValue("identity_id", identityId);
            await legacy.ExecuteNonQueryAsync(cancellationToken);
        }
        await InsertAudit(connection, transaction, evidence with { Reason = $"{evidence.Reason};revoked_count:{count}" }, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return count;
    }

    public async Task<int> RevokeSessionById(Guid sessionId, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        int count;
        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "update auth_service.canonical_sessions set revoked_at = now(), revoked_reason = @reason where id = @session_id and identity_id = @identity_id and revoked_at is null";
            command.Parameters.AddWithValue("session_id", sessionId);
            command.Parameters.AddWithValue("identity_id", evidence.SubjectIdentityId!.Value);
            command.Parameters.AddWithValue("reason", evidence.Reason);
            count = await command.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var legacy = connection.CreateCommand())
        {
            legacy.Transaction = transaction;
            legacy.CommandText = "update auth_service.sessions set state = 'REVOKED', revoked_at = now() where id = @session_id and identity_id = @identity_id and revoked_at is null";
            legacy.Parameters.AddWithValue("session_id", sessionId);
            legacy.Parameters.AddWithValue("identity_id", evidence.SubjectIdentityId!.Value);
            await legacy.ExecuteNonQueryAsync(cancellationToken);
        }
        if (count > 0) await InsertAudit(connection, transaction, evidence, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return count;
    }

    public async Task AppendAudit(AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await InsertAudit(connection, null, evidence, cancellationToken);
    }

    public async Task AppendAnonymousLoginFailure(string identifierHash, string reason, string correlationId, string? ipAddress, string? userAgent, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.authentication_login_attempts (
  id, identifier_hash, result, reason, correlation_id, occurred_at, ip_address, user_agent, authority
) values (
  @id, @identifier_hash, 'FAILURE', @reason, @correlation_id, now(), @ip_address, @user_agent, 'AUTH_SERVICE'
);
""";
        command.Parameters.AddWithValue("id", Guid.NewGuid());
        command.Parameters.AddWithValue("identifier_hash", identifierHash);
        command.Parameters.AddWithValue("reason", reason);
        command.Parameters.AddWithValue("correlation_id", correlationId);
        command.Parameters.AddWithValue("ip_address", (object?)ipAddress ?? DBNull.Value);
        command.Parameters.AddWithValue("user_agent", (object?)userAgent ?? DBNull.Value);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<bool> HasSuperAdminGovernance(Guid identityId, CancellationToken cancellationToken = default)
    {
        await using var connection = await OpenConnection(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
select exists (
  select 1
  from auth_service.identity_claims c
  where c.identity_id = @identity_id
    and c.claim_type = 'permission'
    and c.claim_value = 'system.admin'
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now())
  union all
  select 1
  from auth_service.identity_roles a
  join auth_service.roles r on r.id = a.role_id
  where a.identity_id = @identity_id
    and a.effective_from <= now()
    and (a.effective_to is null or a.effective_to > now())
    and r.disabled_at is null
    and r.code = 'PLATFORM_SUPER_ADMIN'
);
""";
        command.Parameters.AddWithValue("identity_id", identityId);
        return await command.ExecuteScalarAsync(cancellationToken) is true;
    }

    public async Task<bool> CheckReadiness(CancellationToken cancellationToken = default)
    {
        try
        {
            await using var connection = await OpenConnection(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
select to_regclass('auth_service.identity_profiles') is not null
   and to_regclass('auth_service.password_credential_versions') is not null
   and to_regclass('auth_service.canonical_sessions') is not null
   and to_regclass('auth_service.authentication_audit_evidence') is not null
   and to_regclass('auth_service.authentication_login_attempts') is not null;
""";
            return await command.ExecuteScalarAsync(cancellationToken) is true;
        }
        catch
        {
            return false;
        }
    }

    private async Task<NpgsqlConnection> OpenConnection(CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    private static async Task<CanonicalIdentity?> ReadIdentity(NpgsqlCommand command, CancellationToken cancellationToken)
    {
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapIdentity(reader) : null;
    }

    private static async Task<PasswordCredentialVersion?> ReadCredential(NpgsqlCommand command, CancellationToken cancellationToken)
    {
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapCredential(reader) : null;
    }

    private static async Task<CanonicalSession?> ReadSession(NpgsqlCommand command, CancellationToken cancellationToken)
    {
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? MapSession(reader) : null;
    }

    private static async Task<CanonicalIdentity?> FindIdentityWithinTransaction(NpgsqlConnection connection, NpgsqlTransaction transaction, Guid identityId, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = IdentitySelect + " where p.identity_id = @identity_id limit 1";
        command.Parameters.AddWithValue("identity_id", identityId);
        return await ReadIdentity(command, cancellationToken);
    }

    private static async Task InsertCredential(NpgsqlConnection connection, NpgsqlTransaction transaction, PasswordCredentialVersion credential, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into auth_service.password_credential_versions (
  id, identity_id, version, password_hash, algorithm, memory_cost_kib, iterations,
  parallelism, compromised, created_at, rotated_at, retired_at
) values (
  @id, @identity_id, @version, @password_hash, @algorithm, @memory_cost_kib, @iterations,
  @parallelism, @compromised, @created_at, @rotated_at, @retired_at
);
""";
        command.Parameters.AddWithValue("id", credential.CredentialVersionId);
        command.Parameters.AddWithValue("identity_id", credential.IdentityId);
        command.Parameters.AddWithValue("version", credential.Version);
        command.Parameters.AddWithValue("password_hash", credential.PasswordHash);
        command.Parameters.AddWithValue("algorithm", credential.Algorithm);
        command.Parameters.AddWithValue("memory_cost_kib", credential.MemoryCostKiB);
        command.Parameters.AddWithValue("iterations", credential.Iterations);
        command.Parameters.AddWithValue("parallelism", credential.Parallelism);
        command.Parameters.AddWithValue("compromised", credential.Compromised);
        command.Parameters.AddWithValue("created_at", credential.CreatedAt);
        command.Parameters.AddWithValue("rotated_at", credential.RotatedAt is null ? DBNull.Value : credential.RotatedAt.Value);
        command.Parameters.AddWithValue("retired_at", credential.RetiredAt is null ? DBNull.Value : credential.RetiredAt.Value);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task InsertTokens(NpgsqlConnection connection, NpgsqlTransaction transaction, CanonicalIdentity identity, CanonicalSession session, CanonicalTokenArtifacts tokens, CancellationToken cancellationToken)
    {
        await using (var access = connection.CreateCommand())
        {
            access.Transaction = transaction;
            access.CommandText = """
insert into auth_service.tokens (
  id, identity_id, token_type, token_format, issuer, audience, scopes, jwt_id,
  signing_key_id, issued_at, expires_at, metadata
) values (
  @id, @identity_id, 'ACCESS', 'JWT', @issuer, @audience, @scopes, @jwt_id,
  @signing_key_id, @issued_at, @expires_at, @metadata
);
""";
            access.Parameters.AddWithValue("id", tokens.AccessTokenId);
            access.Parameters.AddWithValue("identity_id", identity.IdentityId);
            access.Parameters.AddWithValue("issuer", tokens.Issuer);
            access.Parameters.AddWithValue("audience", tokens.Audience);
            access.Parameters.AddWithValue("scopes", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(tokens.Scopes));
            access.Parameters.AddWithValue("jwt_id", tokens.JwtId);
            access.Parameters.AddWithValue("signing_key_id", tokens.SigningKeyId);
            access.Parameters.AddWithValue("issued_at", tokens.AccessIssuedAt);
            access.Parameters.AddWithValue("expires_at", tokens.AccessExpiresAt);
            access.Parameters.AddWithValue("metadata", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(new { sessionId = session.SessionId, canonicalSession = true }));
            await access.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var refreshToken = connection.CreateCommand())
        {
            refreshToken.Transaction = transaction;
            refreshToken.CommandText = """
insert into auth_service.tokens (
  id, identity_id, token_type, token_format, issuer, audience, scopes,
  opaque_reference_hash, issued_at, expires_at, metadata
) values (
  @id, @identity_id, 'REFRESH', 'OPAQUE_REFERENCE', @issuer, @audience, '[]'::jsonb,
  @reference_hash, @issued_at, @expires_at, @metadata
);
insert into auth_service.refresh_tokens (
  id, identity_id, session_id, token_id, family_id, rotation_counter,
  opaque_reference_hash, issued_at, expires_at
) values (
  @refresh_id, @identity_id, @legacy_session_id, @id, @family_id, 0,
  @reference_hash, @issued_at, @expires_at
);
""";
            refreshToken.Parameters.AddWithValue("id", tokens.RefreshTokenRecordId);
            refreshToken.Parameters.AddWithValue("refresh_id", tokens.RefreshTokenId);
            refreshToken.Parameters.AddWithValue("identity_id", identity.IdentityId);
            refreshToken.Parameters.AddWithValue("legacy_session_id", session.SessionId);
            refreshToken.Parameters.AddWithValue("family_id", tokens.RefreshTokenFamilyId);
            refreshToken.Parameters.AddWithValue("issuer", tokens.Issuer);
            refreshToken.Parameters.AddWithValue("audience", tokens.Audience);
            refreshToken.Parameters.AddWithValue("reference_hash", tokens.RefreshTokenHash);
            refreshToken.Parameters.AddWithValue("issued_at", tokens.RefreshIssuedAt);
            refreshToken.Parameters.AddWithValue("expires_at", tokens.RefreshExpiresAt);
            refreshToken.Parameters.AddWithValue("metadata", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(new { sessionId = session.SessionId, canonicalSession = true }));
            await refreshToken.ExecuteNonQueryAsync(cancellationToken);
        }
    }

    private static async Task InsertAudit(NpgsqlConnection connection, NpgsqlTransaction? transaction, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into auth_service.authentication_audit_evidence (
  id, tenant_id, brand_id, actor_identity_id, subject_identity_id, action, result,
  reason, correlation_id, occurred_at, ip_address, user_agent, authority
) values (
  @id, @tenant_id, @brand_id, @actor_identity_id, @subject_identity_id, @action, @result,
  @reason, @correlation_id, @occurred_at, @ip_address, @user_agent, @authority
);
""";
        command.Parameters.AddWithValue("id", evidence.EvidenceId);
        command.Parameters.AddWithValue("tenant_id", evidence.TenantId);
        command.Parameters.AddWithValue("brand_id", evidence.BrandId is null ? DBNull.Value : evidence.BrandId.Value);
        command.Parameters.AddWithValue("actor_identity_id", evidence.ActorIdentityId is null ? DBNull.Value : evidence.ActorIdentityId.Value);
        command.Parameters.AddWithValue("subject_identity_id", evidence.SubjectIdentityId is null ? DBNull.Value : evidence.SubjectIdentityId.Value);
        command.Parameters.AddWithValue("action", evidence.Action);
        command.Parameters.AddWithValue("result", evidence.Result);
        command.Parameters.AddWithValue("reason", evidence.Reason);
        command.Parameters.AddWithValue("correlation_id", evidence.CorrelationId);
        command.Parameters.AddWithValue("occurred_at", evidence.OccurredAt);
        command.Parameters.AddWithValue("ip_address", evidence.IpAddress is null ? DBNull.Value : evidence.IpAddress);
        command.Parameters.AddWithValue("user_agent", evidence.UserAgent is null ? DBNull.Value : evidence.UserAgent);
        command.Parameters.AddWithValue("authority", evidence.Authority);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task InsertLifecycleEvidence(NpgsqlConnection connection, NpgsqlTransaction transaction, AuthenticationAuditEvidence evidence, CanonicalIdentityStatus previous, CanonicalIdentityStatus next, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
insert into auth_service.identity_lifecycle_events (
  id, tenant_id, brand_id, identity_id, previous_status, target_status, reason,
  actor_identity_id, correlation_id, occurred_at
) values (
  @id, @tenant_id, @brand_id, @identity_id, @previous_status, @target_status, @reason,
  @actor_identity_id, @correlation_id, @occurred_at
);
""";
        command.Parameters.AddWithValue("id", Guid.NewGuid());
        command.Parameters.AddWithValue("tenant_id", evidence.TenantId);
        command.Parameters.AddWithValue("brand_id", evidence.BrandId is null ? DBNull.Value : evidence.BrandId.Value);
        command.Parameters.AddWithValue("identity_id", evidence.SubjectIdentityId!.Value);
        command.Parameters.AddWithValue("previous_status", ToDatabaseStatus(previous));
        command.Parameters.AddWithValue("target_status", ToDatabaseStatus(next));
        command.Parameters.AddWithValue("reason", evidence.Reason);
        command.Parameters.AddWithValue("actor_identity_id", evidence.ActorIdentityId is null ? DBNull.Value : evidence.ActorIdentityId.Value);
        command.Parameters.AddWithValue("correlation_id", evidence.CorrelationId);
        command.Parameters.AddWithValue("occurred_at", evidence.OccurredAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static void AddIdentityParameters(NpgsqlCommand command, CanonicalIdentity identity)
    {
        command.Parameters.AddWithValue("id", identity.IdentityId);
        command.Parameters.AddWithValue("login_id", identity.NormalizedUsername);
        command.Parameters.AddWithValue("identity_type", ToLegacyIdentityType(identity.AccountType));
        command.Parameters.AddWithValue("lifecycle_state", ToLegacyStatus(identity.Status));
        command.Parameters.AddWithValue("tenant_id", identity.TenantId);
        command.Parameters.AddWithValue("brand_id", identity.BrandId is null ? DBNull.Value : identity.BrandId.Value);
        command.Parameters.AddWithValue("username", identity.Username);
        command.Parameters.AddWithValue("normalized_username", identity.NormalizedUsername);
        command.Parameters.AddWithValue("email", identity.Email is null ? DBNull.Value : identity.Email);
        command.Parameters.AddWithValue("normalized_email", identity.NormalizedEmail is null ? DBNull.Value : identity.NormalizedEmail);
        command.Parameters.AddWithValue("account_type", identity.AccountType);
        command.Parameters.AddWithValue("account_status", ToDatabaseStatus(identity.Status));
        command.Parameters.AddWithValue("credential_status", identity.CredentialStatus);
        command.Parameters.AddWithValue("mfa_status", identity.MfaStatus);
        command.Parameters.AddWithValue("created_at", identity.CreatedAt);
        command.Parameters.AddWithValue("disabled_at", identity.DisabledAt is null ? DBNull.Value : identity.DisabledAt.Value);
        command.Parameters.AddWithValue("review_due_at", identity.ReviewDueAt is null ? DBNull.Value : identity.ReviewDueAt.Value);
    }

    private static void AddSessionParameters(NpgsqlCommand command, CanonicalSession session)
    {
        command.Parameters.AddWithValue("id", session.SessionId);
        command.Parameters.AddWithValue("identity_id", session.IdentityId);
        command.Parameters.AddWithValue("session_token_hash", session.TokenHash);
        command.Parameters.AddWithValue("created_at", session.CreatedAt);
        command.Parameters.AddWithValue("idle_expires_at", session.IdleExpiresAt);
        command.Parameters.AddWithValue("absolute_expires_at", session.AbsoluteExpiresAt);
        command.Parameters.AddWithValue("ip_address", session.IpAddress is null ? DBNull.Value : session.IpAddress);
        command.Parameters.AddWithValue("user_agent", session.UserAgent is null ? DBNull.Value : session.UserAgent);
        command.Parameters.AddWithValue("device_metadata", session.DeviceMetadata is null ? DBNull.Value : session.DeviceMetadata);
    }

    private static CanonicalIdentity MapIdentity(NpgsqlDataReader reader) => new(
        reader.GetGuid(0), reader.GetGuid(1), reader.IsDBNull(2) ? null : reader.GetGuid(2), reader.GetString(3), reader.GetString(4),
        reader.IsDBNull(5) ? null : reader.GetString(5), reader.IsDBNull(6) ? null : reader.GetString(6), reader.GetString(7),
        ParseStatus(reader.GetString(8)), reader.GetString(9), reader.GetString(10), reader.GetFieldValue<DateTimeOffset>(11),
        reader.IsDBNull(12) ? null : reader.GetFieldValue<DateTimeOffset>(12), reader.IsDBNull(13) ? null : reader.GetFieldValue<DateTimeOffset>(13));

    private static PasswordCredentialVersion MapCredential(NpgsqlDataReader reader) => new(
        reader.GetGuid(0), reader.GetGuid(1), reader.GetInt32(2), reader.GetString(3), reader.GetString(4), reader.GetInt32(5),
        reader.GetInt32(6), reader.GetInt32(7), reader.GetBoolean(8), reader.GetFieldValue<DateTimeOffset>(9),
        reader.IsDBNull(10) ? null : reader.GetFieldValue<DateTimeOffset>(10), reader.IsDBNull(11) ? null : reader.GetFieldValue<DateTimeOffset>(11));

    private static CanonicalSession MapSession(NpgsqlDataReader reader) => new(
        reader.GetGuid(0), reader.GetGuid(1), string.Empty, reader.GetString(2), reader.GetFieldValue<DateTimeOffset>(3),
        reader.GetFieldValue<DateTimeOffset>(4), reader.GetFieldValue<DateTimeOffset>(5), reader.IsDBNull(6) ? null : reader.GetFieldValue<DateTimeOffset>(6),
        reader.IsDBNull(7) ? null : reader.GetString(7), reader.IsDBNull(8) ? null : reader.GetString(8), reader.IsDBNull(9) ? null : reader.GetString(9));

    private static string ToDatabaseStatus(CanonicalIdentityStatus status) => status.ToString().ToUpperInvariant();
    private static CanonicalIdentityStatus ParseStatus(string value) => Enum.Parse<CanonicalIdentityStatus>(value, true);
    private static string ToLegacyStatus(CanonicalIdentityStatus status) => status switch
    {
        CanonicalIdentityStatus.Compromised or CanonicalIdentityStatus.Emergency => "ACTIVE",
        _ => ToDatabaseStatus(status)
    };
    private static string ToLegacyIdentityType(string accountType) => accountType.ToUpperInvariant() switch
    {
        "ADMIN" or "SUPER_ADMIN" or "EMERGENCY" => "ADMIN",
        "PLAYER" => "PLAYER",
        "AGENT" => "AGENT",
        "OPERATOR" => "OPERATOR",
        "API_CLIENT" => "API_CLIENT",
        "SERVICE_ACCOUNT" => "SERVICE_ACCOUNT",
        "PAM_USER" => "PAM_USER",
        _ => throw new InvalidOperationException("unsupported_account_type")
    };

    private const string IdentitySelect = """
select p.identity_id, p.tenant_id, p.brand_id, p.username, p.normalized_username, p.email,
       p.normalized_email, p.account_type, p.account_status, p.credential_status, p.mfa_status,
       p.created_at, p.disabled_at, p.review_due_at
from auth_service.identity_profiles p
""";
    private const string CredentialSelect = """
select id, identity_id, version, password_hash, algorithm, memory_cost_kib, iterations,
       parallelism, compromised, created_at, rotated_at, retired_at
from auth_service.password_credential_versions
""";
    private const string SessionSelect = """
select id, identity_id, session_token_hash, created_at, idle_expires_at, absolute_expires_at,
       revoked_at, ip_address, user_agent, device_metadata
from auth_service.canonical_sessions
""";
}

public sealed class DisabledAuthenticationAuthorityRepository : IAuthenticationAuthorityRepository
{
    public bool RuntimeAvailable => false;
    private static InvalidOperationException Disabled() => new("Canonical authentication persistence is disabled because DATABASE_URL is absent.");
    public Task<CanonicalIdentity?> FindIdentityByIdentifier(string normalizedIdentifier, CancellationToken cancellationToken = default) => Task.FromResult<CanonicalIdentity?>(null);
    public Task<CanonicalIdentity?> FindIdentityById(Guid identityId, CancellationToken cancellationToken = default) => Task.FromResult<CanonicalIdentity?>(null);
    public Task<PasswordCredentialVersion?> FindActivePasswordCredential(Guid identityId, CancellationToken cancellationToken = default) => Task.FromResult<PasswordCredentialVersion?>(null);
    public Task<IReadOnlyCollection<PasswordCredentialVersion>> ListPasswordHistory(Guid identityId, int limit, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyCollection<PasswordCredentialVersion>>([]);
    public Task<CanonicalIdentity> CreateIdentity(CanonicalIdentity identity, PasswordCredentialVersion credential, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default) => Task.FromException<CanonicalIdentity>(Disabled());
    public Task<PasswordCredentialVersion> RotatePassword(Guid identityId, PasswordCredentialVersion credential, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default) => Task.FromException<PasswordCredentialVersion>(Disabled());
    public Task CreatePasswordResetRequest(PasswordResetAuthorityRecord reset, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default) => Task.FromException(Disabled());
    public Task<PasswordResetAuthorityRecord?> FindActivePasswordResetByHash(string tokenHash, CancellationToken cancellationToken = default) => Task.FromResult<PasswordResetAuthorityRecord?>(null);
    public Task<PasswordCredentialVersion> ConsumePasswordReset(PasswordResetAuthorityRecord reset, PasswordCredentialVersion credential, AuthenticationAuditEvidence resetEvidence, AuthenticationAuditEvidence logoutEvidence, CancellationToken cancellationToken = default) => Task.FromException<PasswordCredentialVersion>(Disabled());
    public Task<CanonicalIdentity> TransitionIdentity(Guid identityId, CanonicalIdentityStatus expectedStatus, CanonicalIdentityStatus targetStatus, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default) => Task.FromException<CanonicalIdentity>(Disabled());
    public Task<CanonicalSession> EstablishSession(CanonicalIdentity identity, CanonicalSession session, CanonicalTokenArtifacts tokens, AuthenticationAuditEvidence loginEvidence, AuthenticationAuditEvidence sessionEvidence, CancellationToken cancellationToken = default) => Task.FromException<CanonicalSession>(Disabled());
    public Task<CanonicalSession?> FindSessionByHash(string tokenHash, CancellationToken cancellationToken = default) => Task.FromResult<CanonicalSession?>(null);
    public Task<CanonicalSession?> RenewSession(string tokenHash, DateTimeOffset idleExpiresAt, CancellationToken cancellationToken = default) => Task.FromResult<CanonicalSession?>(null);
    public Task<int> RevokeSession(string tokenHash, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default) => Task.FromResult(0);
    public Task<int> RevokeSessionById(Guid sessionId, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default) => Task.FromResult(0);
    public Task<int> RevokeAllSessions(Guid identityId, AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default) => Task.FromResult(0);
    public Task AppendAudit(AuthenticationAuditEvidence evidence, CancellationToken cancellationToken = default) => Task.FromException(Disabled());
    public Task AppendAnonymousLoginFailure(string identifierHash, string reason, string correlationId, string? ipAddress, string? userAgent, CancellationToken cancellationToken = default) => Task.FromException(Disabled());
    public Task<bool> HasSuperAdminGovernance(Guid identityId, CancellationToken cancellationToken = default) => Task.FromResult(false);
    public Task<bool> CheckReadiness(CancellationToken cancellationToken = default) => Task.FromResult(false);
}
