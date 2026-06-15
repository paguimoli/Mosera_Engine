export type MfaFactorType = "TOTP";

export type MfaFactor = {
  id: string;
  userId: string;
  factorType: MfaFactorType;
  secretEncrypted: string;
  label?: string | null;
  isEnabled: boolean;
  verifiedAt?: string | null;
  createdAt: string;
  updatedAt?: string | null;
};

export type MfaEnrollmentStartResult = {
  factorId: string;
  otpauthUri: string;
  manualEntrySecret: string;
};

export type MfaVerificationResult = {
  success: boolean;
  errors: string[];
};

export type MfaChallengeToken = string;

export type MfaChallengeTokenHash = string;

export type MfaChallenge = {
  id: string;
  userId: string;
  challengeTokenHash: MfaChallengeTokenHash;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string | null;
};

export type MfaChallengeVerificationResult =
  | {
      success: true;
      sessionToken: string;
      expiresAt: string;
    }
  | {
      success: false;
      error: string;
    };

export type MfaChallengeVerificationInput = {
  challengeToken: MfaChallengeToken;
  code: string;
};
