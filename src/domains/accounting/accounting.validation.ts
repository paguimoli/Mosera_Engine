import type {
  CloseWeeklyAccountingInput,
  ListWeeklyAccountingSnapshotsInput,
} from "./accounting.types";

function isIso4217Currency(currency: string) {
  return /^[A-Z]{3}$/.test(currency);
}

function isValidDate(value: string) {
  return Boolean(value) && !Number.isNaN(new Date(value).getTime());
}

export function validateCloseWeeklyAccountingInput(
  input: CloseWeeklyAccountingInput
) {
  const errors: string[] = [];

  if (!isValidDate(input.weekStart)) {
    errors.push("Week start is required and must be a valid date.");
  }

  if (!isValidDate(input.weekEnd)) {
    errors.push("Week end is required and must be a valid date.");
  }

  if (
    isValidDate(input.weekStart) &&
    isValidDate(input.weekEnd) &&
    new Date(input.weekEnd).getTime() <= new Date(input.weekStart).getTime()
  ) {
    errors.push("Week end must be after week start.");
  }

  if (!isIso4217Currency(input.currency)) {
    errors.push("Currency must be an ISO-4217 code.");
  }

  if (
    input.closeMode !== undefined &&
    input.closeMode !== null &&
    input.closeMode !== "CARRY_BALANCE" &&
    input.closeMode !== "ZERO_BALANCE"
  ) {
    errors.push("Close mode is invalid.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateListWeeklyAccountingSnapshotsInput(
  input: ListWeeklyAccountingSnapshotsInput
) {
  const errors: string[] = [];

  if (input.weekStart && !isValidDate(input.weekStart)) {
    errors.push("Week start must be a valid date.");
  }

  if (input.weekEnd && !isValidDate(input.weekEnd)) {
    errors.push("Week end must be a valid date.");
  }

  if (input.currency && !isIso4217Currency(input.currency)) {
    errors.push("Currency must be an ISO-4217 code.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
