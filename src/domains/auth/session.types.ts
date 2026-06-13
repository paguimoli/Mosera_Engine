import type { IdentityClass, SessionStatus } from "./auth.types";

export type SessionToken = string;

export type SessionTokenHash = string;

export type SessionHashAlgorithm = "sha256";

export type SessionMetadata = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type SessionValidationResult = {
  valid: boolean;
  errors: string[];
};

export type SessionCreationInput = {
  userId: string;
  identityClass: IdentityClass;
  metadata?: SessionMetadata;
  now?: Date;
};

export type SessionRecord = {
  id: string;
  userId: string;
  sessionTokenHash: SessionTokenHash;
  status?: SessionStatus | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt?: string | null;
};
