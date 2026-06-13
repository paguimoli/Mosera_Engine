import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  SESSION_HASH_ALGORITHM,
  SESSION_POLICY,
  SESSION_STATUSES,
} from "./auth.constants";
import type { IdentityClass, SessionStatus, UserSession } from "./auth.types";
import { getSessionDurationSeconds } from "./session.policy";
import type {
  SessionMetadata,
  SessionRecord,
  SessionToken,
  SessionTokenHash,
  SessionValidationResult,
} from "./session.types";

const SESSION_TOKEN_HASH_PREFIX = `${SESSION_HASH_ALGORITHM}:`;

export function isSessionStatus(value: string): value is SessionStatus {
  return Object.values(SESSION_STATUSES).includes(value as SessionStatus);
}

export function generateSessionToken(): SessionToken {
  return randomBytes(SESSION_POLICY.tokenByteLength).toString("base64url");
}

export function hashSessionToken(token: SessionToken): SessionTokenHash {
  const digest = createHash(SESSION_POLICY.hashAlgorithm)
    .update(token)
    .digest("hex");

  return `${SESSION_TOKEN_HASH_PREFIX}${digest}`;
}

function getSessionTokenHashBuffer(tokenHash: SessionTokenHash) {
  const digest = tokenHash.startsWith(SESSION_TOKEN_HASH_PREFIX)
    ? tokenHash.slice(SESSION_TOKEN_HASH_PREFIX.length)
    : tokenHash;

  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    return null;
  }

  return Buffer.from(digest, "hex");
}

export function verifySessionToken(
  token: SessionToken,
  tokenHash: SessionTokenHash
): boolean {
  if (!token || !tokenHash) {
    return false;
  }

  const expectedHashBuffer = getSessionTokenHashBuffer(hashSessionToken(token));
  const actualHashBuffer = getSessionTokenHashBuffer(tokenHash);

  if (
    !expectedHashBuffer ||
    !actualHashBuffer ||
    expectedHashBuffer.length !== actualHashBuffer.length
  ) {
    return false;
  }

  return timingSafeEqual(expectedHashBuffer, actualHashBuffer);
}

export function createSessionExpiry(
  identityClass: IdentityClass,
  now = new Date()
): string {
  const expiresAt = new Date(now);
  expiresAt.setSeconds(
    expiresAt.getSeconds() + getSessionDurationSeconds(identityClass)
  );

  return expiresAt.toISOString();
}

export function isSessionExpired(
  session: Pick<UserSession | SessionRecord, "expiresAt">,
  now = new Date()
) {
  return new Date(session.expiresAt).getTime() <= now.getTime();
}

export function isSessionRevoked(
  session: Pick<UserSession | SessionRecord, "revokedAt" | "status">
) {
  return Boolean(session.revokedAt) || session.status === SESSION_STATUSES.REVOKED;
}

export function getSessionStatus(
  session: Pick<UserSession | SessionRecord, "expiresAt" | "revokedAt" | "status">,
  now = new Date()
): SessionStatus {
  if (isSessionRevoked(session)) {
    return SESSION_STATUSES.REVOKED;
  }

  if (isSessionExpired(session, now)) {
    return SESSION_STATUSES.EXPIRED;
  }

  return SESSION_STATUSES.ACTIVE;
}

export function isSessionActive(
  session?: UserSession | SessionRecord | null,
  now = new Date()
) {
  return Boolean(session && getSessionStatus(session, now) === SESSION_STATUSES.ACTIVE);
}

export function getActiveSessions(
  sessions: Array<UserSession | SessionRecord>,
  now = new Date()
) {
  return sessions.filter((session) => isSessionActive(session, now));
}

export function validateSessionMetadata(
  input: unknown
): SessionValidationResult {
  const errors: string[] = [];

  if (input === undefined || input === null) {
    return { valid: true, errors };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, errors: ["Session metadata must be an object."] };
  }

  const metadata = input as SessionMetadata;

  if (
    metadata.ipAddress !== undefined &&
    metadata.ipAddress !== null &&
    typeof metadata.ipAddress !== "string"
  ) {
    errors.push("Session IP address must be a string.");
  }

  if (
    typeof metadata.ipAddress === "string" &&
    metadata.ipAddress.length > 100
  ) {
    errors.push("Session IP address must be 100 characters or fewer.");
  }

  if (
    metadata.userAgent !== undefined &&
    metadata.userAgent !== null &&
    typeof metadata.userAgent !== "string"
  ) {
    errors.push("Session user agent must be a string.");
  }

  if (
    typeof metadata.userAgent === "string" &&
    metadata.userAgent.length > 1000
  ) {
    errors.push("Session user agent must be 1000 characters or fewer.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
