import type { AuthContext } from "@/src/domains/auth/auth-context.types";
import { revokeSessionWithAuthService } from "@/src/domains/auth/auth-service.client";
import {
  createPrivilegedSession,
  terminatePrivilegedSession,
  validateOperationalCommandSecurity,
} from "./operational-security.repository";

export class OperationalSecurityError extends Error {
  readonly status: 400 | 403 | 409 | 503;
  constructor(message: string, status: 400 | 403 | 409 | 503 = 403) {
    super(message);
    this.name = "OperationalSecurityError";
    this.status = status;
  }
}

export function productionOperationalSecurityEnforced() {
  return process.env.DEPLOYMENT_ENVIRONMENT?.trim().toLowerCase() === "production";
}

export function resolvePrivilegedSessionId(request?: Request | null) {
  return request?.headers.get("x-privileged-session-id")?.trim() || null;
}

export async function authorizeOperationalCommandSecurity(input: {
  commandId: string;
  authContext: AuthContext;
  privilegedSessionId?: string | null;
}) {
  try {
    return await validateOperationalCommandSecurity({
      commandId: input.commandId,
      privilegedSessionId: input.privilegedSessionId,
      executorIdentityId: input.authContext.user.id,
      productionEnforced: productionOperationalSecurityEnforced(),
    });
  } catch (error) {
    throw new OperationalSecurityError(
      error instanceof Error ? error.message : "Operational security validation failed."
    );
  }
}

export async function activatePrivilegedSession(input: Parameters<typeof createPrivilegedSession>[0]) {
  try {
    return await createPrivilegedSession(input);
  } catch (error) {
    throw new OperationalSecurityError(
      error instanceof Error ? error.message : "Unable to activate privileged session."
    );
  }
}

export async function endPrivilegedSession(input: Parameters<typeof terminatePrivilegedSession>[0]) {
  try {
    const target = await terminatePrivilegedSession(input);
    const revocation = await revokeSessionWithAuthService({
      sessionId: target.authenticationSessionId,
      identityId: target.identityId,
      actorIdentityId: input.actorIdentityId,
      reason: `privileged_session_terminated:${input.reason}`,
    });
    if (revocation.status !== 200 || !revocation.body?.success) {
      throw new Error(revocation.body?.error ?? "Auth Service session revocation failed.");
    }
  } catch (error) {
    throw new OperationalSecurityError(
      error instanceof Error ? error.message : "Unable to terminate privileged session."
    );
  }
}
