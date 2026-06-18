import {
  AUTHENTICATION_EVENT_TYPES,
  LOCKOUT_DURATION_MINUTES,
  MAX_FAILED_LOGIN_ATTEMPTS,
  MFA_CHALLENGE_EXPIRATION_MINUTES,
  PASSWORD_RESET_EXPIRATION_MINUTES,
  USER_STATUSES,
} from "./auth.constants";
import {
  createPasswordResetToken,
  createMfaChallenge,
  findPasswordResetTokenByHash,
  findSessionByTokenHash,
  findUserByIdentifier,
  findUserById,
  findUserByUsername,
  incrementFailedLoginAttempts,
  lockUser,
  markBreakGlassAccountUsed,
  markPasswordResetTokenUsed,
  revokeActiveSessionsForUser,
  revokeSessionById,
  revokeUnusedPasswordResetTokensForUser,
  resetFailedLoginState,
  saveAuthAuditEvent,
  saveUserSession,
  unlockExpiredLock,
  updateLastLoginAt,
  updateUserPasswordHash,
} from "./auth.repository";
import type {
  AuthRequestMetadata,
  LoginRequestInput,
  LoginResponse,
  LogoutRequestInput,
  LogoutResponse,
  PasswordResetConfirmInput,
  PasswordResetConfirmResponse,
  PasswordResetRequestInput,
  PasswordResetRequestResponse,
} from "./auth.types";
import type { AuthUserRecord } from "./auth.types";
import {
  generateMfaChallengeToken,
  hashMfaChallengeToken,
} from "./mfa.helpers";
import {
  generatePasswordResetToken,
  hashPassword,
  hashPasswordResetToken,
  verifyPassword,
} from "./password.helpers";
import { validatePasswordPolicy } from "./password.policy";
import {
  createSessionExpiry,
  generateSessionToken,
  hashSessionToken,
  isSessionActive,
  verifySessionToken,
} from "./session.helpers";
import { allowsMultipleActiveSessions } from "./session.policy";

const INVALID_CREDENTIALS_ERROR = "Invalid username or password.";
const ACCOUNT_UNAVAILABLE_ERROR = "Account temporarily unavailable.";
const PASSWORD_RESET_MESSAGE =
  "If the account exists, password reset instructions have been generated.";
const INVALID_PASSWORD_RESET_ERROR = "Password reset request is invalid.";
const PASSWORD_WORK_FACTOR_PLACEHOLDER = "invalid-password-placeholder";

type AuthEventType =
  (typeof AUTHENTICATION_EVENT_TYPES)[keyof typeof AUTHENTICATION_EVENT_TYPES];

function addMinutes(date: Date, minutes: number): Date {
  const result = new Date(date);
  result.setMinutes(result.getMinutes() + minutes);
  return result;
}

function createMfaChallengeExpiry(now = new Date()): string {
  return addMinutes(now, MFA_CHALLENGE_EXPIRATION_MINUTES).toISOString();
}

function createPasswordResetExpiry(now = new Date()): string {
  return addMinutes(now, PASSWORD_RESET_EXPIRATION_MINUTES).toISOString();
}

function isFutureDate(value?: string | null, now = new Date()) {
  return Boolean(value && new Date(value).getTime() > now.getTime());
}

async function recordAuthEvent({
  userId,
  eventType,
  metadata,
}: {
  userId?: string | null;
  eventType: AuthEventType;
  metadata?: Record<string, unknown>;
}) {
  await saveAuthAuditEvent({
    userId,
    eventType,
    metadata,
  });
}

async function recordBreakGlassSession(user: AuthUserRecord, createdAt: string) {
  if (user.identityClass !== "BREAK_GLASS") {
    return;
  }

  await markBreakGlassAccountUsed(user.id, createdAt);
  await recordAuthEvent({
    userId: user.id,
    eventType: AUTHENTICATION_EVENT_TYPES.BREAK_GLASS_LOGIN,
    metadata: {
      createdAt,
    },
  });
}

async function performPasswordWork(password: string): Promise<void> {
  await hashPassword(password || PASSWORD_WORK_FACTOR_PLACEHOLDER);
}

function loginFailure(): LoginResponse {
  return {
    success: false,
    error: INVALID_CREDENTIALS_ERROR,
  };
}

function accountUnavailableFailure(): LoginResponse {
  return {
    success: false,
    error: ACCOUNT_UNAVAILABLE_ERROR,
  };
}

function passwordResetRequestSuccess(
  resetToken?: string
): PasswordResetRequestResponse {
  return {
    success: true,
    message: PASSWORD_RESET_MESSAGE,
    ...(resetToken && process.env.NODE_ENV !== "production"
      ? { resetToken }
      : {}),
  };
}

function isExpired(expiresAt: string, now = new Date()) {
  return new Date(expiresAt).getTime() <= now.getTime();
}

async function recordFailedLoginAttempt(userId?: string | null): Promise<void> {
  await recordAuthEvent({
    userId,
    eventType: AUTHENTICATION_EVENT_TYPES.LOGIN_FAILED,
  });
}

async function handleInvalidPassword({
  userId,
  now,
}: {
  userId: string;
  now: Date;
}): Promise<LoginResponse> {
  const failedLoginAttempts = await incrementFailedLoginAttempts(userId);

  await recordFailedLoginAttempt(userId);

  if (failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
    const lockedUntil = addMinutes(now, LOCKOUT_DURATION_MINUTES).toISOString();
    await lockUser(userId, lockedUntil);
    await recordAuthEvent({
      userId,
      eventType: AUTHENTICATION_EVENT_TYPES.ACCOUNT_LOCKED,
      metadata: {
        failedLoginAttempts,
        lockedUntil,
      },
    });
  }

  return loginFailure();
}

export async function createAuthenticatedSessionForUser({
  user,
  metadata,
  now = new Date(),
}: {
  user: AuthUserRecord;
  metadata?: AuthRequestMetadata;
  now?: Date;
}): Promise<Extract<LoginResponse, { success: true; sessionToken: string }>> {
  const createdAt = now.toISOString();
  const expiresAt = createSessionExpiry(user.identityClass, now);
  const sessionToken = generateSessionToken();
  const sessionTokenHash = hashSessionToken(sessionToken);

  if (!allowsMultipleActiveSessions(user.identityClass)) {
    await revokeActiveSessionsForUser(user.id, createdAt);
  }

  await saveUserSession({
    userId: user.id,
    sessionTokenHash,
    ipAddress: metadata?.ipAddress ?? null,
    userAgent: metadata?.userAgent ?? null,
    createdAt,
    lastSeenAt: createdAt,
    expiresAt,
  });

  await resetFailedLoginState(user.id);
  await updateLastLoginAt(user.id, createdAt);
  await recordAuthEvent({
    userId: user.id,
    eventType: AUTHENTICATION_EVENT_TYPES.LOGIN_SUCCESS,
  });
  await recordBreakGlassSession(user, createdAt);

  return {
    success: true,
    sessionToken,
    expiresAt,
  };
}

export async function loginWithPassword({
  input,
  metadata,
}: {
  input: LoginRequestInput;
  metadata?: AuthRequestMetadata;
}): Promise<LoginResponse> {
  const now = new Date();
  const user = await findUserByUsername(input.username);

  if (!user) {
    await performPasswordWork(input.password);
    await recordFailedLoginAttempt(null);
    return loginFailure();
  }

  const passwordHash = user.passwordHash;

  if (user.status === USER_STATUSES.DISABLED) {
    await performPasswordWork(input.password);
    await recordFailedLoginAttempt(user.id);
    return loginFailure();
  }

  if (user.status === USER_STATUSES.LOCKED) {
    if (isFutureDate(user.lockedUntil, now)) {
      await performPasswordWork(input.password);
      await recordFailedLoginAttempt(user.id);
      return accountUnavailableFailure();
    }

    await unlockExpiredLock(user.id);
    await recordAuthEvent({
      userId: user.id,
      eventType: AUTHENTICATION_EVENT_TYPES.ACCOUNT_UNLOCKED,
    });
  }

  if (user.status === USER_STATUSES.PENDING_ACTIVATION || !passwordHash) {
    await performPasswordWork(input.password);
    await recordFailedLoginAttempt(user.id);
    return loginFailure();
  }

  const passwordMatches = await verifyPassword(input.password, passwordHash);

  if (!passwordMatches) {
    return handleInvalidPassword({
      userId: user.id,
      now,
    });
  }

  if (user.mfaEnabled) {
    const challengeToken = generateMfaChallengeToken();
    const challengeTokenHash = hashMfaChallengeToken(challengeToken);
    const expiresAt = createMfaChallengeExpiry(now);

    await createMfaChallenge({
      userId: user.id,
      tokenHash: challengeTokenHash,
      expiresAt,
      ipAddress: metadata?.ipAddress ?? null,
      userAgent: metadata?.userAgent ?? null,
    });

    await recordAuthEvent({
      userId: user.id,
      eventType: AUTHENTICATION_EVENT_TYPES.MFA_CHALLENGE_CREATED,
      metadata: {
        expiresAt,
      },
    });

    return {
      success: true,
      mfaRequired: true,
      challengeToken,
      expiresAt,
    };
  }

  return createAuthenticatedSessionForUser({
    user,
    metadata,
    now,
  });
}

export async function requestPasswordReset({
  input,
}: {
  input: PasswordResetRequestInput;
}): Promise<PasswordResetRequestResponse> {
  const user = await findUserByIdentifier(input.identifier);

  if (!user || user.status !== USER_STATUSES.ACTIVE) {
    await recordAuthEvent({
      userId: user?.id ?? null,
      eventType: AUTHENTICATION_EVENT_TYPES.PASSWORD_RESET_REQUEST_IGNORED,
    });

    return passwordResetRequestSuccess();
  }

  const now = new Date();
  const resetToken = generatePasswordResetToken();
  const tokenHash = hashPasswordResetToken(resetToken);
  const expiresAt = createPasswordResetExpiry(now);
  const revokedAt = now.toISOString();

  await revokeUnusedPasswordResetTokensForUser(user.id, revokedAt);
  await createPasswordResetToken(user.id, tokenHash, expiresAt);
  await recordAuthEvent({
    userId: user.id,
    eventType: AUTHENTICATION_EVENT_TYPES.PASSWORD_RESET_REQUESTED,
    metadata: {
      expiresAt,
    },
  });

  return passwordResetRequestSuccess(resetToken);
}

export async function resetPassword({
  input,
}: {
  input: PasswordResetConfirmInput;
}): Promise<PasswordResetConfirmResponse> {
  const tokenHash = hashPasswordResetToken(input.resetToken);
  const resetToken = await findPasswordResetTokenByHash(tokenHash);

  if (!resetToken || resetToken.usedAt || isExpired(resetToken.expiresAt)) {
    await recordAuthEvent({
      userId: resetToken?.userId ?? null,
      eventType: AUTHENTICATION_EVENT_TYPES.PASSWORD_RESET_FAILED,
    });

    return {
      success: false,
      errors: [INVALID_PASSWORD_RESET_ERROR],
    };
  }

  const user = await findUserById(resetToken.userId);

  if (!user) {
    await recordAuthEvent({
      userId: resetToken.userId,
      eventType: AUTHENTICATION_EVENT_TYPES.PASSWORD_RESET_FAILED,
    });

    return {
      success: false,
      errors: [INVALID_PASSWORD_RESET_ERROR],
    };
  }

  const passwordValidation = validatePasswordPolicy({
    password: input.newPassword,
    username: user.username,
    email: user.email,
  });

  if (!passwordValidation.valid) {
    await recordAuthEvent({
      userId: user.id,
      eventType: AUTHENTICATION_EVENT_TYPES.PASSWORD_RESET_FAILED,
      metadata: {
        reason: "PASSWORD_POLICY_FAILED",
      },
    });

    return {
      success: false,
      errors: passwordValidation.errors,
    };
  }

  const changedAt = new Date().toISOString();
  const passwordHash = await hashPassword(input.newPassword);

  await updateUserPasswordHash({
    userId: user.id,
    passwordHash,
    changedAt,
  });
  await markPasswordResetTokenUsed(resetToken.id, changedAt);
  await revokeUnusedPasswordResetTokensForUser(user.id, changedAt);
  await revokeActiveSessionsForUser(user.id, changedAt);
  await recordAuthEvent({
    userId: user.id,
    eventType: AUTHENTICATION_EVENT_TYPES.PASSWORD_RESET_COMPLETED,
  });

  return {
    success: true,
  };
}

export async function logoutSession({
  input,
}: {
  input: LogoutRequestInput;
}): Promise<LogoutResponse> {
  const sessionTokenHash = hashSessionToken(input.sessionToken);
  const session = await findSessionByTokenHash(sessionTokenHash);

  if (!session) {
    return { success: true };
  }

  const verified = verifySessionToken(
    input.sessionToken,
    session.sessionTokenHash
  );

  if (!verified || !isSessionActive(session)) {
    return { success: true };
  }

  await revokeSessionById(session.id, new Date().toISOString());

  return { success: true };
}
