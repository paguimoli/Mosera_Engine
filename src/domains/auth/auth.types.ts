import {
  AUTHENTICATION_EVENT_TYPES,
  BREAK_GLASS_STATUSES,
  IDENTITY_CLASSES,
  MFA_STATUSES,
  SESSION_STATUSES,
  USER_STATUSES,
} from "./auth.constants";
import type {
  Argon2idPasswordHash,
  PasswordPolicyInput,
  PasswordValidationResult,
  PasswordVerificationResult,
} from "./password.types";

export type IdentityClass =
  (typeof IDENTITY_CLASSES)[keyof typeof IDENTITY_CLASSES];

export type UserStatus = (typeof USER_STATUSES)[keyof typeof USER_STATUSES];

export type AuthenticationEventType =
  (typeof AUTHENTICATION_EVENT_TYPES)[keyof typeof AUTHENTICATION_EVENT_TYPES];

export type MfaStatus = (typeof MFA_STATUSES)[keyof typeof MFA_STATUSES];

export type SessionStatus =
  (typeof SESSION_STATUSES)[keyof typeof SESSION_STATUSES];

export type BreakGlassStatus =
  (typeof BREAK_GLASS_STATUSES)[keyof typeof BREAK_GLASS_STATUSES];

export type PlatformUser = {
  id: string;
  username: string;
  email?: string | null;
  displayName?: string | null;
  identityClass: IdentityClass;
  status: UserStatus;
  accountId?: string | null;
  passwordHash?: string | null;
  mfaStatus?: MfaStatus | null;
  createdAt: string;
  updatedAt?: string | null;
  lastLoginAt?: string | null;
};

export type {
  Argon2idPasswordHash,
  PasswordPolicyInput,
  PasswordValidationResult,
  PasswordVerificationResult,
};

export type UserGroup = {
  id: string;
  name: string;
  description?: string | null;
  active: boolean;
  createdAt: string;
};

export type UserGroupMembership = {
  id: string;
  userId: string;
  groupId: string;
  active: boolean;
  createdAt: string;
};

export type UserSession = {
  id: string;
  userId: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceLabel?: string | null;
};

export type PasswordResetToken = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt?: string | null;
  createdAt: string;
};

export type AuthAuditEvent = {
  id: string;
  userId?: string | null;
  eventType: AuthenticationEventType;
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type MfaRecoveryCode = {
  id: string;
  userId: string;
  codeHash: string;
  usedAt?: string | null;
  createdAt: string;
};

export type BreakGlassAccount = {
  id: string;
  userId: string;
  status: BreakGlassStatus;
  sealedLocationReference?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
};
