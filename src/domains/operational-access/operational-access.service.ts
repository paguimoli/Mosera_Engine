import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import { logger } from "@/src/lib/observability/logger";
import {
  AUTHENTICATION_EVENT_TYPES,
  IDENTITY_CLASSES,
  USER_STATUSES,
} from "../auth/auth.constants";
import type { AuthContext } from "../auth/auth-context.types";
import { saveAuthAuditEvent } from "../auth/auth.repository";
import type {
  OperationalSession,
  OperationalUserInventoryItem,
} from "./operational-access.types";

type PlatformUserInventoryRow = {
  id: string;
  username: string;
  email: string;
  display_name: string;
  identity_class: string;
  status: string;
  mfa_enabled?: boolean | null;
  last_login_at?: string | null;
  last_password_change_at?: string | null;
};

type GroupMembershipRow = {
  user_id: string;
  group_id: string;
};

type UserGroupRow = {
  id: string;
  name: string;
};

type UserMfaFactorRow = {
  user_id: string;
  is_enabled: boolean;
};

type BreakGlassRow = {
  id: string;
  user_id: string;
  label: string;
  is_enabled: boolean;
  platform_users?: PlatformUserInventoryRow | PlatformUserInventoryRow[] | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at?: string | null;
  platform_users?: {
    username?: string | null;
    identity_class?: string | null;
  } | null;
};

export class OperationalAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationalAccessError";
  }
}

function logOperationalAccessQueryError(label: string, error: unknown) {
  const diagnostic =
    typeof error === "object" && error !== null
      ? (error as {
          message?: unknown;
          code?: unknown;
          details?: unknown;
          hint?: unknown;
        })
      : {};

  logger.error({
    message: "Operational access persistence query failed.",
    metadata: {
      label,
      message:
        typeof diagnostic.message === "string" ? diagnostic.message : null,
      code: typeof diagnostic.code === "string" ? diagnostic.code : null,
      details:
        typeof diagnostic.details === "string" ? diagnostic.details : null,
      hint: typeof diagnostic.hint === "string" ? diagnostic.hint : null,
    },
  });
}

function firstUser(
  value: PlatformUserInventoryRow | PlatformUserInventoryRow[] | null | undefined
) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function mapInventoryRow(
  row: PlatformUserInventoryRow,
  breakGlassByUserId: Map<string, BreakGlassRow>,
  groupsByUserId: Map<string, string[]>,
  sessionCountsByUserId: Map<
    string,
    {
      total: number;
      active: number;
    }
  >,
  mfaEnabledByUserId: Map<string, boolean>
): OperationalUserInventoryItem {
  const breakGlass = breakGlassByUserId.get(row.id) ?? null;
  const sessionCounts = sessionCountsByUserId.get(row.id) ?? {
    total: 0,
    active: 0,
  };

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    identityClass: row.identity_class,
    status: row.status,
    groups: groupsByUserId.get(row.id) ?? [],
    mfaEnabled: row.mfa_enabled ?? mfaEnabledByUserId.get(row.id) ?? false,
    lastLoginAt: row.last_login_at ?? null,
    lastPasswordChangeAt: row.last_password_change_at ?? null,
    sessionCount: sessionCounts.total,
    activeSessionCount: sessionCounts.active,
    isBreakGlass: Boolean(breakGlass) || row.identity_class === "BREAK_GLASS",
    breakGlassEnabled: breakGlass?.is_enabled ?? null,
    breakGlassLabel: breakGlass?.label ?? null,
  };
}

function mapSessionRow(row: SessionRow, now = new Date()): OperationalSession {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.platform_users?.username ?? null,
    identityClass: row.platform_users?.identity_class ?? null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null,
    isActive:
      !row.revoked_at && new Date(row.expires_at).getTime() > now.getTime(),
  };
}

export async function listOperationalUsers(): Promise<
  OperationalUserInventoryItem[]
> {
  const [
    usersResult,
    breakGlassResult,
    membershipsResult,
    groupsResult,
    sessionsResult,
    mfaFactorsResult,
  ] = await Promise.all([
    supabaseServerAdmin
      .from("platform_users")
      .select(
        "id, username, email, display_name, identity_class, status, mfa_enabled, last_login_at, last_password_change_at"
      )
      .in("identity_class", ["PLATFORM_OPERATOR", "BREAK_GLASS"])
      .order("username", { ascending: true }),
    supabaseServerAdmin
      .from("break_glass_accounts")
      .select("id, user_id, label, is_enabled"),
    supabaseServerAdmin
      .from("user_group_memberships")
      .select("user_id, group_id"),
    supabaseServerAdmin.from("user_groups").select("id, name"),
    supabaseServerAdmin
      .from("user_sessions")
      .select("id, user_id, expires_at, revoked_at"),
    supabaseServerAdmin
      .from("user_mfa_factors")
      .select("user_id, is_enabled"),
  ]);

  if (usersResult.error) {
    logOperationalAccessQueryError("platform_users", usersResult.error);
    throw new OperationalAccessError(usersResult.error.message);
  }

  if (breakGlassResult.error) {
    logOperationalAccessQueryError(
      "break_glass_accounts",
      breakGlassResult.error
    );
    throw new OperationalAccessError(breakGlassResult.error.message);
  }

  if (membershipsResult.error) {
    logOperationalAccessQueryError(
      "user_group_memberships",
      membershipsResult.error
    );
    throw new OperationalAccessError(membershipsResult.error.message);
  }

  if (groupsResult.error) {
    logOperationalAccessQueryError("user_groups", groupsResult.error);
    throw new OperationalAccessError(groupsResult.error.message);
  }

  if (sessionsResult.error) {
    logOperationalAccessQueryError("user_sessions", sessionsResult.error);
    throw new OperationalAccessError(sessionsResult.error.message);
  }

  if (mfaFactorsResult.error) {
    logOperationalAccessQueryError("user_mfa_factors", mfaFactorsResult.error);
    throw new OperationalAccessError(mfaFactorsResult.error.message);
  }

  const breakGlassByUserId = new Map(
    ((breakGlassResult.data ?? []) as BreakGlassRow[]).map((row) => [
      row.user_id,
      row,
    ])
  );
  const groupNameById = new Map(
    ((groupsResult.data ?? []) as UserGroupRow[]).map((row) => [
      row.id,
      row.name,
    ])
  );
  const groupsByUserId = new Map<string, string[]>();

  for (const membership of (membershipsResult.data ??
    []) as GroupMembershipRow[]) {
    const groupName = groupNameById.get(membership.group_id);

    if (!groupName) {
      continue;
    }

    const current = groupsByUserId.get(membership.user_id) ?? [];

    groupsByUserId.set(membership.user_id, [...current, groupName]);
  }

  const now = new Date();
  const sessionCountsByUserId = new Map<
    string,
    {
      total: number;
      active: number;
    }
  >();

  for (const session of (sessionsResult.data ?? []) as Array<
    Pick<SessionRow, "user_id" | "expires_at" | "revoked_at">
  >) {
    const current = sessionCountsByUserId.get(session.user_id) ?? {
      total: 0,
      active: 0,
    };
    const isActive =
      !session.revoked_at &&
      new Date(session.expires_at).getTime() > now.getTime();

    sessionCountsByUserId.set(session.user_id, {
      total: current.total + 1,
      active: current.active + (isActive ? 1 : 0),
    });
  }

  const mfaEnabledByUserId = new Map<string, boolean>();

  for (const factor of (mfaFactorsResult.data ?? []) as UserMfaFactorRow[]) {
    if (factor.is_enabled) {
      mfaEnabledByUserId.set(factor.user_id, true);
    }
  }

  return ((usersResult.data ?? []) as PlatformUserInventoryRow[]).map((row) =>
    mapInventoryRow(
      row,
      breakGlassByUserId,
      groupsByUserId,
      sessionCountsByUserId,
      mfaEnabledByUserId
    )
  );
}

export async function listBreakGlassAccounts(): Promise<
  OperationalUserInventoryItem[]
> {
  const { data, error } = await supabaseServerAdmin
    .from("break_glass_accounts")
    .select(
      "id, user_id, label, is_enabled, platform_users(id, username, email, display_name, identity_class, status, mfa_enabled, last_login_at, last_password_change_at)"
    )
    .order("label", { ascending: true });

  if (error) {
    throw new OperationalAccessError(error.message);
  }

  return ((data ?? []) as BreakGlassRow[])
    .map((row) => {
      const user = firstUser(row.platform_users);

      if (!user) {
        return null;
      }

      return mapInventoryRow(
        user,
        new Map([[row.user_id, row]]),
        new Map(),
        new Map(),
        new Map()
      );
    })
    .filter(
      (item): item is OperationalUserInventoryItem => Boolean(item)
    );
}

export async function listOperationalSessions(): Promise<OperationalSession[]> {
  const { data, error } = await supabaseServerAdmin
    .from("user_sessions")
    .select(
      "id, user_id, created_at, last_seen_at, expires_at, revoked_at, platform_users(username, identity_class)"
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    throw new OperationalAccessError(error.message);
  }

  return ((data ?? []) as SessionRow[]).map((row) => mapSessionRow(row));
}

export async function revokeOperationalSession({
  sessionId,
  actor,
}: {
  sessionId: string;
  actor: AuthContext;
}) {
  if (!sessionId) {
    throw new OperationalAccessError("Session id is required.");
  }

  const revokedAt = new Date().toISOString();
  const { data, error } = await supabaseServerAdmin
    .from("user_sessions")
    .update({ revoked_at: revokedAt })
    .eq("id", sessionId)
    .is("revoked_at", null)
    .select("id, user_id")
    .maybeSingle();

  if (error) {
    throw new OperationalAccessError(error.message);
  }

  if (!data) {
    throw new OperationalAccessError("Active session was not found.");
  }

  await saveAuthAuditEvent({
    userId: data.user_id,
    eventType: AUTHENTICATION_EVENT_TYPES.SESSION_REVOKED,
    metadata: {
      sessionId,
      actorUserId: actor.user.id,
      revokedAt,
    },
  });
}

export async function revokeAllOperationalSessionsForUser({
  userId,
  actor,
}: {
  userId: string;
  actor: AuthContext;
}) {
  if (!userId) {
    throw new OperationalAccessError("User id is required.");
  }

  const revokedAt = new Date().toISOString();
  const { error } = await supabaseServerAdmin
    .from("user_sessions")
    .update({ revoked_at: revokedAt })
    .eq("user_id", userId)
    .is("revoked_at", null);

  if (error) {
    throw new OperationalAccessError(error.message);
  }

  await saveAuthAuditEvent({
    userId,
    eventType: AUTHENTICATION_EVENT_TYPES.ALL_USER_SESSIONS_REVOKED,
    metadata: {
      actorUserId: actor.user.id,
      revokedAt,
    },
  });
}

function requireDifferentBreakGlassActor({
  targetUserId,
  actor,
}: {
  targetUserId: string;
  actor: AuthContext;
}) {
  if (actor.user.identityClass !== IDENTITY_CLASSES.BREAK_GLASS) {
    throw new OperationalAccessError(
      "Only an authenticated break-glass account can manage break-glass lifecycle."
    );
  }

  if (actor.user.id === targetUserId) {
    throw new OperationalAccessError(
      "A break-glass account cannot change its own lifecycle state."
    );
  }
}

async function assertBreakGlassAccountExists(userId: string) {
  const { data, error } = await supabaseServerAdmin
    .from("break_glass_accounts")
    .select("id, user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new OperationalAccessError(error.message);
  }

  if (!data) {
    throw new OperationalAccessError("Break-glass account was not found.");
  }
}

export async function disableBreakGlassAccount({
  userId,
  actor,
}: {
  userId: string;
  actor: AuthContext;
}) {
  if (!userId) {
    throw new OperationalAccessError("User id is required.");
  }

  requireDifferentBreakGlassActor({ targetUserId: userId, actor });
  await assertBreakGlassAccountExists(userId);

  const disabledAt = new Date().toISOString();
  const [{ error: breakGlassError }, { error: userError }, { error: sessionError }] =
    await Promise.all([
      supabaseServerAdmin
        .from("break_glass_accounts")
        .update({ is_enabled: false })
        .eq("user_id", userId),
      supabaseServerAdmin
        .from("platform_users")
        .update({ status: USER_STATUSES.DISABLED })
        .eq("id", userId)
        .eq("identity_class", IDENTITY_CLASSES.BREAK_GLASS),
      supabaseServerAdmin
        .from("user_sessions")
        .update({ revoked_at: disabledAt })
        .eq("user_id", userId)
        .is("revoked_at", null),
    ]);

  if (breakGlassError) {
    throw new OperationalAccessError(breakGlassError.message);
  }

  if (userError) {
    throw new OperationalAccessError(userError.message);
  }

  if (sessionError) {
    throw new OperationalAccessError(sessionError.message);
  }

  await saveAuthAuditEvent({
    userId,
    eventType: AUTHENTICATION_EVENT_TYPES.BREAK_GLASS_ACCOUNT_DISABLED,
    metadata: {
      actorUserId: actor.user.id,
      disabledAt,
    },
  });
}

export async function restoreBreakGlassAccount({
  userId,
  actor,
}: {
  userId: string;
  actor: AuthContext;
}) {
  if (!userId) {
    throw new OperationalAccessError("User id is required.");
  }

  requireDifferentBreakGlassActor({ targetUserId: userId, actor });
  await assertBreakGlassAccountExists(userId);

  const restoredAt = new Date().toISOString();
  const [{ error: breakGlassError }, { error: userError }] = await Promise.all([
    supabaseServerAdmin
      .from("break_glass_accounts")
      .update({ is_enabled: true })
      .eq("user_id", userId),
    supabaseServerAdmin
      .from("platform_users")
      .update({ status: USER_STATUSES.ACTIVE })
      .eq("id", userId)
      .eq("identity_class", IDENTITY_CLASSES.BREAK_GLASS),
  ]);

  if (breakGlassError) {
    throw new OperationalAccessError(breakGlassError.message);
  }

  if (userError) {
    throw new OperationalAccessError(userError.message);
  }

  await saveAuthAuditEvent({
    userId,
    eventType: AUTHENTICATION_EVENT_TYPES.BREAK_GLASS_ACCOUNT_RESTORED,
    metadata: {
      actorUserId: actor.user.id,
      restoredAt,
    },
  });
}
