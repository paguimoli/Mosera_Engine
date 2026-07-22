import type { AuthContext, SerializableAuthContext } from "./auth-context.types";
import { getAuthServiceContext } from "./auth-service.client";
import { extractSessionTokenFromRequest } from "./auth-token.helpers";

export class AuthMiddlewareError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthMiddlewareError";
    this.status = status;
  }
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
  return getAuthServiceContext(extractSessionTokenFromRequest(request));
}

export async function requireAuthenticatedUser(
  request: Request
): Promise<AuthContext> {
  const context = await getAuthenticatedUser(request);
  if (!context) throw new AuthMiddlewareError(401, "Authentication required.");
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
