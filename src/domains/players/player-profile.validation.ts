import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { ValidationResult } from "@/src/lib/validation/validation.types";
import type {
  CreatePlayerProfileInput,
  PlayerProfileStatus,
  UpdatePlayerProfileInput,
} from "./player-profile.types";

const PLAYER_PROFILE_STATUSES: PlayerProfileStatus[] = [
  "ACTIVE",
  "SUSPENDED",
  "DISABLED",
];

function isPlayerProfileStatus(value: string): value is PlayerProfileStatus {
  return PLAYER_PROFILE_STATUSES.includes(value as PlayerProfileStatus);
}

function normalizeOptionalString(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";

  return trimmed || null;
}

function normalizeStatus(status: PlayerProfileStatus): PlayerProfileStatus {
  return status.trim().toUpperCase() as PlayerProfileStatus;
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidDateString(dateValue: string) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);

  return !Number.isNaN(date.getTime());
}

function isFutureDate(dateValue: string) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);

  const today = new Date();
  const todayUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );

  return date.getTime() > todayUtc.getTime();
}

export function validateCreatePlayerProfileInput(
  input: CreatePlayerProfileInput
): ValidationResult {
  const errors: string[] = [];
  const accountId = input.accountId.trim();
  const displayName = input.displayName.trim();
  const email = normalizeOptionalString(input.email);
  const dateOfBirth = normalizeOptionalString(input.dateOfBirth);
  const status = input.status ? normalizeStatus(input.status) : "ACTIVE";

  if (!accountId) {
    errors.push("Account id is required.");
  }

  if (!displayName) {
    errors.push("Display name is required.");
  }

  if (!isPlayerProfileStatus(status)) {
    errors.push("Player profile status is invalid.");
  }

  if (email && !isValidEmail(email)) {
    errors.push("Email must be valid.");
  }

  if (dateOfBirth && !isValidDateString(dateOfBirth)) {
    errors.push("Date of birth must be valid.");
  }

  if (dateOfBirth && isValidDateString(dateOfBirth) && isFutureDate(dateOfBirth)) {
    errors.push("Date of birth cannot be in the future.");
  }

  return errors.length > 0 ? invalid(errors) : valid();
}

export function validateUpdatePlayerProfileInput(
  input: UpdatePlayerProfileInput
): ValidationResult {
  const errors: string[] = [];
  const email = normalizeOptionalString(input.email);
  const dateOfBirth = normalizeOptionalString(input.dateOfBirth);

  if (input.accountId !== undefined && !input.accountId.trim()) {
    errors.push("Account id is required.");
  }

  if (input.displayName !== undefined && !input.displayName.trim()) {
    errors.push("Display name is required.");
  }

  if (
    input.status !== undefined &&
    !isPlayerProfileStatus(normalizeStatus(input.status))
  ) {
    errors.push("Player profile status is invalid.");
  }

  if (email && !isValidEmail(email)) {
    errors.push("Email must be valid.");
  }

  if (dateOfBirth && !isValidDateString(dateOfBirth)) {
    errors.push("Date of birth must be valid.");
  }

  if (dateOfBirth && isValidDateString(dateOfBirth) && isFutureDate(dateOfBirth)) {
    errors.push("Date of birth cannot be in the future.");
  }

  return errors.length > 0 ? invalid(errors) : valid();
}

export function normalizeCreatePlayerProfileInput(
  input: CreatePlayerProfileInput
): CreatePlayerProfileInput {
  return {
    accountId: input.accountId.trim(),
    firstName: normalizeOptionalString(input.firstName),
    lastName: normalizeOptionalString(input.lastName),
    displayName: input.displayName.trim(),
    email: normalizeOptionalString(input.email),
    phone: normalizeOptionalString(input.phone),
    dateOfBirth: normalizeOptionalString(input.dateOfBirth),
    externalPlayerId: normalizeOptionalString(input.externalPlayerId),
    externalPlatform: normalizeOptionalString(input.externalPlatform),
    status: input.status ? normalizeStatus(input.status) : "ACTIVE",
  };
}

export function normalizeUpdatePlayerProfileInput(
  input: UpdatePlayerProfileInput
): UpdatePlayerProfileInput {
  return {
    ...(input.accountId !== undefined ? { accountId: input.accountId.trim() } : {}),
    ...(input.firstName !== undefined
      ? { firstName: normalizeOptionalString(input.firstName) }
      : {}),
    ...(input.lastName !== undefined
      ? { lastName: normalizeOptionalString(input.lastName) }
      : {}),
    ...(input.displayName !== undefined
      ? { displayName: input.displayName.trim() }
      : {}),
    ...(input.email !== undefined
      ? { email: normalizeOptionalString(input.email) }
      : {}),
    ...(input.phone !== undefined
      ? { phone: normalizeOptionalString(input.phone) }
      : {}),
    ...(input.dateOfBirth !== undefined
      ? { dateOfBirth: normalizeOptionalString(input.dateOfBirth) }
      : {}),
    ...(input.externalPlayerId !== undefined
      ? { externalPlayerId: normalizeOptionalString(input.externalPlayerId) }
      : {}),
    ...(input.externalPlatform !== undefined
      ? { externalPlatform: normalizeOptionalString(input.externalPlatform) }
      : {}),
    ...(input.status !== undefined ? { status: normalizeStatus(input.status) } : {}),
  };
}
