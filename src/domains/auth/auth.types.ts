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
import type {
  SessionCreationInput,
  SessionHashAlgorithm,
  SessionMetadata,
  SessionRecord,
  SessionToken,
  SessionTokenHash,
  SessionValidationResult,
} from "./session.types";

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

export type AuthUserRecord = {
  id: string;
  username: string;
  email: string;
  displayName: string;
  identityClass: IdentityClass;
  status: UserStatus;
  passwordHash?: string | null;
  mfaEnabled: boolean;
  failedLoginAttempts: number;
  lockedUntil?: string | null;
  lastLoginAt?: string | null;
};

export type LoginRequestInput = {
  username: string;
  password: string;
};

export type LogoutRequestInput = {
  sessionToken: SessionToken;
};

export type PasswordResetRequestInput = {
  identifier: string;
};

export type PasswordResetConfirmInput = {
  resetToken: string;
  newPassword: string;
};

export type AuthRequestMetadata = SessionMetadata;

export type LoginSessionSuccessResponse = {
  success: true;
  mfaRequired?: false;
  sessionToken: SessionToken;
  expiresAt: string;
  accessToken?: string | null;
  tokenType?: "Bearer";
  accessTokenExpiresAt?: string | null;
  accessTokenKeyId?: string | null;
  accessTokenJwtId?: string | null;
  refreshToken?: string | null;
  refreshTokenId?: string | null;
  refreshTokenExpiresAt?: string | null;
};

export type LoginMfaRequiredResponse = {
  success: true;
  mfaRequired: true;
  challengeToken: string;
  expiresAt: string;
};

export type LoginSuccessResponse =
  | LoginSessionSuccessResponse
  | LoginMfaRequiredResponse;

export type LoginFailureResponse = {
  success: false;
  error: string;
};

export type LoginResponse = LoginSuccessResponse | LoginFailureResponse;

export type LogoutResponse = {
  success: true;
};

export type PasswordResetRequestResponse = {
  success: true;
  message: string;
  resetToken?: string;
};

export type PasswordResetConfirmResponse =
  | {
      success: true;
    }
  | {
      success: false;
      errors: string[];
    };

export type {
  Argon2idPasswordHash,
  PasswordPolicyInput,
  PasswordValidationResult,
  PasswordVerificationResult,
  SessionCreationInput,
  SessionHashAlgorithm,
  SessionMetadata,
  SessionRecord,
  SessionToken,
  SessionTokenHash,
  SessionValidationResult,
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
  sessionTokenHash?: string | null;
  status: SessionStatus;
  createdAt: string;
  lastSeenAt?: string | null;
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
  usedAt?: string | null;
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
