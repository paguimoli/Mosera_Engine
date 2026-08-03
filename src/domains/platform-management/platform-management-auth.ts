import { randomUUID } from "node:crypto";

import type { AuthContext } from "@/src/domains/auth/auth-context.types";
import { AuthMiddlewareError, requirePermission } from "@/src/domains/auth/auth-middleware";
import { extractSessionTokenFromRequest } from "@/src/domains/auth/auth-token.helpers";
import { isAuthServiceProviderEnabled } from "@/src/domains/auth/auth-provider";
import { getAuthServiceContext } from "@/src/domains/auth/auth-service.client";
import {
  resolveCanonicalScope,
} from "@/src/domains/scope/canonical-scope-resolver";
import type {
  PlatformResourceName,
  PlatformResourceScopeSnapshot,
} from "./platform-management.repository";

export type PlatformManagementAction = "read" | "create";

type PlatformManagementAuthOverride = {
  readonly permissions: ReadonlySet<string>;
  readonly scopes: readonly PlatformManagementScope[];
};

type PlatformManagementAuthOverrideInput =
  | readonly string[]
  | {
      readonly permissions: readonly string[];
      readonly scopes?: readonly PlatformManagementScope[];
    };

export type PlatformManagementScope = {
  readonly scopeType: string;
  readonly scopeId: string;
};

export type PlatformManagementAuthorization = {
  readonly permissions: ReadonlySet<string>;
  readonly scopes: readonly PlatformManagementScope[];
  readonly superAdmin: boolean;
  readonly actorId: string;
  readonly sessionId: string | null;
  readonly authContext: AuthContext;
};

const platformManagementPermissions: Record<
  PlatformResourceName,
  Record<PlatformManagementAction, string>
> = {
  organizations: {
    read: "platform.organization.read",
    create: "platform.organization.create",
  },
  tenants: {
    read: "platform.tenant.read",
    create: "platform.tenant.create",
  },
  brands: {
    read: "platform.brand.read",
    create: "platform.brand.create",
  },
  markets: {
    read: "platform.market.read",
    create: "platform.market.create",
  },
  websites: {
    read: "platform.website.read",
    create: "platform.website.create",
  },
  domains: {
    read: "platform.domain.read",
    create: "platform.domain.create",
  },
  themes: {
    read: "platform.theme.read",
    create: "platform.theme.create",
  },
  "brand-assets": {
    read: "platform.asset.read",
    create: "platform.asset.create",
  },
  "game-availability": {
    read: "platform.game_availability.read",
    create: "platform.game_availability.create",
  },
};

let authOverride: PlatformManagementAuthOverride | null = null;

export function getPlatformManagementPermission(
  resource: PlatformResourceName,
  action: PlatformManagementAction
) {
  return platformManagementPermissions[resource][action];
}

export async function requirePlatformManagementPermission(
  request: Request,
  resource: PlatformResourceName,
  action: PlatformManagementAction
): Promise<PlatformManagementAuthorization> {
  const permission = getPlatformManagementPermission(resource, action);

  if (authOverride) {
    if (
      authOverride.permissions.has(permission) ||
      authOverride.permissions.has("system.admin")
    ) {
      return {
        permissions: authOverride.permissions,
        scopes: authOverride.scopes,
        superAdmin: authOverride.permissions.has("system.admin"),
        actorId: "platform-management-qa",
        sessionId: null,
        authContext: {
          user: {
            id: "platform-management-qa",
            username: "platform-management-qa",
            email: "qa@local.invalid",
            displayName: "Platform Management QA",
            identityClass: "PLATFORM_OPERATOR",
            status: "ACTIVE",
            failedLoginAttempts: 0,
          },
          session: {
            id: "platform-management-qa-session",
            userId: "platform-management-qa",
            createdAt: new Date(0).toISOString(),
            lastSeenAt: new Date(0).toISOString(),
            expiresAt: new Date(8640000000000000).toISOString(),
          },
          groups: [],
          permissions: [...authOverride.permissions].map((key) => ({
            id: key,
            key,
            isSystemPermission: false,
            createdAt: new Date(0).toISOString(),
          })),
          platformScopes: [...authOverride.scopes],
          hasPermission: (key) => authOverride?.permissions.has(key) ?? false,
        },
      };
    }

    throw new PlatformManagementAuthorizationError(403, "Permission denied.");
  }

  const context = isAuthServiceProviderEnabled()
    ? await getAuthServiceContext(extractSessionTokenFromRequest(request))
    : await requirePermission(request, permission);

  if (!context) {
    throw new AuthMiddlewareError(401, "Authentication required.");
  }

  if (!context.hasPermission(permission)) {
    throw new AuthMiddlewareError(403, "Permission denied.");
  }

  return authorizationFromContext(context);
}

export async function requirePlatformGameAvailabilityResolutionPermission(
  request: Request
) {
  return requirePlatformManagementPermission(request, "game-availability", "read");
}

export class PlatformManagementAuthorizationError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "PlatformManagementAuthorizationError";
    this.status = status;
  }
}

export function setPlatformManagementAuthOverrideForTesting(
  input: PlatformManagementAuthOverrideInput | null
) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Platform management auth override is unavailable in production.");
  }

  const permissions = isPlatformManagementPermissionList(input)
    ? input
    : input?.permissions;
  const scopes = isPlatformManagementPermissionList(input) ? [] : input?.scopes ?? [];

  authOverride = permissions
    ? {
        permissions: new Set(permissions),
        scopes,
      }
    : null;
}

function isPlatformManagementPermissionList(
  input: PlatformManagementAuthOverrideInput | null
): input is readonly string[] {
  return Array.isArray(input);
}

function authorizationFromContext(context: AuthContext): PlatformManagementAuthorization {
  const resolved = resolveCanonicalScope(context);
  const permissions = new Set(resolved.permissions);

  return {
    permissions,
    scopes: resolved.claims,
    superAdmin: resolved.permissions.includes("system.admin"),
    actorId: resolved.identityId,
    sessionId: resolved.sessionId,
    authContext: context,
  };
}

export function withPlatformMutationAudit(
  input: Record<string, unknown>,
  request: Request,
  authorization: PlatformManagementAuthorization,
  resource: PlatformResourceName,
  action: PlatformManagementAction | string,
  scope: PlatformResourceScopeSnapshot | null
) {
  const requestId =
    request.headers.get("x-request-id")?.trim() ||
    request.headers.get("x-correlation-id")?.trim() ||
    randomUUID();
  const suppliedAudit =
    input.auditMetadata && typeof input.auditMetadata === "object"
      ? (input.auditMetadata as Record<string, unknown>)
      : {};

  return {
    ...input,
    lifecycleOperator: authorization.actorId,
    operator: authorization.actorId,
    auditMetadata: {
      ...suppliedAudit,
      actorId: authorization.actorId,
      sessionId: authorization.sessionId,
      permission: getPlatformManagementPermission(resource, action === "read" ? "read" : "create"),
      canonicalScope: scope ?? {},
      requestId,
      correlationId: request.headers.get("x-correlation-id")?.trim() || requestId,
      source: "platform-management-api",
    },
  };
}

export function assertPlatformResourceScope(
  authorization: PlatformManagementAuthorization,
  resource: PlatformResourceName,
  action: PlatformManagementAction,
  scope: PlatformResourceScopeSnapshot | null
) {
  if (authorization.superAdmin) {
    return;
  }

  const resolved = resolveCanonicalScope(
    {
      identityId: authorization.actorId,
      sessionId: authorization.sessionId ?? "platform-management-override",
      roles: [],
      permissions: [...authorization.permissions],
      claims: authorization.scopes,
    },
    scope ?? {}
  );

  if (
    resolved.matchedClaim?.scopeType === "GLOBAL" &&
    (resolved.matchedClaim.scopeId === "platform" ||
      resolved.matchedClaim.scopeId === "*")
  ) {
    if (resource === "organizations" && action === "create") {
      throw new PlatformManagementAuthorizationError(
        403,
        "Organization creation requires Super Admin scope."
      );
    }

    return;
  }

  if (!scope || !resolved.targetBound) {
    throw new PlatformManagementAuthorizationError(403, "Platform scope is required.");
  }
  if (!resolved.authorized) {
    throw new PlatformManagementAuthorizationError(403, "Platform scope denied.");
  }

  if (resource === "organizations" && action === "create") {
    throw new PlatformManagementAuthorizationError(
      403,
      "Organization creation requires Super Admin scope."
    );
  }
}
