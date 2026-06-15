import type { IdentityClass, UserStatus } from "./auth.types";

export type AuthenticatedUser = {
  id: string;
  username: string;
  email: string;
  displayName: string;
  identityClass: IdentityClass;
  status: UserStatus;
  failedLoginAttempts: number;
  lockedUntil?: string | null;
  lastLoginAt?: string | null;
};

export type AuthenticatedSession = {
  id: string;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt?: string | null;
};

export type AuthenticatedUserGroup = {
  id: string;
  name: string;
  description?: string | null;
  isSystemGroup: boolean;
  createdAt: string;
  updatedAt?: string | null;
};

export type AuthenticatedPermission = {
  id: string;
  key: string;
  category?: string | null;
  description?: string | null;
  isSystemPermission: boolean;
  createdAt: string;
  updatedAt?: string | null;
};

export type AuthContext = {
  user: AuthenticatedUser;
  session: AuthenticatedSession;
  groups: AuthenticatedUserGroup[];
  permissions: AuthenticatedPermission[];
  hasPermission(permissionKey: string): boolean;
};

export type SerializableAuthContext = {
  user: AuthenticatedUser;
  session: AuthenticatedSession;
  groups: AuthenticatedUserGroup[];
  permissions: AuthenticatedPermission[];
};
