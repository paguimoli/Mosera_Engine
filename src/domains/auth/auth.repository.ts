import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import { USER_STATUSES } from "./auth.constants";
import { isIdentityClass, isUserStatus } from "./auth.helpers";
import type {
  AuthenticatedPermission,
  AuthenticatedUserGroup,
} from "./auth-context.types";
import type {
  AuthUserRecord,
  AuthenticationEventType,
  PasswordResetToken,
} from "./auth.types";
import type {
  MfaChallenge,
  MfaChallengeTokenHash,
  MfaFactor,
} from "./mfa.types";
import type { SessionRecord, SessionTokenHash } from "./session.types";

type PlatformUserRow = {
  id: string;
  username: string;
  email: string;
  display_name: string;
  identity_class: string;
  status: string;
  password_hash?: string | null;
  mfa_enabled?: boolean | null;
  failed_login_attempts?: number | null;
  locked_until?: string | null;
  last_login_at?: string | null;
};

type UserSessionRow = {
  id: string;
  user_id: string;
  session_token_hash: string;
  ip_address?: string | null;
  user_agent?: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at?: string | null;
};

type UserGroupRow = {
  id: string;
  name: string;
  description?: string | null;
  is_system_group?: boolean | null;
  created_at: string;
  updated_at?: string | null;
};

type UserGroupMembershipRow = {
  group_id: string;
};

type UserGroupPermissionRow = {
  permission_id: string;
};

type PermissionRow = {
  id: string;
  permission_key: string;
  description?: string | null;
  category?: string | null;
  is_system_permission?: boolean | null;
  created_at: string;
  updated_at?: string | null;
};

type MfaFactorRow = {
  id: string;
  user_id: string;
  factor_type: "TOTP";
  secret_encrypted: string;
  label?: string | null;
  is_enabled: boolean;
  verified_at?: string | null;
  created_at: string;
  updated_at?: string | null;
};

type MfaChallengeRow = {
  id: string;
  user_id: string;
  challenge_token_hash: string;
  ip_address?: string | null;
  user_agent?: string | null;
  created_at: string;
  expires_at: string;
  consumed_at?: string | null;
};

type PasswordResetTokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  used_at?: string | null;
  created_at: string;
};

export type CreateSessionRecordInput = {
  userId: string;
  sessionTokenHash: SessionTokenHash;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type CreateAuthAuditEventInput = {
  userId?: string | null;
  eventType: AuthenticationEventType;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
};

export class AuthRepositoryError extends Error {
  constructor(message = "Authentication persistence operation failed.") {
    super(message);
    this.name = "AuthRepositoryError";
  }
}

function mapPlatformUserRow(row: PlatformUserRow | null): AuthUserRecord | null {
  if (!row) {
    return null;
  }

  if (!isIdentityClass(row.identity_class) || !isUserStatus(row.status)) {
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    identityClass: row.identity_class,
    status: row.status,
    passwordHash: row.password_hash ?? null,
    mfaEnabled: row.mfa_enabled ?? false,
    failedLoginAttempts: row.failed_login_attempts ?? 0,
    lockedUntil: row.locked_until ?? null,
    lastLoginAt: row.last_login_at ?? null,
  };
}

function mapUserSessionRow(row: UserSessionRow | null): SessionRecord | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    sessionTokenHash: row.session_token_hash,
    ipAddress: row.ip_address ?? null,
    userAgent: row.user_agent ?? null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null,
  };
}

function mapUserGroupRow(row: UserGroupRow): AuthenticatedUserGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    isSystemGroup: row.is_system_group ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

function mapPermissionRow(
  row: PermissionRow
): AuthenticatedPermission {
  return {
    id: row.id,
    key: row.permission_key,
    category: row.category ?? null,
    description: row.description ?? null,
    isSystemPermission: row.is_system_permission ?? true,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

function mapMfaFactorRow(row: MfaFactorRow | null): MfaFactor | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    factorType: row.factor_type,
    secretEncrypted: row.secret_encrypted,
    label: row.label ?? null,
    isEnabled: row.is_enabled,
    verifiedAt: row.verified_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

function mapMfaChallengeRow(row: MfaChallengeRow | null): MfaChallenge | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    challengeTokenHash: row.challenge_token_hash,
    ipAddress: row.ip_address ?? null,
    userAgent: row.user_agent ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? null,
  };
}

function mapPasswordResetTokenRow(
  row: PasswordResetTokenRow | null
): PasswordResetToken | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    usedAt: row.used_at ?? null,
    createdAt: row.created_at,
  };
}

export async function findUserByUsername(
  username: string
): Promise<AuthUserRecord | null> {
  const { data, error } = await supabaseServerAdmin
    .from("platform_users")
    .select(
      "id, username, email, display_name, identity_class, status, password_hash, mfa_enabled, failed_login_attempts, locked_until, last_login_at"
    )
    .eq("username", username)
    .maybeSingle();

  if (error) {
    throw new AuthRepositoryError();
  }

  return mapPlatformUserRow(data as PlatformUserRow | null);
}

export async function findUserById(
  userId: string
): Promise<AuthUserRecord | null> {
  const { data, error } = await supabaseServerAdmin
    .from("platform_users")
    .select(
      "id, username, email, display_name, identity_class, status, password_hash, mfa_enabled, failed_login_attempts, locked_until, last_login_at"
    )
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new AuthRepositoryError();
  }

  return mapPlatformUserRow(data as PlatformUserRow | null);
}

export async function findUserByIdentifier(
  identifier: string
): Promise<AuthUserRecord | null> {
  const normalizedIdentifier = identifier.trim();
  const userByUsername = await findUserByUsername(normalizedIdentifier);

  if (userByUsername) {
    return userByUsername;
  }

  const { data, error } = await supabaseServerAdmin
    .from("platform_users")
    .select(
      "id, username, email, display_name, identity_class, status, password_hash, mfa_enabled, failed_login_attempts, locked_until, last_login_at"
    )
    .eq("email", normalizedIdentifier)
    .maybeSingle();

  if (error) {
    throw new AuthRepositoryError();
  }

  return mapPlatformUserRow(data as PlatformUserRow | null);
}

export async function saveUserSession(
  input: CreateSessionRecordInput
): Promise<SessionRecord> {
  const { data, error } = await supabaseServerAdmin
    .from("user_sessions")
    .insert({
      user_id: input.userId,
      session_token_hash: input.sessionTokenHash,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
      created_at: input.createdAt,
      last_seen_at: input.lastSeenAt,
      expires_at: input.expiresAt,
      revoked_at: null,
    })
    .select(
      "id, user_id, session_token_hash, ip_address, user_agent, created_at, last_seen_at, expires_at, revoked_at"
    )
    .single();

  if (error) {
    throw new AuthRepositoryError();
  }

  const session = mapUserSessionRow(data as UserSessionRow | null);

  if (!session) {
    throw new AuthRepositoryError();
  }

  return session;
}

export async function findSessionByTokenHash(
  sessionTokenHash: SessionTokenHash
): Promise<SessionRecord | null> {
  const { data, error } = await supabaseServerAdmin
    .from("user_sessions")
    .select(
      "id, user_id, session_token_hash, ip_address, user_agent, created_at, last_seen_at, expires_at, revoked_at"
    )
    .eq("session_token_hash", sessionTokenHash)
    .maybeSingle();

  if (error) {
    throw new AuthRepositoryError();
  }

  return mapUserSessionRow(data as UserSessionRow | null);
}

export async function findGroupsForUser(
  userId: string
): Promise<AuthenticatedUserGroup[]> {
  const { data: membershipData, error: membershipError } =
    await supabaseServerAdmin
      .from("user_group_memberships")
      .select("group_id")
      .eq("user_id", userId);

  if (membershipError) {
    throw new AuthRepositoryError();
  }

  const memberships = (membershipData ?? []) as UserGroupMembershipRow[];
  const groupIds = memberships.map((membership) => membership.group_id);

  if (groupIds.length === 0) {
    return [];
  }

  const { data: groupData, error: groupError } = await supabaseServerAdmin
    .from("user_groups")
    .select("id, name, description, is_system_group, created_at, updated_at")
    .in("id", groupIds);

  if (groupError) {
    throw new AuthRepositoryError();
  }

  return ((groupData ?? []) as UserGroupRow[]).map(mapUserGroupRow);
}

export async function findPermissionsForUser(
  userId: string
): Promise<AuthenticatedPermission[]> {
  const groups = await findGroupsForUser(userId);
  const groupIds = groups.map((group) => group.id);

  if (groupIds.length === 0) {
    return [];
  }

  const { data: assignmentData, error: assignmentError } =
    await supabaseServerAdmin
      .from("user_group_permissions")
      .select("permission_id")
      .in("group_id", groupIds);

  if (assignmentError) {
    throw new AuthRepositoryError();
  }

  const permissionIds = Array.from(
    new Set(
      ((assignmentData ?? []) as UserGroupPermissionRow[]).map(
        (assignment) => assignment.permission_id
      )
    )
  );

  if (permissionIds.length === 0) {
    return [];
  }

  const { data, error } = await supabaseServerAdmin
    .from("permissions")
    .select(
      "id, permission_key, description, category, is_system_permission, created_at, updated_at"
    )
    .in("id", permissionIds);

  if (error) {
    throw new AuthRepositoryError();
  }

  return ((data ?? []) as PermissionRow[]).map(mapPermissionRow);
}

export async function incrementFailedLoginAttempts(
  userId: string
): Promise<number> {
  const user = await findUserById(userId);

  if (!user) {
    throw new AuthRepositoryError();
  }

  const failedLoginAttempts = user.failedLoginAttempts + 1;
  const { error } = await supabaseServerAdmin
    .from("platform_users")
    .update({ failed_login_attempts: failedLoginAttempts })
    .eq("id", userId);

  if (error) {
    throw new AuthRepositoryError();
  }

  return failedLoginAttempts;
}

export async function lockUser(
  userId: string,
  lockedUntil: string
): Promise<void> {
  const { error } = await supabaseServerAdmin
    .from("platform_users")
    .update({
      status: USER_STATUSES.LOCKED,
      locked_until: lockedUntil,
    })
    .eq("id", userId);

  if (error) {
    throw new AuthRepositoryError();
  }
}

export async function resetFailedLoginState(userId: string): Promise<void> {
  const { error } = await supabaseServerAdmin
    .from("platform_users")
    .update({
      failed_login_attempts: 0,
      locked_until: null,
      status: USER_STATUSES.ACTIVE,
    })
    .eq("id", userId);

  if (error) {
    throw new AuthRepositoryError();
  }
}

export async function unlockExpiredLock(userId: string): Promise<void> {
  await resetFailedLoginState(userId);
}

export async function updateLastLoginAt(
  userId: string,
  lastLoginAt: string
): Promise<void> {
  const { error } = await supabaseServerAdmin
    .from("platform_users")
    .update({ last_login_at: lastLoginAt })
    .eq("id", userId);

  if (error) {
    throw new AuthRepositoryError();
  }
}

export async function updateUserPasswordHash({
  userId,
  passwordHash,
  changedAt,
}: {
  userId: string;
  passwordHash: string;
  changedAt: string;
}): Promise<void> {
  const { error } = await supabaseServerAdmin
    .from("platform_users")
    .update({
      password_hash: passwordHash,
      last_password_change_at: changedAt,
      failed_login_attempts: 0,
      locked_until: null,
      status: USER_STATUSES.ACTIVE,
    })
    .eq("id", userId);

  if (error) {
    throw new AuthRepositoryError();
  }
}

export async function saveAuthAuditEvent(
  input: CreateAuthAuditEventInput
): Promise<void> {
  const { error } = await supabaseServerAdmin.from("auth_audit_log").insert({
    user_id: input.userId ?? null,
    event_type: input.eventType,
    ip_address: input.ipAddress ?? null,
    metadata: input.metadata ?? {},
  });

  if (error) {
    throw new AuthRepositoryError();
  }
}

export async function createPasswordResetToken(
  userId: string,
  tokenHash: string,
  expiresAt: string
): Promise<PasswordResetToken> {
  const { data, error } = await supabaseServerAdmin
    .from("password_reset_tokens")
    .insert({
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      used_at: null,
    })
    .select("id, user_id, token_hash, expires_at, used_at, created_at")
    .single();

  if (error) {
    throw new AuthRepositoryError();
  }

  const token = mapPasswordResetTokenRow(
    data as PasswordResetTokenRow | null
  );

  if (!token) {
    throw new AuthRepositoryError();
  }

  return token;
}

export async function findPasswordResetTokenByHash(
  tokenHash: string
): Promise<PasswordResetToken | null> {
  const { data, error } = await supabaseServerAdmin
    .from("password_reset_tokens")
    .select("id, user_id, token_hash, expires_at, used_at, created_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    throw new AuthRepositoryError();
  }

  return mapPasswordResetTokenRow(data as PasswordResetTokenRow | null);
}

export async function markPasswordResetTokenUsed(
  tokenId: string,
  usedAt = new Date().toISOString()
): Promise<void> {
  const { data, error } = await supabaseServerAdmin
    .from("password_reset_tokens")
    .update({ used_at: usedAt })
    .eq("id", tokenId)
    .is("used_at", null)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    throw new AuthRepositoryError();
  }
}

export async function revokeUnusedPasswordResetTokensForUser(
  userId: string,
  usedAt = new Date().toISOString()
): Promise<void> {
  const { error } = await supabaseServerAdmin
    .from("password_reset_tokens")
    .update({ used_at: usedAt })
    .eq("user_id", userId)
    .is("used_at", null);

  if (error) {
    throw new AuthRepositoryError();
  }
}

export async function createOrReplaceTotpFactor(
  userId: string,
  secretEncrypted: string
): Promise<MfaFactor> {
  const { data, error } = await supabaseServerAdmin
    .from("user_mfa_factors")
    .upsert(
      {
        user_id: userId,
        factor_type: "TOTP",
        secret_encrypted: secretEncrypted,
        label: "Authenticator app",
        is_enabled: false,
        verified_at: null,
      },
      { onConflict: "user_id,factor_type" }
    )
    .select(
      "id, user_id, factor_type, secret_encrypted, label, is_enabled, verified_at, created_at, updated_at"
    )
    .single();

  if (error) {
    throw new AuthRepositoryError();
  }

  const factor = mapMfaFactorRow(data as MfaFactorRow | null);

  if (!factor) {
    throw new AuthRepositoryError();
  }

  return factor;
}

export async function getTotpFactorByUserId(
  userId: string
): Promise<MfaFactor | null> {
  const { data, error } = await supabaseServerAdmin
    .from("user_mfa_factors")
    .select(
      "id, user_id, factor_type, secret_encrypted, label, is_enabled, verified_at, created_at, updated_at"
    )
    .eq("user_id", userId)
    .eq("factor_type", "TOTP")
    .maybeSingle();

  if (error) {
    throw new AuthRepositoryError();
  }

  return mapMfaFactorRow(data as MfaFactorRow | null);
}

export async function enableTotpFactor(userId: string): Promise<void> {
  const verifiedAt = new Date().toISOString();
  const { error: factorError } = await supabaseServerAdmin
    .from("user_mfa_factors")
    .update({
      is_enabled: true,
      verified_at: verifiedAt,
    })
    .eq("user_id", userId)
    .eq("factor_type", "TOTP");

  if (factorError) {
    throw new AuthRepositoryError();
  }

  const { error: userError } = await supabaseServerAdmin
    .from("platform_users")
    .update({ mfa_enabled: true })
    .eq("id", userId);

  if (userError) {
    throw new AuthRepositoryError();
  }
}

export async function disableTotpFactor(userId: string): Promise<void> {
  const { error: factorError } = await supabaseServerAdmin
    .from("user_mfa_factors")
    .update({
      is_enabled: false,
      verified_at: null,
    })
    .eq("user_id", userId)
    .eq("factor_type", "TOTP");

  if (factorError) {
    throw new AuthRepositoryError();
  }

  const { error: userError } = await supabaseServerAdmin
    .from("platform_users")
    .update({ mfa_enabled: false })
    .eq("id", userId);

  if (userError) {
    throw new AuthRepositoryError();
  }
}

export async function createMfaChallenge({
  userId,
  tokenHash,
  expiresAt,
  ipAddress,
  userAgent,
}: {
  userId: string;
  tokenHash: MfaChallengeTokenHash;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<MfaChallenge> {
  const { data, error } = await supabaseServerAdmin
    .from("auth_mfa_challenges")
    .insert({
      user_id: userId,
      challenge_token_hash: tokenHash,
      ip_address: ipAddress ?? null,
      user_agent: userAgent ?? null,
      expires_at: expiresAt,
      consumed_at: null,
    })
    .select(
      "id, user_id, challenge_token_hash, ip_address, user_agent, created_at, expires_at, consumed_at"
    )
    .single();

  if (error) {
    throw new AuthRepositoryError();
  }

  const challenge = mapMfaChallengeRow(data as MfaChallengeRow | null);

  if (!challenge) {
    throw new AuthRepositoryError();
  }

  return challenge;
}

export async function findMfaChallengeByTokenHash(
  tokenHash: MfaChallengeTokenHash
): Promise<MfaChallenge | null> {
  const { data, error } = await supabaseServerAdmin
    .from("auth_mfa_challenges")
    .select(
      "id, user_id, challenge_token_hash, ip_address, user_agent, created_at, expires_at, consumed_at"
    )
    .eq("challenge_token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    throw new AuthRepositoryError();
  }

  return mapMfaChallengeRow(data as MfaChallengeRow | null);
}

export async function consumeMfaChallenge(challengeId: string): Promise<void> {
  const { data, error } = await supabaseServerAdmin
    .from("auth_mfa_challenges")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", challengeId)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    throw new AuthRepositoryError();
  }
}

export async function deleteExpiredMfaChallenges(
  now = new Date().toISOString()
): Promise<void> {
  const { error } = await supabaseServerAdmin
    .from("auth_mfa_challenges")
    .delete()
    .lt("expires_at", now);

  if (error) {
    throw new AuthRepositoryError();
  }
}

export async function revokeActiveSessionsForUser(
  userId: string,
  revokedAt: string
): Promise<void> {
  const { error } = await supabaseServerAdmin
    .from("user_sessions")
    .update({ revoked_at: revokedAt })
    .eq("user_id", userId)
    .is("revoked_at", null)
    .gt("expires_at", revokedAt);

  if (error) {
    throw new AuthRepositoryError();
  }
}

export async function revokeSessionById(
  sessionId: string,
  revokedAt: string
): Promise<void> {
  const { error } = await supabaseServerAdmin
    .from("user_sessions")
    .update({ revoked_at: revokedAt })
    .eq("id", sessionId)
    .is("revoked_at", null);

  if (error) {
    throw new AuthRepositoryError();
  }
}

export async function markBreakGlassAccountUsed(
  userId: string,
  usedAt: string
): Promise<void> {
  const { error } = await supabaseServerAdmin
    .from("break_glass_accounts")
    .update({ last_used_at: usedAt })
    .eq("user_id", userId);

  if (error) {
    throw new AuthRepositoryError();
  }
}
