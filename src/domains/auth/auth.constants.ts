export const IDENTITY_CLASSES = {
  PLATFORM_OPERATOR: "PLATFORM_OPERATOR",
  HIERARCHY_PARTICIPANT: "HIERARCHY_PARTICIPANT",
  PLAYER: "PLAYER",
  SYSTEM_SERVICE: "SYSTEM_SERVICE",
} as const;

export const USER_STATUSES = {
  ACTIVE: "ACTIVE",
  LOCKED: "LOCKED",
  DISABLED: "DISABLED",
  PENDING_ACTIVATION: "PENDING_ACTIVATION",
} as const;

export const AUTHENTICATION_EVENT_TYPES = {
  LOGIN_SUCCESS: "LOGIN_SUCCESS",
  LOGIN_FAILED: "LOGIN_FAILED",
  LOGOUT: "LOGOUT",
  PASSWORD_CHANGED: "PASSWORD_CHANGED",
  PASSWORD_RESET_REQUESTED: "PASSWORD_RESET_REQUESTED",
  PASSWORD_RESET_COMPLETED: "PASSWORD_RESET_COMPLETED",
  MFA_ENABLED: "MFA_ENABLED",
  MFA_DISABLED: "MFA_DISABLED",
  SESSION_REVOKED: "SESSION_REVOKED",
  BREAK_GLASS_LOGIN: "BREAK_GLASS_LOGIN",
} as const;

export const MFA_STATUSES = {
  DISABLED: "DISABLED",
  OPTIONAL: "OPTIONAL",
  REQUIRED: "REQUIRED",
  PENDING_SETUP: "PENDING_SETUP",
  ENABLED: "ENABLED",
} as const;

export const SESSION_STATUSES = {
  ACTIVE: "ACTIVE",
  REVOKED: "REVOKED",
  EXPIRED: "EXPIRED",
} as const;

export const SESSION_HASH_ALGORITHM = "sha256" as const;

export const SESSION_POLICY = {
  defaultDurationSeconds: 60 * 60 * 12,
  operatorDurationSeconds: 60 * 60 * 8,
  playerDurationSeconds: 60 * 60 * 24,
  tokenByteLength: 32,
  hashAlgorithm: SESSION_HASH_ALGORITHM,
  singleActiveSessionIdentityClasses: [IDENTITY_CLASSES.PLATFORM_OPERATOR],
} as const;

export const BREAK_GLASS_STATUSES = {
  ACTIVE: "ACTIVE",
  USED: "USED",
  DISABLED: "DISABLED",
} as const;

export const DEFAULT_PLATFORM_GROUP_NAMES = [
  "Super Admin",
  "Operations Admin",
  "Settlement Admin",
  "Risk Admin",
  "Compliance Admin",
  "Support Admin",
] as const;

export const ARGON2ID_ALGORITHM = "argon2id" as const;

export const ARGON2ID_PASSWORD_SETTINGS = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

export const PASSWORD_POLICY = {
  minimumLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecialCharacter: true,
} as const;
