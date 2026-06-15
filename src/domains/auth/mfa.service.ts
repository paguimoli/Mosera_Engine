import { AUTHENTICATION_EVENT_TYPES, USER_STATUSES } from "./auth.constants";
import type { AuthContext } from "./auth-context.types";
import {
  createOrReplaceTotpFactor,
  consumeMfaChallenge,
  disableTotpFactor,
  enableTotpFactor,
  findMfaChallengeByTokenHash,
  findUserById,
  getTotpFactorByUserId,
  saveAuthAuditEvent,
} from "./auth.repository";
import { createAuthenticatedSessionForUser } from "./auth.service";
import type { AuthRequestMetadata } from "./auth.types";
import {
  buildTotpUri,
  decryptMfaSecretPlaceholder,
  encryptMfaSecretPlaceholder,
  hashMfaChallengeToken,
  generateTotpSecret,
  verifyTotpCode,
} from "./mfa.helpers";
import type {
  MfaChallengeVerificationInput,
  MfaChallengeVerificationResult,
  MfaEnrollmentStartResult,
  MfaVerificationResult,
} from "./mfa.types";

const INVALID_MFA_CHALLENGE_ERROR = "Invalid MFA challenge.";

function isExpired(expiresAt: string, now = new Date()) {
  return new Date(expiresAt).getTime() <= now.getTime();
}

function invalidMfaChallenge(): MfaChallengeVerificationResult {
  return {
    success: false,
    error: INVALID_MFA_CHALLENGE_ERROR,
  };
}

export async function startTotpEnrollment(
  authContext: AuthContext
): Promise<MfaEnrollmentStartResult> {
  const secret = generateTotpSecret();
  const secretEncrypted = encryptMfaSecretPlaceholder(secret);
  const factor = await createOrReplaceTotpFactor(
    authContext.user.id,
    secretEncrypted
  );

  await saveAuthAuditEvent({
    userId: authContext.user.id,
    eventType: AUTHENTICATION_EVENT_TYPES.MFA_ENROLLMENT_STARTED,
    metadata: {
      factorType: "TOTP",
    },
  });

  return {
    factorId: factor.id,
    otpauthUri: buildTotpUri({
      username: authContext.user.username,
      secret,
    }),
    manualEntrySecret: secret,
  };
}

export async function verifyTotpEnrollment(
  authContext: AuthContext,
  code: string
): Promise<MfaVerificationResult> {
  const factor = await getTotpFactorByUserId(authContext.user.id);

  if (!factor) {
    return {
      success: false,
      errors: ["TOTP enrollment was not started."],
    };
  }

  const secret = decryptMfaSecretPlaceholder(factor.secretEncrypted);
  const isValidCode = verifyTotpCode({
    code,
    secret,
  });

  if (!isValidCode) {
    await saveAuthAuditEvent({
      userId: authContext.user.id,
      eventType: AUTHENTICATION_EVENT_TYPES.MFA_VERIFICATION_FAILED,
      metadata: {
        factorType: "TOTP",
      },
    });

    return {
      success: false,
      errors: ["MFA verification failed."],
    };
  }

  await enableTotpFactor(authContext.user.id);
  await saveAuthAuditEvent({
    userId: authContext.user.id,
    eventType: AUTHENTICATION_EVENT_TYPES.MFA_ENABLED,
    metadata: {
      factorType: "TOTP",
    },
  });

  return {
    success: true,
    errors: [],
  };
}

export async function disableTotp(authContext: AuthContext): Promise<void> {
  await disableTotpFactor(authContext.user.id);
  await saveAuthAuditEvent({
    userId: authContext.user.id,
    eventType: AUTHENTICATION_EVENT_TYPES.MFA_DISABLED,
    metadata: {
      factorType: "TOTP",
    },
  });
}

export async function verifyMfaChallenge({
  input,
  metadata,
}: {
  input: MfaChallengeVerificationInput;
  metadata?: AuthRequestMetadata;
}): Promise<MfaChallengeVerificationResult> {
  const challengeTokenHash = hashMfaChallengeToken(input.challengeToken);
  const challenge = await findMfaChallengeByTokenHash(challengeTokenHash);

  if (!challenge) {
    return invalidMfaChallenge();
  }

  if (challenge.consumedAt) {
    return invalidMfaChallenge();
  }

  if (isExpired(challenge.expiresAt)) {
    await saveAuthAuditEvent({
      userId: challenge.userId,
      eventType: AUTHENTICATION_EVENT_TYPES.MFA_CHALLENGE_EXPIRED,
      metadata: {
        challengeId: challenge.id,
      },
    });

    return invalidMfaChallenge();
  }

  const user = await findUserById(challenge.userId);

  if (!user || user.status !== USER_STATUSES.ACTIVE || !user.mfaEnabled) {
    return invalidMfaChallenge();
  }

  const factor = await getTotpFactorByUserId(user.id);

  if (!factor?.isEnabled) {
    return invalidMfaChallenge();
  }

  const secret = decryptMfaSecretPlaceholder(factor.secretEncrypted);
  const isValidCode = verifyTotpCode({
    code: input.code,
    secret,
  });

  if (!isValidCode) {
    await saveAuthAuditEvent({
      userId: user.id,
      eventType: AUTHENTICATION_EVENT_TYPES.MFA_VERIFICATION_FAILED,
      metadata: {
        challengeId: challenge.id,
        factorType: "TOTP",
      },
    });

    return invalidMfaChallenge();
  }

  await consumeMfaChallenge(challenge.id);
  await saveAuthAuditEvent({
    userId: user.id,
    eventType: AUTHENTICATION_EVENT_TYPES.MFA_CHALLENGE_VERIFIED,
    metadata: {
      challengeId: challenge.id,
      factorType: "TOTP",
    },
  });
  await saveAuthAuditEvent({
    userId: user.id,
    eventType: AUTHENTICATION_EVENT_TYPES.MFA_CHALLENGE_CONSUMED,
    metadata: {
      challengeId: challenge.id,
    },
  });

  return createAuthenticatedSessionForUser({
    user,
    metadata,
  });
}
