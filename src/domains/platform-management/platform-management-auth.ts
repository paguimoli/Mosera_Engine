import type { AuthContext } from "@/src/domains/auth/auth-context.types";
import { AuthMiddlewareError, requirePermission } from "@/src/domains/auth/auth-middleware";
import { extractSessionTokenFromRequest } from "@/src/domains/auth/auth-token.helpers";
import { isAuthServiceProviderEnabled } from "@/src/domains/auth/auth-provider";
import { getAuthServiceContext } from "@/src/domains/auth/auth-service.client";
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
  const permissions = new Set(context.permissions.map((permission) => permission.key));

  return {
    permissions,
    scopes: context.platformScopes ?? [],
    superAdmin: context.hasPermission("system.admin"),
  };
}

function normalizeScope(scope: PlatformManagementScope) {
  return {
    scopeType: scope.scopeType.trim().toUpperCase(),
    scopeId: scope.scopeId.trim().toLowerCase(),
  };
}

function hasScope(
  authorization: PlatformManagementAuthorization,
  scopeType: string,
  scopeId?: string | null
) {
  const normalizedType = scopeType.toUpperCase();
  const normalizedId = scopeId?.toLowerCase();

  return authorization.scopes.map(normalizeScope).some((scope) => {
    if (scope.scopeType !== normalizedType) {
      return false;
    }

    return !normalizedId || scope.scopeId === normalizedId || scope.scopeId === "*";
  });
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

  if (hasScope(authorization, "GLOBAL", "platform") || hasScope(authorization, "GLOBAL", "*")) {
    if (resource === "organizations" && action === "create") {
      throw new PlatformManagementAuthorizationError(
        403,
        "Organization creation requires Super Admin scope."
      );
    }

    return;
  }

  if (!scope) {
    throw new PlatformManagementAuthorizationError(403, "Platform scope is required.");
  }

  if (
    scope.marketId &&
    hasScope(authorization, "MARKET", scope.marketId)
  ) {
    return;
  }

  if (
    scope.brandId &&
    hasScope(authorization, "BRAND", scope.brandId)
  ) {
    return;
  }

  if (
    scope.tenantId &&
    hasScope(authorization, "TENANT", scope.tenantId)
  ) {
    return;
  }

  if (
    scope.organizationId &&
    hasScope(authorization, "ORGANIZATION", scope.organizationId)
  ) {
    if (resource === "organizations" && action === "create") {
      throw new PlatformManagementAuthorizationError(
        403,
        "Organization creation requires Super Admin scope."
      );
    }

    return;
  }

  throw new PlatformManagementAuthorizationError(403, "Platform scope denied.");
}
