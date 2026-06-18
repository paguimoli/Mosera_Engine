export type OperationalUserInventoryItem = {
  id: string;
  username: string;
  email: string;
  displayName: string;
  identityClass: string;
  status: string;
  groups: string[];
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  lastPasswordChangeAt: string | null;
  sessionCount: number;
  activeSessionCount: number;
  isBreakGlass: boolean;
  breakGlassEnabled: boolean | null;
  breakGlassLabel: string | null;
};

export type OperationalSession = {
  id: string;
  userId: string;
  username: string | null;
  identityClass: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  isActive: boolean;
};
