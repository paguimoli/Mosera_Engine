import { randomUUID } from "node:crypto";

import {
  IDENTITY_CLASSES,
  SESSION_STATUSES,
  USER_STATUSES,
} from "./auth.constants";
import type {
  AuthContext,
  AuthenticatedUserGroup,
  AuthenticatedPermission,
  SerializableAuthContext,
} from "./auth-context.types";
import { getAuthServiceUrl } from "./auth-provider";
import type {
  LoginResponse,
  LoginSuccessResponse,
  LogoutResponse,
  SessionToken,
} from "./auth.types";

const REQUEST_TIMEOUT_MS = 2500;
const SYSTEM_ADMIN_PERMISSION = "system.admin";

type AuthServiceIdentity = {
  identityId: string;
  loginId: string;
  identityType: string;
  lifecycleState: string;
};

type AuthServiceSession = {
  sessionId: string;
  identityId: string;
  state: string;
  policyCode: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
};

type AuthServiceLoginSuccess = {
  success: true;
  sessionToken?: string;
  session: AuthServiceSession;
  identity: AuthServiceIdentity;
  accessToken?: string | null;
  tokenType?: string;
  accessTokenExpiresAt?: string | null;
  accessTokenKeyId?: string | null;
  accessTokenJwtId?: string | null;
  refreshToken?: string | null;
  refreshTokenId?: string | null;
  refreshTokenExpiresAt?: string | null;
};

type AuthServiceGroup = {
  id?: string;
  name?: string;
  code?: string;
  displayName?: string;
  isSystemGroup?: boolean;
  systemRole?: boolean;
};

type AuthServicePermission =
  | string
  | {
      id?: string;
      key?: string;
      value?: string;
      description?: string | null;
      isSystemPermission?: boolean;
    };

type AuthServiceContextResponse = {
  success: true;
  session: AuthServiceSession;
  identity: AuthServiceIdentity;
  roles?: AuthServiceGroup[];
  groups?: AuthServiceGroup[];
  permissions?: AuthServicePermission[];
  claims?: Array<{ type?: string; value?: string; scopeType?: string; scopeId?: string }>;
  memberships?: Array<{ scopeType?: string; scopeId?: string }>;
};

type AuthServiceFailure = {
  success: false;
  error?: string;
};

export class AuthServiceClientError extends Error {
  constructor(message = "Auth Service request failed.") {
    super(message);
    this.name = "AuthServiceClientError";
  }
}

function withTimeout(signal?: AbortSignal | null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return {
    signal: controller.signal,
    done() {
      clearTimeout(timeout);
    },
  };
}

async function requestJson<T>(
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: T | null }> {
  const timeout = withTimeout(init?.signal);

  try {
    const response = await fetch(`${getAuthServiceUrl()}${path}`, {
      ...init,
      signal: timeout.signal,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    });
    const text = await response.text();
    let body: T | null = null;

    try {
      body = text ? (JSON.parse(text) as T) : null;
    } catch {
      body = null;
    }

    return { status: response.status, body };
  } catch (error) {
    throw new AuthServiceClientError(
      error instanceof Error ? error.message : "Auth Service request failed."
    );
  } finally {
    timeout.done();
  }
}

function mapIdentityClass(identityType: string) {
  switch (identityType.toLowerCase()) {
    case "admin":
    case "operator":
      return IDENTITY_CLASSES.PLATFORM_OPERATOR;
    case "player":
      return IDENTITY_CLASSES.PLAYER;
    case "apiclient":
    case "api_client":
    case "serviceaccount":
    case "service_account":
      return IDENTITY_CLASSES.SYSTEM_SERVICE;
    default:
      return IDENTITY_CLASSES.HIERARCHY_PARTICIPANT;
  }
}

function toAuthContext(
  identity: AuthServiceIdentity,
  session: AuthServiceSession,
  groups: AuthenticatedUserGroup[] = [],
  permissions: AuthenticatedPermission[] = [],
  platformScopes: Array<{ scopeType: string; scopeId: string }> = []
): AuthContext {
  return {
    user: {
      id: identity.identityId,
      username: identity.loginId,
      email: identity.loginId.includes("@") ? identity.loginId : "",
      displayName: identity.loginId,
      identityClass: mapIdentityClass(identity.identityType),
      status: USER_STATUSES.ACTIVE,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
    },
    session: {
      id: session.sessionId,
      userId: session.identityId,
      ipAddress: null,
      userAgent: null,
      createdAt: session.createdAt,
      lastSeenAt: session.createdAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt ?? null,
    },
    groups,
    permissions,
    platformScopes,
    hasPermission(permissionKey: string) {
      return permissions.some(
        (permission) =>
          permission.key === permissionKey ||
          permission.key === SYSTEM_ADMIN_PERMISSION
      );
    },
  };
}

function mapGroup(group: AuthServiceGroup, index: number): AuthenticatedUserGroup {
  const code = group.code ?? group.id ?? group.name ?? `auth-service-group-${index}`;
  const name = group.name ?? group.displayName ?? code;

  return {
    id: code,
    name,
    description: null,
    isSystemGroup: Boolean(group.isSystemGroup ?? group.systemRole),
    createdAt: new Date(0).toISOString(),
    updatedAt: null,
  };
}

function mapPermission(permission: AuthServicePermission, index: number): AuthenticatedPermission | null {
  const key =
    typeof permission === "string"
      ? permission
      : permission.key ?? permission.value ?? permission.id;

  if (!key) {
    return null;
  }

  return {
    id: typeof permission === "string" ? key : permission.id ?? key,
    key,
    category: key.includes(".") ? key.split(".").at(0) ?? null : null,
    description: typeof permission === "string" ? null : permission.description ?? null,
    isSystemPermission:
      typeof permission === "string"
        ? key.startsWith("system.")
        : Boolean(permission.isSystemPermission ?? key.startsWith("system.")),
    createdAt: new Date(index).toISOString(),
    updatedAt: null,
  };
}

function mapPermissionClaims(claims: AuthServiceContextResponse["claims"]): AuthenticatedPermission[] {
  return (claims ?? [])
    .filter((claim) => claim.type?.toLowerCase() === "permission" && claim.value)
    .map((claim, index) => mapPermission(claim.value!, index))
    .filter((permission): permission is AuthenticatedPermission => permission !== null);
}

function mapPlatformScopes(response: AuthServiceContextResponse) {
  const memberships = (response.memberships ?? [])
    .filter((membership) => membership.scopeType && membership.scopeId)
    .map((membership) => ({
      scopeType: membership.scopeType!,
      scopeId: membership.scopeId!,
    }));

  const claimScopes = (response.claims ?? [])
    .filter(
      (claim) =>
        claim.type?.toLowerCase() === "platform_scope" &&
        claim.scopeType &&
        claim.scopeId
    )
    .map((claim) => ({
      scopeType: claim.scopeType!,
      scopeId: claim.scopeId!,
    }));

  const scopesByKey = new Map<string, { scopeType: string; scopeId: string }>();
  for (const scope of [...memberships, ...claimScopes]) {
    scopesByKey.set(
      `${scope.scopeType.toUpperCase()}:${scope.scopeId.toLowerCase()}`,
      scope
    );
  }

  return [...scopesByKey.values()];
}

export async function loginWithAuthService({
  username,
  password,
  ipAddress,
  userAgent,
}: {
  username: string;
  password: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<LoginResponse> {
  try {
    const response = await requestJson<AuthServiceLoginSuccess | AuthServiceFailure>(
      "/api/auth-service/login",
      {
        method: "POST",
        headers: {
          ...(ipAddress ? { "x-forwarded-for": ipAddress } : {}),
          ...(userAgent ? { "user-agent": userAgent } : {}),
        },
        body: JSON.stringify({
          loginId: username,
          password,
          correlationId: `nextjs-login-${randomUUID()}`,
        }),
      }
    );

    if (response.status !== 200 || response.body?.success !== true) {
      return { success: false, error: "Invalid username or password." };
    }

    return {
      success: true,
      sessionToken: (response.body.sessionToken ?? response.body.session.sessionId) as SessionToken,
      expiresAt: response.body.session.expiresAt,
      accessToken: response.body.accessToken ?? null,
      tokenType: response.body.tokenType === "Bearer" ? "Bearer" : undefined,
      accessTokenExpiresAt: response.body.accessTokenExpiresAt ?? null,
      accessTokenKeyId: response.body.accessTokenKeyId ?? null,
      accessTokenJwtId: response.body.accessTokenJwtId ?? null,
      refreshToken: response.body.refreshToken ?? null,
      refreshTokenId: response.body.refreshTokenId ?? null,
      refreshTokenExpiresAt: response.body.refreshTokenExpiresAt ?? null,
    } satisfies LoginSuccessResponse;
  } catch {
    return { success: false, error: "Authentication service unavailable." };
  }
}

export async function logoutWithAuthService(
  sessionToken?: string | null
): Promise<LogoutResponse> {
  if (!sessionToken) {
    return { success: true };
  }

  try {
    await requestJson<unknown>("/api/auth-service/authority/logout", {
      method: "POST",
      body: JSON.stringify({
        sessionToken,
        correlationId: `nextjs-logout-${randomUUID()}`,
      }),
    });
  } catch {
    // Logout stays idempotent for callers, matching the legacy route.
  }

  return { success: true };
}

export async function requestPasswordResetWithAuthService(input: {
  identifier: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  return requestJson<{ success: boolean; message: string; resetToken?: string | null }>(
    "/api/auth-service/authority/password-reset/request",
    {
      method: "POST",
      headers: {
        ...(input.ipAddress ? { "x-forwarded-for": input.ipAddress } : {}),
        ...(input.userAgent ? { "user-agent": input.userAgent } : {}),
      },
      body: JSON.stringify({
        identifier: input.identifier,
        correlationId: `nextjs-password-reset-${randomUUID()}`,
      }),
    }
  );
}

export async function confirmPasswordResetWithAuthService(input: {
  resetToken: string;
  newPassword: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  return requestJson<{ success: boolean; errors?: string[] }>(
    "/api/auth-service/authority/password-reset/confirm",
    {
      method: "POST",
      headers: {
        ...(input.ipAddress ? { "x-forwarded-for": input.ipAddress } : {}),
        ...(input.userAgent ? { "user-agent": input.userAgent } : {}),
      },
      body: JSON.stringify({
        resetToken: input.resetToken,
        newPassword: input.newPassword,
        correlationId: `nextjs-password-reset-confirm-${randomUUID()}`,
      }),
    }
  );
}

export async function delegateMfaMutationToAuthService(
  operation: string,
  body: unknown
) {
  return requestJson<{ success: boolean; error?: string }>(
    `/api/auth-service/authority/mfa/${encodeURIComponent(operation)}`,
    { method: "POST", body: JSON.stringify(body ?? {}) }
  );
}

export async function transitionIdentityWithAuthService(input: {
  identityId: string;
  expectedStatus: "Active" | "Disabled" | "Locked" | "Compromised" | "Emergency" | "Deleted";
  targetStatus: "Active" | "Disabled" | "Locked" | "Compromised" | "Emergency" | "Deleted";
  actorIdentityId: string;
  reason: string;
}) {
  return requestJson<{ success: boolean; error?: string }>(
    "/api/auth-service/authority/lifecycle",
    {
      method: "POST",
      body: JSON.stringify({ ...input, correlationId: `nextjs-lifecycle-${randomUUID()}` }),
    }
  );
}

export async function revokeAllSessionsWithAuthService(input: {
  identityId: string;
  actorIdentityId: string;
  reason: string;
}) {
  return requestJson<{ success: boolean; revoked?: number; error?: string }>(
    "/api/auth-service/authority/logout-all",
    {
      method: "POST",
      body: JSON.stringify({ ...input, correlationId: `nextjs-logout-all-${randomUUID()}` }),
    }
  );
}

export async function revokeSessionWithAuthService(input: {
  sessionId: string;
  identityId: string;
  actorIdentityId: string;
  reason: string;
}) {
  return requestJson<{ success: boolean; revoked?: number; error?: string }>(
    "/api/auth-service/authority/session/revoke",
    {
      method: "POST",
      body: JSON.stringify({ ...input, correlationId: `nextjs-session-revoke-${randomUUID()}` }),
    }
  );
}

export async function appendAuthAuditEvidenceToAuthService(input: {
  subjectIdentityId: string;
  actorIdentityId?: string | null;
  action: string;
  result?: string;
  reason?: string;
  correlationId?: string;
}) {
  return requestJson<unknown>("/api/auth-service/authority/audit", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      correlationId: input.correlationId ?? `nextjs-auth-audit-${randomUUID()}`,
    }),
  });
}

export async function getAuthServiceContext(
  sessionToken?: string | null
): Promise<AuthContext | null> {
  if (!sessionToken) {
    return null;
  }

  try {
    const response = await requestJson<AuthServiceContextResponse | AuthServiceFailure>(
      "/api/auth-service/me",
      {
        headers: {
          "x-auth-session-id": sessionToken,
        },
      }
    );

    if (response.status !== 200 || response.body?.success !== true) {
      return null;
    }

    const groups = (response.body.groups ?? response.body.roles ?? []).map(mapGroup);
    const directPermissions = (response.body.permissions ?? [])
      .map(mapPermission)
      .filter((permission): permission is AuthenticatedPermission => permission !== null);
    const claimPermissions = mapPermissionClaims(response.body.claims);
    const permissionsByKey = new Map<string, AuthenticatedPermission>();

    for (const permission of [...directPermissions, ...claimPermissions]) {
      permissionsByKey.set(permission.key, permission);
    }

    return toAuthContext(
      response.body.identity,
      response.body.session,
      groups,
      [...permissionsByKey.values()],
      mapPlatformScopes(response.body)
    );
  } catch {
    return null;
  }
}

export async function getSerializableAuthServiceContext(
  sessionToken?: string | null
): Promise<SerializableAuthContext | null> {
  const context = await getAuthServiceContext(sessionToken);

  if (!context) {
    return null;
  }

  return {
    user: context.user,
    session: context.session,
    groups: context.groups,
    permissions: context.permissions,
    platformScopes: context.platformScopes,
  };
}

export function isAuthServiceSessionActive(context: AuthContext | null) {
  return context?.session.revokedAt == null && context?.session.expiresAt
    ? new Date(context.session.expiresAt).getTime() > Date.now()
    : false;
}

export function mapAuthServiceSessionStatus(context: AuthContext | null) {
  return isAuthServiceSessionActive(context)
    ? SESSION_STATUSES.ACTIVE
    : SESSION_STATUSES.EXPIRED;
}
