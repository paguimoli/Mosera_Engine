using System.Text.Json;
using AuthService.Application.Contracts;
using AuthService.Domain.Boundaries;
using AuthService.Domain.Models;
using Npgsql;
using NpgsqlTypes;

namespace AuthService.Infrastructure;

public static class AuthPostgresConnectionString
{
    public static string Normalize(string connectionString)
    {
        if (connectionString.StartsWith("postgresql://", StringComparison.OrdinalIgnoreCase) ||
            connectionString.StartsWith("postgres://", StringComparison.OrdinalIgnoreCase))
        {
            var uri = new Uri(connectionString);
            var userInfo = uri.UserInfo.Split(':', 2);
            var builder = new NpgsqlConnectionStringBuilder
            {
                Host = uri.Host,
                Port = uri.Port > 0 ? uri.Port : 5432,
                Database = uri.AbsolutePath.TrimStart('/'),
                Username = Uri.UnescapeDataString(userInfo.ElementAtOrDefault(0) ?? string.Empty),
                Password = Uri.UnescapeDataString(userInfo.ElementAtOrDefault(1) ?? string.Empty)
            };

            return builder.ConnectionString;
        }

        return connectionString;
    }
}

public sealed class PostgresAuthRepository(string connectionString) :
    IIdentityRepository,
    ICredentialRepository,
    IRoleRepository,
    IPermissionRepository,
    IMembershipRepository,
    ISessionRepository,
    IAuditEventRepository,
    ITokenRepository,
    IRefreshTokenRepository,
    IServiceAccountRepository,
    ISigningKeyRepository,
    IAuthRuntimeStore
{
    public bool RuntimeAvailable => true;

    public Task<Identity?> FindById(Guid identityId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(QueryIdentity("where id = @value", command => command.Parameters.AddWithValue("value", identityId)));
    }

    public Task<Identity?> FindByLoginId(LoginId loginId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(QueryIdentity("where login_id = @value", command => command.Parameters.AddWithValue("value", loginId.Value)));
    }

    public Task<IReadOnlyCollection<CredentialBoundary>> ListPublicCredentials(Guid identityId, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select id,
       identity_id,
       credential_type,
       public_reference,
       jsonb_strip_nulls(metadata || jsonb_build_object(
         'hashAlgorithm', password_hash_algorithm,
         'hashVersion', password_hash_version
       ))::text,
       enabled,
       created_at,
       expires_at,
       disabled_at
from auth_service.identity_credentials
where identity_id = @identity_id
order by created_at, id;
""";
        command.Parameters.AddWithValue("identity_id", identityId);

        using var reader = command.ExecuteReader();
        var credentials = new List<CredentialBoundary>();
        while (reader.Read())
        {
            credentials.Add(MapCredentialBoundary(
                reader.GetGuid(0),
                reader.GetGuid(1),
                reader.GetString(2),
                reader.GetString(3),
                ReadStringDictionary(reader.GetString(4)),
                reader.GetBoolean(5),
                reader.GetFieldValue<DateTimeOffset>(6),
                reader.IsDBNull(7) ? null : reader.GetFieldValue<DateTimeOffset>(7),
                reader.IsDBNull(8) ? null : reader.GetFieldValue<DateTimeOffset>(8)));
        }

        return Task.FromResult<IReadOnlyCollection<CredentialBoundary>>(credentials);
    }

    public Task<CredentialSecretBoundary?> FindSecretBoundary(Guid credentialId, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select id, credential_type, secret_material_ref, password_hash, password_hash_algorithm, enabled, disabled_at
from auth_service.identity_credentials
where id = @credential_id
limit 1;
""";
        command.Parameters.AddWithValue("credential_id", credentialId);

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return Task.FromResult<CredentialSecretBoundary?>(null);
        }

        var active = reader.GetBoolean(5) && reader.IsDBNull(6);
        var secretReference = reader.IsDBNull(2) ? null : reader.GetString(2);
        var passwordHash = reader.IsDBNull(3) ? null : reader.GetString(3);
        var hashAlgorithm = reader.IsDBNull(4) ? null : reader.GetString(4);
        var secret = new CredentialSecretBoundary(
            CredentialId: reader.GetGuid(0),
            SecretMaterialReference: secretReference ?? passwordHash ?? string.Empty,
            ReturnedByPublicQueryModel: false);

        return Task.FromResult<CredentialSecretBoundary?>(active ? secret : null);
    }

    public Task<IReadOnlyCollection<Role>> ListRoles(Guid identityId, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select r.code, r.display_name, r.system_role
from auth_service.identity_roles ir
join auth_service.roles r on r.id = ir.role_id
where ir.identity_id = @identity_id
  and (ir.effective_to is null or ir.effective_to > now())
  and r.disabled_at is null
order by r.code;
""";
        command.Parameters.AddWithValue("identity_id", identityId);

        using var reader = command.ExecuteReader();
        var roles = new List<Role>();
        while (reader.Read())
        {
            roles.Add(new Role(
                Code: reader.GetString(0),
                DisplayName: reader.GetString(1),
                Permissions: [],
                SystemRole: reader.GetBoolean(2)));
        }

        return Task.FromResult<IReadOnlyCollection<Role>>(roles);
    }

    public Task<IReadOnlyCollection<string>> ListPermissions(Guid identityId, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select distinct claim_value
from auth_service.identity_claims
where identity_id = @identity_id
  and lower(claim_type) = 'permission'
  and revoked_at is null
  and (expires_at is null or expires_at > now())
order by claim_value;
""";
        command.Parameters.AddWithValue("identity_id", identityId);

        using var reader = command.ExecuteReader();
        var permissions = new List<string>();
        while (reader.Read())
        {
            permissions.Add(reader.GetString(0));
        }

        return Task.FromResult<IReadOnlyCollection<string>>(permissions);
    }

    public Task<IReadOnlyCollection<Membership>> ListMemberships(Guid identityId, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select id, identity_id, scope_type, scope_id, effective_from, effective_to
from auth_service.memberships
where identity_id = @identity_id
  and (effective_to is null or effective_to > now())
order by effective_from, id;
""";
        command.Parameters.AddWithValue("identity_id", identityId);

        using var reader = command.ExecuteReader();
        var memberships = new List<Membership>();
        while (reader.Read())
        {
            memberships.Add(new Membership(
                Id: reader.GetGuid(0),
                IdentityId: reader.GetGuid(1),
                ScopeType: reader.GetString(2),
                ScopeId: reader.GetString(3),
                Roles: [],
                Claims: [],
                EffectiveFrom: reader.GetFieldValue<DateTimeOffset>(4),
                EffectiveTo: reader.IsDBNull(5) ? null : reader.GetFieldValue<DateTimeOffset>(5)));
        }

        return Task.FromResult<IReadOnlyCollection<Membership>>(memberships);
    }

    public Task<Session?> FindSession(Guid sessionId, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select id, identity_id, state, policy_code, created_at, expires_at, revoked_at
from auth_service.sessions
where id = @session_id
limit 1;
""";
        command.Parameters.AddWithValue("session_id", sessionId);

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return Task.FromResult<Session?>(null);
        }

        var session = new Session(
            Id: reader.GetGuid(0),
            IdentityId: reader.GetGuid(1),
            State: ParseSessionState(reader.GetString(2)),
            PolicyCode: reader.GetString(3),
            CreatedAt: reader.GetFieldValue<DateTimeOffset>(4),
            ExpiresAt: reader.GetFieldValue<DateTimeOffset>(5),
            RevokedAt: reader.IsDBNull(6) ? null : reader.GetFieldValue<DateTimeOffset>(6));

        return Task.FromResult<Session?>(session);
    }

    public Task<IReadOnlyCollection<AuditEvent>> ListByCorrelationId(string correlationId, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select id, category, actor_identity_id, subject_identity_id, action, correlation_id, metadata::text, created_at
from auth_service.audit_events
where correlation_id = @correlation_id
order by created_at, id;
""";
        command.Parameters.AddWithValue("correlation_id", correlationId);

        using var reader = command.ExecuteReader();
        var events = new List<AuditEvent>();
        while (reader.Read())
        {
            events.Add(new AuditEvent(
                Id: reader.GetGuid(0),
                Category: ParseAuditCategory(reader.GetString(1)),
                ActorIdentityId: reader.IsDBNull(2) ? null : reader.GetGuid(2),
                SubjectIdentityId: reader.IsDBNull(3) ? null : reader.GetGuid(3),
                Action: reader.GetString(4),
                CorrelationId: reader.GetString(5),
                Metadata: ReadStringDictionary(reader.GetString(6)),
                CreatedAt: reader.GetFieldValue<DateTimeOffset>(7)));
        }

        return Task.FromResult<IReadOnlyCollection<AuditEvent>>(events);
    }

    public Identity UpsertIdentity(Identity identity)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.identities (id, login_id, identity_type, lifecycle_state, metadata, created_at, updated_at)
values (@id, @login_id, @identity_type, @lifecycle_state, '{}'::jsonb, @created_at, @created_at)
on conflict (id) do update set
  login_id = excluded.login_id,
  identity_type = excluded.identity_type,
  lifecycle_state = excluded.lifecycle_state,
  updated_at = now();
""";
        command.Parameters.AddWithValue("id", identity.Id);
        command.Parameters.AddWithValue("login_id", identity.LoginId.Value);
        command.Parameters.AddWithValue("identity_type", ToDatabaseIdentityType(identity.Type));
        command.Parameters.AddWithValue("lifecycle_state", ToDatabaseLifecycleState(identity.LifecycleState));
        command.Parameters.AddWithValue("created_at", identity.CreatedAt);
        command.ExecuteNonQuery();
        return FindById(identity.Id).GetAwaiter().GetResult() ?? identity;
    }

    public Credential UpsertCredential(Credential credential, string? secretReference = null, string? passwordHash = null, string? hashAlgorithm = null)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.identity_credentials (
  id, identity_id, credential_type, public_reference, metadata, secret_material_ref,
  password_hash, password_hash_algorithm, enabled, created_at, expires_at, disabled_at
) values (
  @id, @identity_id, @credential_type, @public_reference, '{}'::jsonb, @secret_material_ref,
  @password_hash, @password_hash_algorithm, @enabled, @created_at, @expires_at, @disabled_at
)
on conflict (id) do update set
  public_reference = excluded.public_reference,
  secret_material_ref = excluded.secret_material_ref,
  password_hash = excluded.password_hash,
  password_hash_algorithm = excluded.password_hash_algorithm,
  enabled = excluded.enabled,
  expires_at = excluded.expires_at,
  disabled_at = excluded.disabled_at;
""";
        command.Parameters.AddWithValue("id", credential.Id);
        command.Parameters.AddWithValue("identity_id", credential.IdentityId);
        command.Parameters.AddWithValue("credential_type", ToDatabaseCredentialType(credential.Type));
        command.Parameters.AddWithValue("public_reference", credential.PublicReference);
        command.Parameters.AddWithValue("secret_material_ref", (object?)secretReference ?? DBNull.Value);
        command.Parameters.AddWithValue("password_hash", (object?)passwordHash ?? DBNull.Value);
        command.Parameters.AddWithValue("password_hash_algorithm", (object?)hashAlgorithm ?? DBNull.Value);
        command.Parameters.AddWithValue("enabled", credential.Active);
        command.Parameters.AddWithValue("created_at", credential.CreatedAt);
        command.Parameters.AddWithValue("expires_at", credential.ExpiresAt is null ? DBNull.Value : credential.ExpiresAt.Value);
        command.Parameters.AddWithValue("disabled_at", credential.Active ? DBNull.Value : DateTimeOffset.UtcNow);
        command.ExecuteNonQuery();
        return credential;
    }

    public Role UpsertRole(Role role)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.roles (id, code, display_name, system_role, metadata)
values (@id, @code, @display_name, @system_role, '{}'::jsonb)
on conflict (code) do update set
  display_name = excluded.display_name,
  system_role = excluded.system_role,
  disabled_at = null;
""";
        command.Parameters.AddWithValue("id", CreateDeterministicGuid($"role:{role.Code}"));
        command.Parameters.AddWithValue("code", role.Code);
        command.Parameters.AddWithValue("display_name", role.DisplayName);
        command.Parameters.AddWithValue("system_role", role.SystemRole);
        command.ExecuteNonQuery();
        return role;
    }

    public void AssignRole(Guid identityId, string roleCode, string scopeType = "GLOBAL", string scopeId = "platform")
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.identity_roles (id, identity_id, role_id, scope_type, scope_id)
select @id, @identity_id, r.id, @scope_type, @scope_id
from auth_service.roles r
where r.code = @role_code
on conflict (identity_id, role_id, scope_type, scope_id, effective_from) do nothing;
""";
        command.Parameters.AddWithValue("id", CreateDeterministicGuid($"identity-role:{identityId}:{roleCode}:{scopeType}:{scopeId}"));
        command.Parameters.AddWithValue("identity_id", identityId);
        command.Parameters.AddWithValue("role_code", roleCode);
        command.Parameters.AddWithValue("scope_type", scopeType);
        command.Parameters.AddWithValue("scope_id", scopeId);
        command.ExecuteNonQuery();
    }

    public void UpsertPermission(string code, string displayName)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.permissions (id, code, display_name, description)
values (@id, @code, @display_name, '')
on conflict (code) do update set
  display_name = excluded.display_name,
  disabled_at = null;
""";
        command.Parameters.AddWithValue("id", CreateDeterministicGuid($"permission:{code}"));
        command.Parameters.AddWithValue("code", code);
        command.Parameters.AddWithValue("display_name", displayName);
        command.ExecuteNonQuery();
    }

    public void AddPermissionClaim(Guid identityId, string permission, string issuer = "auth-service-test")
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.identity_claims (id, identity_id, claim_type, claim_value, issuer)
values (@id, @identity_id, 'permission', @claim_value, @issuer)
on conflict (id) do nothing;
""";
        command.Parameters.AddWithValue("id", CreateDeterministicGuid($"permission-claim:{identityId}:{permission}:{issuer}"));
        command.Parameters.AddWithValue("identity_id", identityId);
        command.Parameters.AddWithValue("claim_value", permission);
        command.Parameters.AddWithValue("issuer", issuer);
        command.ExecuteNonQuery();
    }

    public Membership UpsertMembership(Membership membership)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.memberships (
  id, identity_id, scope_type, scope_id, metadata, effective_from, effective_to
) values (
  @id, @identity_id, @scope_type, @scope_id, '{}'::jsonb, @effective_from, @effective_to
)
on conflict (id) do update set
  scope_type = excluded.scope_type,
  scope_id = excluded.scope_id,
  effective_to = excluded.effective_to;
""";
        command.Parameters.AddWithValue("id", membership.Id);
        command.Parameters.AddWithValue("identity_id", membership.IdentityId);
        command.Parameters.AddWithValue("scope_type", membership.ScopeType);
        command.Parameters.AddWithValue("scope_id", membership.ScopeId);
        command.Parameters.AddWithValue("effective_from", membership.EffectiveFrom);
        command.Parameters.AddWithValue("effective_to", membership.EffectiveTo is null ? DBNull.Value : membership.EffectiveTo.Value);
        command.ExecuteNonQuery();
        return membership;
    }

    public Session UpsertSession(Session session)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.sessions (id, identity_id, state, policy_code, created_at, expires_at, revoked_at, metadata)
values (@id, @identity_id, @state, @policy_code, @created_at, @expires_at, @revoked_at, '{}'::jsonb)
on conflict (id) do update set
  state = excluded.state,
  policy_code = excluded.policy_code,
  expires_at = excluded.expires_at,
  revoked_at = excluded.revoked_at;
""";
        command.Parameters.AddWithValue("id", session.Id);
        command.Parameters.AddWithValue("identity_id", session.IdentityId);
        command.Parameters.AddWithValue("state", ToDatabaseSessionState(session.State));
        command.Parameters.AddWithValue("policy_code", session.PolicyCode);
        command.Parameters.AddWithValue("created_at", session.CreatedAt);
        command.Parameters.AddWithValue("expires_at", session.ExpiresAt);
        command.Parameters.AddWithValue("revoked_at", session.RevokedAt is null ? DBNull.Value : session.RevokedAt.Value);
        command.ExecuteNonQuery();
        return FindSession(session.Id).GetAwaiter().GetResult() ?? session;
    }

    public Task<Session> SaveSession(Session session, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(UpsertSession(session));
    }

    public Session? RevokeSession(Guid sessionId, DateTimeOffset revokedAt)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
update auth_service.sessions
set state = 'REVOKED',
    revoked_at = @revoked_at
where id = @session_id;
""";
        command.Parameters.AddWithValue("session_id", sessionId);
        command.Parameters.AddWithValue("revoked_at", revokedAt);
        command.ExecuteNonQuery();
        return FindSession(sessionId).GetAwaiter().GetResult();
    }

    public Task<Session?> RevokeSession(Guid sessionId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(RevokeSession(sessionId, revokedAt));
    }

    public AuditEvent AppendAuditEvent(AuditEvent auditEvent)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.audit_events (
  id, category, actor_identity_id, subject_identity_id, action, correlation_id, metadata, created_at
) values (
  @id, @category, @actor_identity_id, @subject_identity_id, @action, @correlation_id, @metadata, @created_at
)
on conflict (id) do nothing;
""";
        command.Parameters.AddWithValue("id", auditEvent.Id);
        command.Parameters.AddWithValue("category", ToDatabaseAuditCategory(auditEvent.Category));
        command.Parameters.AddWithValue("actor_identity_id", auditEvent.ActorIdentityId is null ? DBNull.Value : auditEvent.ActorIdentityId.Value);
        command.Parameters.AddWithValue("subject_identity_id", auditEvent.SubjectIdentityId is null ? DBNull.Value : auditEvent.SubjectIdentityId.Value);
        command.Parameters.AddWithValue("action", auditEvent.Action);
        command.Parameters.AddWithValue("correlation_id", auditEvent.CorrelationId);
        command.Parameters.AddWithValue("metadata", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(auditEvent.Metadata));
        command.Parameters.AddWithValue("created_at", auditEvent.CreatedAt);
        command.ExecuteNonQuery();
        return auditEvent;
    }

    public Task<AuditEvent> AppendAuditEvent(AuditEvent auditEvent, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(AppendAuditEvent(auditEvent));
    }

    public Task<AccessTokenMetadata?> FindAccessTokenMetadata(Guid tokenId, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select id, identity_id, token_format, issuer, audience, scopes::text, jwt_id, signing_key_id, issued_at, expires_at
from auth_service.tokens
where id = @token_id
  and revoked_at is null
limit 1;
""";
        command.Parameters.AddWithValue("token_id", tokenId);

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return Task.FromResult<AccessTokenMetadata?>(null);
        }

        return Task.FromResult<AccessTokenMetadata?>(new AccessTokenMetadata(
            TokenId: reader.GetGuid(0),
            IdentityId: reader.IsDBNull(1) ? null : reader.GetGuid(1),
            TokenFormat: reader.GetString(2),
            Issuer: reader.GetString(3),
            Audience: reader.GetString(4),
            Scopes: ReadStringArray(reader.GetString(5)),
            JwtId: reader.IsDBNull(6) ? null : reader.GetString(6),
            SigningKeyId: reader.IsDBNull(7) ? null : reader.GetGuid(7),
            IssuedAt: reader.GetFieldValue<DateTimeOffset>(8),
            ExpiresAt: reader.GetFieldValue<DateTimeOffset>(9)));
    }

    public Task<OpaqueTokenReference?> FindOpaqueReference(string referenceHash, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<OpaqueTokenReference?>(null);
    }

    public Task<RefreshTokenMetadata?> FindRefreshToken(Guid refreshTokenId, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select id, family_id, rotation_counter, previous_refresh_token_id, issued_at, expires_at, rotated_at, revoked_at
from auth_service.refresh_tokens
where id = @refresh_token_id
limit 1;
""";
        command.Parameters.AddWithValue("refresh_token_id", refreshTokenId);

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return Task.FromResult<RefreshTokenMetadata?>(null);
        }

        return Task.FromResult<RefreshTokenMetadata?>(new RefreshTokenMetadata(
            RefreshTokenId: reader.GetGuid(0),
            FamilyId: reader.GetGuid(1),
            RotationCounter: reader.GetInt32(2),
            PreviousRefreshTokenId: reader.IsDBNull(3) ? null : reader.GetGuid(3),
            IssuedAt: reader.GetFieldValue<DateTimeOffset>(4),
            ExpiresAt: reader.GetFieldValue<DateTimeOffset>(5),
            RotatedAt: reader.IsDBNull(6) ? null : reader.GetFieldValue<DateTimeOffset>(6),
            RevokedAt: reader.IsDBNull(7) ? null : reader.GetFieldValue<DateTimeOffset>(7)));
    }

    public Task<RefreshTokenRuntimeRecord?> FindRefreshTokenByHash(string referenceHash, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select id, identity_id, session_id, token_id, family_id, rotation_counter, previous_refresh_token_id,
       opaque_reference_hash, issued_at, expires_at, rotated_at, revoked_at, revoked_reason
from auth_service.refresh_tokens
where opaque_reference_hash = @reference_hash
limit 1;
""";
        command.Parameters.AddWithValue("reference_hash", referenceHash);

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return Task.FromResult<RefreshTokenRuntimeRecord?>(null);
        }

        return Task.FromResult<RefreshTokenRuntimeRecord?>(ReadRefreshTokenRuntimeRecord(reader));
    }

    public Task<AccessTokenMetadata> SaveJwtAccessToken(
        Guid tokenId,
        Guid identityId,
        Guid sessionId,
        string issuer,
        string audience,
        IReadOnlyCollection<string> scopes,
        string jwtId,
        Guid signingKeyId,
        DateTimeOffset issuedAt,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.tokens (
  id, identity_id, token_type, token_format, issuer, audience, scopes,
  jwt_id, signing_key_id, issued_at, expires_at, metadata
) values (
  @id, @identity_id, 'ACCESS', 'JWT', @issuer, @audience, @scopes,
  @jwt_id, @signing_key_id, @issued_at, @expires_at, @metadata
)
on conflict (id) do nothing;
""";
        command.Parameters.AddWithValue("id", tokenId);
        command.Parameters.AddWithValue("identity_id", identityId);
        command.Parameters.AddWithValue("issuer", issuer);
        command.Parameters.AddWithValue("audience", audience);
        command.Parameters.AddWithValue("scopes", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(scopes));
        command.Parameters.AddWithValue("jwt_id", jwtId);
        command.Parameters.AddWithValue("signing_key_id", signingKeyId);
        command.Parameters.AddWithValue("issued_at", issuedAt);
        command.Parameters.AddWithValue("expires_at", expiresAt);
        command.Parameters.AddWithValue("metadata", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(new Dictionary<string, string>
        {
            ["sessionId"] = sessionId.ToString()
        }));
        command.ExecuteNonQuery();

        return Task.FromResult(new AccessTokenMetadata(tokenId, identityId, "JWT", issuer, audience, scopes, jwtId, signingKeyId, issuedAt, expiresAt));
    }

    public Task<RefreshTokenRuntimeRecord> SaveRefreshToken(
        Guid refreshTokenId,
        Guid identityId,
        Guid sessionId,
        Guid tokenId,
        Guid familyId,
        int rotationCounter,
        Guid? previousRefreshTokenId,
        string referenceHash,
        DateTimeOffset issuedAt,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        using var tokenCommand = connection.CreateCommand();
        tokenCommand.Transaction = transaction;
        tokenCommand.CommandText = """
insert into auth_service.tokens (
  id, identity_id, token_type, token_format, issuer, audience, scopes,
  opaque_reference_hash, issued_at, expires_at, metadata
) values (
  @id, @identity_id, 'REFRESH', 'OPAQUE_REFERENCE', 'lottery-auth-service', 'lottery-platform', '[]'::jsonb,
  @opaque_reference_hash, @issued_at, @expires_at, @metadata
)
on conflict (id) do nothing;
""";
        tokenCommand.Parameters.AddWithValue("id", tokenId);
        tokenCommand.Parameters.AddWithValue("identity_id", identityId);
        tokenCommand.Parameters.AddWithValue("opaque_reference_hash", referenceHash);
        tokenCommand.Parameters.AddWithValue("issued_at", issuedAt);
        tokenCommand.Parameters.AddWithValue("expires_at", expiresAt);
        tokenCommand.Parameters.AddWithValue("metadata", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(new Dictionary<string, string>
        {
            ["sessionId"] = sessionId.ToString(),
            ["refreshTokenId"] = refreshTokenId.ToString()
        }));
        tokenCommand.ExecuteNonQuery();

        using var refreshCommand = connection.CreateCommand();
        refreshCommand.Transaction = transaction;
        refreshCommand.CommandText = """
insert into auth_service.refresh_tokens (
  id, identity_id, session_id, token_id, family_id, rotation_counter,
  previous_refresh_token_id, opaque_reference_hash, issued_at, expires_at
) values (
  @id, @identity_id, @session_id, @token_id, @family_id, @rotation_counter,
  @previous_refresh_token_id, @opaque_reference_hash, @issued_at, @expires_at
)
on conflict (id) do nothing;
""";
        refreshCommand.Parameters.AddWithValue("id", refreshTokenId);
        refreshCommand.Parameters.AddWithValue("identity_id", identityId);
        refreshCommand.Parameters.AddWithValue("session_id", sessionId);
        refreshCommand.Parameters.AddWithValue("token_id", tokenId);
        refreshCommand.Parameters.AddWithValue("family_id", familyId);
        refreshCommand.Parameters.AddWithValue("rotation_counter", rotationCounter);
        refreshCommand.Parameters.AddWithValue("previous_refresh_token_id", previousRefreshTokenId is null ? DBNull.Value : previousRefreshTokenId.Value);
        refreshCommand.Parameters.AddWithValue("opaque_reference_hash", referenceHash);
        refreshCommand.Parameters.AddWithValue("issued_at", issuedAt);
        refreshCommand.Parameters.AddWithValue("expires_at", expiresAt);
        refreshCommand.ExecuteNonQuery();
        transaction.Commit();

        return Task.FromResult(new RefreshTokenRuntimeRecord(
            refreshTokenId,
            identityId,
            sessionId,
            tokenId,
            familyId,
            rotationCounter,
            previousRefreshTokenId,
            referenceHash,
            issuedAt,
            expiresAt,
            RotatedAt: null,
            RevokedAt: null,
            RevokedReason: null));
    }

    public Task<RefreshTokenRuntimeRecord?> MarkRefreshTokenRotated(Guid refreshTokenId, DateTimeOffset rotatedAt, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
update auth_service.refresh_tokens
set rotated_at = coalesce(rotated_at, @rotated_at)
where id = @refresh_token_id;
""";
        command.Parameters.AddWithValue("refresh_token_id", refreshTokenId);
        command.Parameters.AddWithValue("rotated_at", rotatedAt);
        command.ExecuteNonQuery();
        return FindRefreshTokenRuntimeById(refreshTokenId);
    }

    public Task<int> RevokeRefreshTokensForSession(Guid sessionId, DateTimeOffset revokedAt, string reason, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
update auth_service.refresh_tokens
set revoked_at = coalesce(revoked_at, @revoked_at),
    revoked_reason = coalesce(revoked_reason, @reason)
where session_id = @session_id
  and revoked_at is null;
""";
        command.Parameters.AddWithValue("session_id", sessionId);
        command.Parameters.AddWithValue("revoked_at", revokedAt);
        command.Parameters.AddWithValue("reason", reason);
        return Task.FromResult(command.ExecuteNonQuery());
    }

    public Task<int> RevokeRefreshTokenFamily(Guid familyId, DateTimeOffset revokedAt, string reason, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
update auth_service.refresh_tokens
set revoked_at = coalesce(revoked_at, @revoked_at),
    revoked_reason = coalesce(revoked_reason, @reason)
where family_id = @family_id
  and revoked_at is null;
""";
        command.Parameters.AddWithValue("family_id", familyId);
        command.Parameters.AddWithValue("revoked_at", revokedAt);
        command.Parameters.AddWithValue("reason", reason);
        return Task.FromResult(command.ExecuteNonQuery());
    }

    public Task<IReadOnlyCollection<SigningKeyMetadata>> ListSigningKeys(CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select id, key_id, algorithm, version, status, activates_at, expires_at, retired_at
from auth_service.signing_keys
order by version desc, activates_at desc, key_id;
""";

        using var reader = command.ExecuteReader();
        var keys = new List<SigningKeyMetadata>();
        while (reader.Read())
        {
            keys.Add(new SigningKeyMetadata(
                SigningKeyId: reader.GetGuid(0),
                KeyId: reader.GetString(1),
                Algorithm: reader.GetString(2),
                Version: reader.GetInt32(3),
                Status: reader.GetString(4),
                ActivatesAt: reader.GetFieldValue<DateTimeOffset>(5),
                ExpiresAt: reader.IsDBNull(6) ? null : reader.GetFieldValue<DateTimeOffset>(6),
                RetiredAt: reader.IsDBNull(7) ? null : reader.GetFieldValue<DateTimeOffset>(7)));
        }

        return Task.FromResult<IReadOnlyCollection<SigningKeyMetadata>>(keys);
    }

    public Task<IReadOnlyCollection<JwksKeyDescriptor>> ListPublicJwks(CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select key_id, algorithm, public_jwk::text
from auth_service.signing_keys
where status in ('ACTIVE', 'ROTATING')
  and activates_at <= now()
  and (expires_at is null or expires_at > now())
  and retired_at is null
order by version desc, activates_at desc, key_id;
""";

        using var reader = command.ExecuteReader();
        var keys = new List<JwksKeyDescriptor>();
        while (reader.Read())
        {
            keys.Add(new JwksKeyDescriptor(
                KeyId: reader.GetString(0),
                Algorithm: reader.GetString(1),
                Use: "sig",
                PublicParameters: ReadStringDictionary(reader.GetString(2))));
        }

        return Task.FromResult<IReadOnlyCollection<JwksKeyDescriptor>>(keys);
    }

    public Task<SigningKeyMaterial?> FindActiveSigningKey(CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select id, key_id, algorithm, version, status, public_jwk::text, private_key_material_ref, activates_at, expires_at, retired_at
from auth_service.signing_keys
where status = 'ACTIVE'
  and activates_at <= now()
  and (expires_at is null or expires_at > now())
  and retired_at is null
order by version desc, activates_at desc
limit 1;
""";

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return Task.FromResult<SigningKeyMaterial?>(null);
        }

        return Task.FromResult<SigningKeyMaterial?>(new SigningKeyMaterial(
            SigningKeyId: reader.GetGuid(0),
            KeyId: reader.GetString(1),
            Algorithm: reader.GetString(2),
            Version: reader.GetInt32(3),
            Status: reader.GetString(4),
            PublicParameters: ReadStringDictionary(reader.GetString(5)),
            PrivateKeyPem: reader.GetString(6),
            ActivatesAt: reader.GetFieldValue<DateTimeOffset>(7),
            ExpiresAt: reader.IsDBNull(8) ? null : reader.GetFieldValue<DateTimeOffset>(8),
            RetiredAt: reader.IsDBNull(9) ? null : reader.GetFieldValue<DateTimeOffset>(9)));
    }

    public Task<SigningKeyMaterial> SaveSigningKey(SigningKeyMaterial signingKey, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
insert into auth_service.signing_keys (
  id, key_id, algorithm, public_jwk, private_key_material_ref,
  status, version, activates_at, expires_at, retired_at
) values (
  @id, @key_id, @algorithm, @public_jwk, @private_key_material_ref,
  @status, @version, @activates_at, @expires_at, @retired_at
)
on conflict (key_id) do update set
  status = excluded.status,
  public_jwk = excluded.public_jwk,
  private_key_material_ref = excluded.private_key_material_ref,
  expires_at = excluded.expires_at,
  retired_at = excluded.retired_at;
""";
        command.Parameters.AddWithValue("id", signingKey.SigningKeyId);
        command.Parameters.AddWithValue("key_id", signingKey.KeyId);
        command.Parameters.AddWithValue("algorithm", signingKey.Algorithm);
        command.Parameters.AddWithValue("public_jwk", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(signingKey.PublicParameters));
        command.Parameters.AddWithValue("private_key_material_ref", signingKey.PrivateKeyPem);
        command.Parameters.AddWithValue("status", signingKey.Status);
        command.Parameters.AddWithValue("version", signingKey.Version);
        command.Parameters.AddWithValue("activates_at", signingKey.ActivatesAt);
        command.Parameters.AddWithValue("expires_at", signingKey.ExpiresAt is null ? DBNull.Value : signingKey.ExpiresAt.Value);
        command.Parameters.AddWithValue("retired_at", signingKey.RetiredAt is null ? DBNull.Value : signingKey.RetiredAt.Value);
        command.ExecuteNonQuery();
        return Task.FromResult(signingKey);
    }

    public Task<ServiceAccount?> FindByServiceName(string serviceName, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select sa.id, sa.identity_id, sa.service_name, sa.mtls_optional,
       oc.id, oc.client_id, oc.display_name, oc.allowed_grant_types::text,
       oc.redirect_uris::text, oc.scopes::text, oc.requires_pkce, oc.mtls_bound
from auth_service.service_accounts sa
join auth_service.oauth_clients oc on oc.id = sa.oauth_client_id
where sa.service_name = @service_name
  and sa.active = true
  and oc.active = true
  and oc.disabled_at is null
limit 1;
""";
        command.Parameters.AddWithValue("service_name", serviceName);

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return Task.FromResult<ServiceAccount?>(null);
        }

        var client = new OAuthClient(
            Id: reader.GetGuid(4),
            ClientId: reader.GetString(5),
            DisplayName: reader.GetString(6),
            AllowedGrantTypes: ReadStringArray(reader.GetString(7)),
            RedirectUris: ReadStringArray(reader.GetString(8)),
            Scopes: ReadStringArray(reader.GetString(9)),
            RequiresPkce: reader.GetBoolean(10),
            MtlsBound: reader.GetBoolean(11));

        return Task.FromResult<ServiceAccount?>(new ServiceAccount(
            Id: reader.GetGuid(0),
            IdentityId: reader.GetGuid(1),
            ServiceName: reader.GetString(2),
            OAuthClient: client,
            MtlsOptional: reader.GetBoolean(3)));
    }

    public Task<ServiceCredentialSecretBoundary?> FindServiceCredentialSecret(string serviceName, CancellationToken cancellationToken = default)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select sa.id, sa.identity_id, oc.id, sa.service_name, oc.client_id, oc.scopes::text,
       ocs.secret_hash, coalesce(ocs.hash_algorithm, 'PBKDF2-SHA256')
from auth_service.service_accounts sa
join auth_service.oauth_clients oc on oc.id = sa.oauth_client_id
join auth_service.oauth_client_secrets ocs on ocs.oauth_client_id = oc.id
where sa.service_name = @service_name
  and sa.active = true
  and oc.active = true
  and oc.disabled_at is null
  and ocs.revoked_at is null
  and (ocs.expires_at is null or ocs.expires_at > now())
order by ocs.created_at desc
limit 1;
""";
        command.Parameters.AddWithValue("service_name", serviceName);

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return Task.FromResult<ServiceCredentialSecretBoundary?>(null);
        }

        return Task.FromResult<ServiceCredentialSecretBoundary?>(new ServiceCredentialSecretBoundary(
            ServiceAccountId: reader.GetGuid(0),
            IdentityId: reader.GetGuid(1),
            OAuthClientId: reader.GetGuid(2),
            ServiceName: reader.GetString(3),
            ClientId: reader.GetString(4),
            Scopes: ReadStringArray(reader.GetString(5)),
            SecretHash: reader.GetString(6),
            HashAlgorithm: reader.GetString(7)));
    }

    private Task<RefreshTokenRuntimeRecord?> FindRefreshTokenRuntimeById(Guid refreshTokenId)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
select id, identity_id, session_id, token_id, family_id, rotation_counter, previous_refresh_token_id,
       opaque_reference_hash, issued_at, expires_at, rotated_at, revoked_at, revoked_reason
from auth_service.refresh_tokens
where id = @refresh_token_id
limit 1;
""";
        command.Parameters.AddWithValue("refresh_token_id", refreshTokenId);

        using var reader = command.ExecuteReader();
        return Task.FromResult(reader.Read() ? ReadRefreshTokenRuntimeRecord(reader) : null);
    }

    private static RefreshTokenRuntimeRecord ReadRefreshTokenRuntimeRecord(NpgsqlDataReader reader)
    {
        return new RefreshTokenRuntimeRecord(
            RefreshTokenId: reader.GetGuid(0),
            IdentityId: reader.GetGuid(1),
            SessionId: reader.GetGuid(2),
            TokenId: reader.GetGuid(3),
            FamilyId: reader.GetGuid(4),
            RotationCounter: reader.GetInt32(5),
            PreviousRefreshTokenId: reader.IsDBNull(6) ? null : reader.GetGuid(6),
            ReferenceHash: reader.GetString(7),
            IssuedAt: reader.GetFieldValue<DateTimeOffset>(8),
            ExpiresAt: reader.GetFieldValue<DateTimeOffset>(9),
            RotatedAt: reader.IsDBNull(10) ? null : reader.GetFieldValue<DateTimeOffset>(10),
            RevokedAt: reader.IsDBNull(11) ? null : reader.GetFieldValue<DateTimeOffset>(11),
            RevokedReason: reader.IsDBNull(12) ? null : reader.GetString(12));
    }

    private Identity? QueryIdentity(string whereClause, Action<NpgsqlCommand> configure)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = $"""
select id, login_id, identity_type, lifecycle_state, created_at
from auth_service.identities
{whereClause}
limit 1;
""";
        configure(command);

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        return new Identity(
            Id: reader.GetGuid(0),
            LoginId: new LoginId(reader.GetString(1)),
            Type: ParseIdentityType(reader.GetString(2)),
            LifecycleState: ParseLifecycleState(reader.GetString(3)),
            Credentials: [],
            Roles: [],
            Claims: [],
            Memberships: [],
            CreatedAt: reader.GetFieldValue<DateTimeOffset>(4));
    }

    private NpgsqlConnection OpenConnection()
    {
        var connection = new NpgsqlConnection(AuthPostgresConnectionString.Normalize(connectionString));
        connection.Open();
        return connection;
    }

    private static IReadOnlyDictionary<string, string> ReadStringDictionary(string json)
    {
        using var document = JsonDocument.Parse(json);
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var property in document.RootElement.EnumerateObject())
        {
            values[property.Name] = property.Value.ValueKind switch
            {
                JsonValueKind.String => property.Value.GetString() ?? string.Empty,
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                JsonValueKind.Null => string.Empty,
                _ => property.Value.GetRawText()
            };
        }

        return values;
    }

    private static IReadOnlyCollection<string> ReadStringArray(string json)
    {
        return JsonSerializer.Deserialize<string[]>(json) ?? [];
    }

    private static CredentialBoundary MapCredentialBoundary(
        Guid credentialId,
        Guid identityId,
        string databaseType,
        string publicReference,
        IReadOnlyDictionary<string, string> metadata,
        bool enabled,
        DateTimeOffset createdAt,
        DateTimeOffset? expiresAt,
        DateTimeOffset? disabledAt)
    {
        return ParseCredentialType(databaseType) switch
        {
            CredentialType.Password => new PasswordCredential(
                credentialId,
                identityId,
                publicReference,
                metadata.GetValueOrDefault("hashAlgorithm") ?? metadata.GetValueOrDefault("password_hash_algorithm") ?? "UNKNOWN",
                metadata.GetValueOrDefault("hashVersion") ?? metadata.GetValueOrDefault("password_hash_version") ?? "UNKNOWN",
                enabled,
                createdAt,
                disabledAt,
                expiresAt),
            CredentialType.Totp => new TotpCredential(
                credentialId,
                identityId,
                publicReference,
                metadata.GetValueOrDefault("issuer") ?? "Auth Service",
                enabled,
                createdAt,
                disabledAt),
            CredentialType.Passkey => new WebAuthnCredential(
                credentialId,
                identityId,
                publicReference,
                metadata.GetValueOrDefault("credentialDeviceType") ?? "UNKNOWN",
                metadata.GetValueOrDefault("residentKey") == "true",
                enabled,
                createdAt,
                disabledAt),
            CredentialType.OAuthFederation => new OAuthFederatedCredential(
                credentialId,
                identityId,
                publicReference,
                metadata.GetValueOrDefault("provider") ?? "UNKNOWN",
                metadata.GetValueOrDefault("subject") ?? publicReference,
                enabled,
                createdAt,
                disabledAt),
            CredentialType.PamFederation => new PamFederatedCredential(
                credentialId,
                identityId,
                publicReference,
                metadata.GetValueOrDefault("provider") ?? "UNKNOWN",
                metadata.GetValueOrDefault("externalUserId") ?? publicReference,
                enabled,
                createdAt,
                disabledAt),
            CredentialType.ApiKey => new ApiKeyCredential(
                credentialId,
                identityId,
                publicReference,
                metadata.GetValueOrDefault("keyId") ?? publicReference,
                enabled,
                createdAt,
                disabledAt,
                expiresAt),
            CredentialType.ClientSecret => new ClientSecretCredential(
                credentialId,
                identityId,
                publicReference,
                Guid.TryParse(metadata.GetValueOrDefault("oauthClientId"), out var oauthClientId) ? oauthClientId : Guid.Empty,
                enabled,
                createdAt,
                disabledAt,
                expiresAt),
            CredentialType.Certificate => new CertificateCredential(
                credentialId,
                identityId,
                publicReference,
                metadata.GetValueOrDefault("thumbprint") ?? publicReference,
                metadata.GetValueOrDefault("subject") ?? "UNKNOWN",
                enabled,
                createdAt,
                disabledAt,
                expiresAt),
            _ => throw new NotSupportedException($"Credential type {databaseType} is not supported by the current Auth Service schema.")
        };
    }

    private static Guid CreateDeterministicGuid(string value)
    {
        var bytes = System.Security.Cryptography.MD5.HashData(System.Text.Encoding.UTF8.GetBytes(value));
        return new Guid(bytes);
    }

    private static IdentityType ParseIdentityType(string value) => value.ToUpperInvariant() switch
    {
        "ADMIN" => IdentityType.Admin,
        "PLAYER" => IdentityType.Player,
        "AGENT" => IdentityType.Agent,
        "OPERATOR" => IdentityType.Operator,
        "API_CLIENT" => IdentityType.ApiClient,
        "SERVICE_ACCOUNT" => IdentityType.ServiceAccount,
        "PAM_USER" => IdentityType.PamUser,
        _ => throw new InvalidOperationException($"Unsupported identity type '{value}'.")
    };

    private static IdentityLifecycleState ParseLifecycleState(string value) => value.ToUpperInvariant() switch
    {
        "CREATED" => IdentityLifecycleState.Created,
        "PENDING_ACTIVATION" => IdentityLifecycleState.PendingActivation,
        "ACTIVE" => IdentityLifecycleState.Active,
        "SUSPENDED" => IdentityLifecycleState.Suspended,
        "LOCKED" => IdentityLifecycleState.Locked,
        "DISABLED" => IdentityLifecycleState.Disabled,
        "DELETED" => IdentityLifecycleState.Deleted,
        _ => IdentityLifecycleState.Archived
    };

    private static CredentialType ParseCredentialType(string value) => value.ToUpperInvariant() switch
    {
        "PASSWORD" => CredentialType.Password,
        "TOTP" => CredentialType.Totp,
        "WEBAUTHN" => CredentialType.Passkey,
        "OAUTH_FEDERATION" => CredentialType.OAuthFederation,
        "PAM_FEDERATION" => CredentialType.PamFederation,
        "API_KEY" => CredentialType.ApiKey,
        "CLIENT_SECRET" => CredentialType.ClientSecret,
        "CERTIFICATE" => CredentialType.Certificate,
        _ => throw new InvalidOperationException($"Unsupported credential type '{value}'.")
    };

    private static SessionState ParseSessionState(string value) => value.ToUpperInvariant() switch
    {
        "CREATED" => SessionState.Created,
        "ACTIVE" => SessionState.Active,
        "EXPIRED" => SessionState.Expired,
        "REVOKED" => SessionState.Revoked,
        _ => throw new InvalidOperationException($"Unsupported session state '{value}'.")
    };

    private static AuditEventCategory ParseAuditCategory(string value) => Enum.Parse<AuditEventCategory>(value, ignoreCase: true);

    private static string ToDatabaseIdentityType(IdentityType value) => value switch
    {
        IdentityType.ApiClient => "API_CLIENT",
        IdentityType.ServiceAccount => "SERVICE_ACCOUNT",
        IdentityType.PamUser => "PAM_USER",
        _ => value.ToString().ToUpperInvariant()
    };

    private static string ToDatabaseLifecycleState(IdentityLifecycleState value) => value switch
    {
        IdentityLifecycleState.PendingActivation => "PENDING_ACTIVATION",
        IdentityLifecycleState.Archived => "DISABLED",
        _ => value.ToString().ToUpperInvariant()
    };

    private static string ToDatabaseCredentialType(CredentialType value) => value switch
    {
        CredentialType.Password => "PASSWORD",
        CredentialType.Totp => "TOTP",
        CredentialType.Passkey => "WEBAUTHN",
        CredentialType.OAuthFederation => "OAUTH_FEDERATION",
        CredentialType.PamFederation => "PAM_FEDERATION",
        CredentialType.ApiKey => "API_KEY",
        CredentialType.ApiSecret => "API_KEY",
        CredentialType.ClientSecret => "CLIENT_SECRET",
        CredentialType.ClientCertificate => "CERTIFICATE",
        CredentialType.Certificate => "CERTIFICATE",
        _ => throw new NotSupportedException($"Credential type {value} is not supported by the current Auth Service schema.")
    };

    private static string ToDatabaseSessionState(SessionState value) => value.ToString().ToUpperInvariant();

    private static string ToDatabaseAuditCategory(AuditEventCategory value) => value.ToString();
}

public sealed class DisabledAuthRepository :
    IIdentityRepository,
    ICredentialRepository,
    IRoleRepository,
    IPermissionRepository,
    IMembershipRepository,
    ISessionRepository,
    IAuditEventRepository,
    ITokenRepository,
    IRefreshTokenRepository,
    IServiceAccountRepository,
    ISigningKeyRepository,
    IAuthRuntimeStore
{
    public bool RuntimeAvailable => false;

    public Task<Identity?> FindById(Guid identityId, CancellationToken cancellationToken = default) => Task.FromResult<Identity?>(null);

    public Task<Identity?> FindByLoginId(LoginId loginId, CancellationToken cancellationToken = default) => Task.FromResult<Identity?>(null);

    public Task<IReadOnlyCollection<CredentialBoundary>> ListPublicCredentials(Guid identityId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<CredentialBoundary>>([]);
    }

    public Task<CredentialSecretBoundary?> FindSecretBoundary(Guid credentialId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<CredentialSecretBoundary?>(null);
    }

    public Task<IReadOnlyCollection<Role>> ListRoles(Guid identityId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<Role>>([]);
    }

    public Task<IReadOnlyCollection<string>> ListPermissions(Guid identityId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<string>>([]);
    }

    public Task<IReadOnlyCollection<Membership>> ListMemberships(Guid identityId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<Membership>>([]);
    }

    public Task<Session?> FindSession(Guid sessionId, CancellationToken cancellationToken = default) => Task.FromResult<Session?>(null);

    public Task<IReadOnlyCollection<AuditEvent>> ListByCorrelationId(string correlationId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<AuditEvent>>([]);
    }

    public Task<Session> SaveSession(Session session, CancellationToken cancellationToken = default)
    {
        throw new InvalidOperationException("Auth Service runtime persistence is disabled because DATABASE_URL is absent.");
    }

    public Task<Session?> RevokeSession(Guid sessionId, DateTimeOffset revokedAt, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<Session?>(null);
    }

    public Task<AuditEvent> AppendAuditEvent(AuditEvent auditEvent, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(auditEvent);
    }

    public Task<AccessTokenMetadata?> FindAccessTokenMetadata(Guid tokenId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<AccessTokenMetadata?>(null);
    }

    public Task<OpaqueTokenReference?> FindOpaqueReference(string referenceHash, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<OpaqueTokenReference?>(null);
    }

    public Task<AccessTokenMetadata> SaveJwtAccessToken(
        Guid tokenId,
        Guid identityId,
        Guid sessionId,
        string issuer,
        string audience,
        IReadOnlyCollection<string> scopes,
        string jwtId,
        Guid signingKeyId,
        DateTimeOffset issuedAt,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken = default)
    {
        throw new InvalidOperationException("Auth Service token persistence is disabled because DATABASE_URL is absent.");
    }

    public Task<RefreshTokenMetadata?> FindRefreshToken(Guid refreshTokenId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<RefreshTokenMetadata?>(null);
    }

    public Task<ServiceAccount?> FindByServiceName(string serviceName, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<ServiceAccount?>(null);
    }

    public Task<ServiceCredentialSecretBoundary?> FindServiceCredentialSecret(string serviceName, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<ServiceCredentialSecretBoundary?>(null);
    }

    public Task<RefreshTokenRuntimeRecord?> FindRefreshTokenByHash(string referenceHash, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<RefreshTokenRuntimeRecord?>(null);
    }

    public Task<RefreshTokenRuntimeRecord> SaveRefreshToken(
        Guid refreshTokenId,
        Guid identityId,
        Guid sessionId,
        Guid tokenId,
        Guid familyId,
        int rotationCounter,
        Guid? previousRefreshTokenId,
        string referenceHash,
        DateTimeOffset issuedAt,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken = default)
    {
        throw new InvalidOperationException("Auth Service refresh-token persistence is disabled because DATABASE_URL is absent.");
    }

    public Task<RefreshTokenRuntimeRecord?> MarkRefreshTokenRotated(Guid refreshTokenId, DateTimeOffset rotatedAt, CancellationToken cancellationToken = default)
    {
        return Task.FromResult<RefreshTokenRuntimeRecord?>(null);
    }

    public Task<int> RevokeRefreshTokensForSession(Guid sessionId, DateTimeOffset revokedAt, string reason, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(0);
    }

    public Task<int> RevokeRefreshTokenFamily(Guid familyId, DateTimeOffset revokedAt, string reason, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(0);
    }

    public Task<IReadOnlyCollection<SigningKeyMetadata>> ListSigningKeys(CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<SigningKeyMetadata>>([]);
    }

    public Task<IReadOnlyCollection<JwksKeyDescriptor>> ListPublicJwks(CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyCollection<JwksKeyDescriptor>>([]);
    }

    public Task<SigningKeyMaterial?> FindActiveSigningKey(CancellationToken cancellationToken = default)
    {
        return Task.FromResult<SigningKeyMaterial?>(null);
    }

    public Task<SigningKeyMaterial> SaveSigningKey(SigningKeyMaterial signingKey, CancellationToken cancellationToken = default)
    {
        throw new InvalidOperationException("Auth Service signing key persistence is disabled because DATABASE_URL is absent.");
    }
}
