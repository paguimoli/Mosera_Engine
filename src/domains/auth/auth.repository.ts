import { appendAuthAuditEvidenceToAuthService } from "./auth-service.client";
import type { AuthenticationEventType } from "./auth.types";

export type CreateAuthAuditEventInput = {
  userId?: string | null;
  eventType: AuthenticationEventType;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
};

export class AuthRepositoryError extends Error {
  constructor(message = "Auth Service audit delegation failed.") {
    super(message);
    this.name = "AuthRepositoryError";
  }
}

export async function saveAuthAuditEvent(input: CreateAuthAuditEventInput) {
  if (!input.userId) return;
  const result = await appendAuthAuditEvidenceToAuthService({
    subjectIdentityId: input.userId,
    actorIdentityId:
      typeof input.metadata?.actorUserId === "string"
        ? input.metadata.actorUserId
        : input.userId,
    action: input.eventType,
    result: "SUCCESS",
    reason: JSON.stringify(input.metadata ?? {}),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new AuthRepositoryError();
  }
}
