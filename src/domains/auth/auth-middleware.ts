import { USER_STATUSES, SESSION_STATUSES } from "./auth.constants";
import type {
  AuthContext,
  AuthenticatedSession,
  AuthenticatedUser,
  SerializableAuthContext,
} from "./auth-context.types";
import { extractSessionTokenFromRequest } from "./auth-token.helpers";
import {
  findAuthorizationForUser,
  findSessionByTokenHash,
  findUserById,
} from "./auth.repository";
import type { AuthUserRecord } from "./auth.types";
import {
  getSessionStatus,
  hashSessionToken,
  verifySessionToken,
} from "./session.helpers";
import type { SessionRecord } from "./session.types";

const SYSTEM_ADMIN_PERMISSION = "system.admin";

export class AuthMiddlewareError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthMiddlewareError";
    this.status = status;
  }
}

function toAuthenticatedUser(user: AuthUserRecord): AuthenticatedUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    identityClass: user.identityClass,
    status: user.status,
    failedLoginAttempts: user.failedLoginAttempts,
    lockedUntil: user.lockedUntil ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

function toAuthenticatedSession(
  session: SessionRecord
): AuthenticatedSession {
  return {
    id: session.id,
    userId: session.userId,
    ipAddress: session.ipAddress ?? null,
    userAgent: session.userAgent ?? null,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt ?? null,
  };
}

export function serializeAuthContext(
  context: AuthContext
): SerializableAuthContext {
  return {
    user: context.user,
    session: context.session,
    groups: context.groups,
    permissions: context.permissions,
    platformScopes: context.platformScopes,
  };
}

export async function getAuthenticatedUser(
  request: Request
): Promise<AuthContext | null> {
  const sessionToken = extractSessionTokenFromRequest(request);

  if (!sessionToken) {
    return null;
  }

  const sessionTokenHash = hashSessionToken(sessionToken);
  const session = await findSessionByTokenHash(sessionTokenHash);

  if (!session) {
    return null;
  }

  if (!verifySessionToken(sessionToken, session.sessionTokenHash)) {
    return null;
  }

  if (getSessionStatus(session) !== SESSION_STATUSES.ACTIVE) {
    return null;
  }

  const user = await findUserById(session.userId);

  if (!user || user.status !== USER_STATUSES.ACTIVE) {
    return null;
  }

  const { groups, permissions } = await findAuthorizationForUser(user.id);

  return {
    user: toAuthenticatedUser(user),
    session: toAuthenticatedSession(session),
    groups,
    permissions,
    platformScopes: [],
    hasPermission(permissionKey: string) {
      return permissions.some(
        (permission) =>
          permission.key === permissionKey ||
          permission.key === SYSTEM_ADMIN_PERMISSION
      );
    },
  };
}

export async function requireAuthenticatedUser(
  request: Request
): Promise<AuthContext> {
  const context = await getAuthenticatedUser(request);

  if (!context) {
    throw new AuthMiddlewareError(401, "Authentication required.");
  }

  return context;
}

export async function requirePermission(
  request: Request,
  permissionKey: string
): Promise<AuthContext> {
  const context = await requireAuthenticatedUser(request);

  if (!context.hasPermission(permissionKey)) {
    throw new AuthMiddlewareError(403, "Permission denied.");
  }

  return context;
}
