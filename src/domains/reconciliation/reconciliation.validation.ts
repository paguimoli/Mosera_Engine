import type {
  ListReconciliationFindingsInput,
  ReconciliationRunType,
  ReconciliationScopeType,
  ReconciliationSeverity,
  RunReconciliationInput,
} from "./reconciliation.types";

const RUN_TYPES: ReconciliationRunType[] = [
  "CREDIT",
  "SETTLEMENT",
  "ACCOUNTING",
  "COMMISSION",
  "FULL",
];

const SCOPE_TYPES: ReconciliationScopeType[] = [
  "GLOBAL",
  "ACCOUNT",
  "PLAYER",
  "AGENT",
  "MASTER",
  "WEEK",
];

const SEVERITIES: ReconciliationSeverity[] = ["PASS", "WARNING", "FAIL"];

function isIso4217Currency(currency: string) {
  return /^[A-Z]{3}$/.test(currency);
}

function isValidDate(value: string) {
  return Boolean(value) && !Number.isNaN(new Date(value).getTime());
}

export function validateRunReconciliationInput(input: RunReconciliationInput) {
  const errors: string[] = [];

  if (!RUN_TYPES.includes(input.runType)) {
    errors.push("Reconciliation run type is invalid.");
  }

  if (!SCOPE_TYPES.includes(input.scopeType)) {
    errors.push("Reconciliation scope type is invalid.");
  }

  if (input.currency && !isIso4217Currency(input.currency)) {
    errors.push("Currency must be an ISO-4217 code.");
  }

  if (input.weekStart && !isValidDate(input.weekStart)) {
    errors.push("Week start must be a valid date.");
  }

  if (input.weekEnd && !isValidDate(input.weekEnd)) {
    errors.push("Week end must be a valid date.");
  }

  if (
    input.weekStart &&
    input.weekEnd &&
    isValidDate(input.weekStart) &&
    isValidDate(input.weekEnd) &&
    new Date(input.weekEnd).getTime() <= new Date(input.weekStart).getTime()
  ) {
    errors.push("Week end must be after week start.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateListReconciliationFindingsInput(
  input: ListReconciliationFindingsInput
) {
  const errors: string[] = [];

  if (input.severity && !SEVERITIES.includes(input.severity)) {
    errors.push("Reconciliation finding severity is invalid.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
