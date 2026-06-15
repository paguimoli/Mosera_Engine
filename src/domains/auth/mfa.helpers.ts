import { randomBytes } from "node:crypto";
import { authenticator } from "otplib";
import {
  MFA_CHALLENGE_TOKEN_BYTES,
  MFA_STATUSES,
  MFA_TOTP_ALGORITHM,
  MFA_TOTP_DIGITS,
  MFA_TOTP_ISSUER,
  MFA_TOTP_PERIOD_SECONDS,
} from "./auth.constants";
import type { MfaRecoveryCode, MfaStatus, PlatformUser } from "./auth.types";
import type { MfaChallengeToken, MfaChallengeTokenHash } from "./mfa.types";
import { hashSessionToken } from "./session.helpers";

const PLACEHOLDER_SECRET_PREFIX = "placeholder:v1:";

authenticator.options = {
  digits: MFA_TOTP_DIGITS,
  step: MFA_TOTP_PERIOD_SECONDS,
};

export function isMfaStatus(value: string): value is MfaStatus {
  return Object.values(MFA_STATUSES).includes(value as MfaStatus);
}

export function isMfaEnabled(user?: Pick<PlatformUser, "mfaStatus"> | null) {
  return user?.mfaStatus === MFA_STATUSES.ENABLED;
}

export function isMfaRequired(user?: Pick<PlatformUser, "mfaStatus"> | null) {
  return (
    user?.mfaStatus === MFA_STATUSES.REQUIRED ||
    user?.mfaStatus === MFA_STATUSES.PENDING_SETUP
  );
}

export function getUnusedMfaRecoveryCodes(codes: MfaRecoveryCode[]) {
  return codes.filter((code) => !code.usedAt);
}

export function generateTotpSecret() {
  return authenticator.generateSecret();
}

export function buildTotpUri({
  username,
  secret,
}: {
  username: string;
  secret: string;
}) {
  return authenticator.keyuri(username, MFA_TOTP_ISSUER, secret);
}

export function verifyTotpCode({
  code,
  secret,
}: {
  code: string;
  secret: string;
}) {
  return authenticator.check(code.trim(), secret);
}

export function generateMfaChallengeToken(): MfaChallengeToken {
  return randomBytes(MFA_CHALLENGE_TOKEN_BYTES).toString("base64url");
}

export function hashMfaChallengeToken(
  token: MfaChallengeToken
): MfaChallengeTokenHash {
  return hashSessionToken(token);
}

export function encryptMfaSecretPlaceholder(secret: string) {
  return `${PLACEHOLDER_SECRET_PREFIX}${Buffer.from(secret, "utf8").toString(
    "base64url"
  )}`;
}

export function decryptMfaSecretPlaceholder(secretEncrypted: string) {
  if (!secretEncrypted.startsWith(PLACEHOLDER_SECRET_PREFIX)) {
    throw new Error("Unsupported MFA secret encryption format.");
  }

  return Buffer.from(
    secretEncrypted.slice(PLACEHOLDER_SECRET_PREFIX.length),
    "base64url"
  ).toString("utf8");
}

export const mfaTotpConfig = {
  issuer: MFA_TOTP_ISSUER,
  digits: MFA_TOTP_DIGITS,
  periodSeconds: MFA_TOTP_PERIOD_SECONDS,
  algorithm: MFA_TOTP_ALGORITHM,
} as const;
