import { invalid, valid } from "@/src/lib/validation/validation.types";
import {
  DEFAULT_PLATFORM_GROUP_NAMES,
  IDENTITY_CLASSES,
  USER_STATUSES,
} from "./auth.constants";
import type { IdentityClass, UserStatus } from "./auth.types";
export { validatePasswordPolicy } from "./password.policy";

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateUsername(username: string) {
  const normalized = username.trim();

  if (!normalized) {
    return invalid("Username is required.");
  }

  if (normalized.length < 3) {
    return invalid("Username must be at least 3 characters.");
  }

  if (normalized.length > 64) {
    return invalid("Username must be 64 characters or fewer.");
  }

  if (!USERNAME_PATTERN.test(normalized)) {
    return invalid(
      "Username may contain only letters, numbers, periods, underscores, and hyphens."
    );
  }

  return valid();
}

export function validateEmail(email?: string | null) {
  if (!email?.trim()) {
    return valid();
  }

  if (!EMAIL_PATTERN.test(email.trim())) {
    return invalid("Email format is invalid.");
  }

  return valid();
}

export function validateIdentityClass(identityClass: string) {
  if (
    !Object.values(IDENTITY_CLASSES).includes(identityClass as IdentityClass)
  ) {
    return invalid("Identity class is invalid.");
  }

  return valid();
}

export function validateUserStatus(status: string) {
  if (!Object.values(USER_STATUSES).includes(status as UserStatus)) {
    return invalid("User status is invalid.");
  }

  return valid();
}

export function validateGroupName(groupName: string) {
  const normalized = groupName.trim();

  if (!normalized) {
    return invalid("Group name is required.");
  }

  if (normalized.length > 100) {
    return invalid("Group name must be 100 characters or fewer.");
  }

  return valid();
}

export function isDefaultPlatformGroupName(groupName: string) {
  return DEFAULT_PLATFORM_GROUP_NAMES.includes(
    groupName.trim() as (typeof DEFAULT_PLATFORM_GROUP_NAMES)[number]
  );
}
