import type { ValidationResult } from "@/src/lib/validation/validation.types";
import type {
  CommissionAssignment,
  CommissionExecutionInput,
  CommissionPlan,
  CreateCommissionAdjustmentInput,
  GenerateCommissionRunInput,
} from "./commission.types";

function isPercentageModel(model?: string) {
  return model === "weekly_figure_percentage" || model === "revenue_share";
}

export function validateCommissionPlan(
  plan: Partial<CommissionPlan>
): ValidationResult {
  const errors: string[] = [];

  if (!plan.name?.trim()) {
    errors.push("Commission plan name is required.");
  }

  if (!plan.model) {
    errors.push("Commission model is required.");
  }

  if (isPercentageModel(plan.model)) {
    if (plan.percentage === null || plan.percentage === undefined) {
      errors.push("Percentage is required for percentage commission models.");
    } else if (
      Number.isNaN(Number(plan.percentage)) ||
      Number(plan.percentage) < 0 ||
      Number(plan.percentage) > 100
    ) {
      errors.push("Percentage must be between 0 and 100.");
    }
  }

  if (
    plan.model === "flat_weekly_fee" &&
    (plan.flatAmount === null || plan.flatAmount === undefined)
  ) {
    errors.push("Flat amount is required for flat weekly fee plans.");
  } else if (
    plan.model === "flat_weekly_fee" &&
    Number.isNaN(Number(plan.flatAmount))
  ) {
    errors.push("Flat amount must be numeric.");
  }

  if (!plan.effectiveFrom) {
    errors.push("Effective from date is required.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateCommissionAssignment(
  assignment: Partial<CommissionAssignment>
): ValidationResult {
  const errors: string[] = [];

  if (!assignment.accountId) {
    errors.push("Commission assignment account is required.");
  }

  if (!assignment.commissionPlanId) {
    errors.push("Commission assignment plan is required.");
  }

  if (!assignment.effectiveFrom) {
    errors.push("Commission assignment effective from date is required.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateCommissionRun(
  run: Partial<CommissionExecutionInput>
): ValidationResult {
  const errors: string[] = [];

  if (!run.accountingPeriodId && !run.marketId) {
    errors.push("Commission run requires accounting period or market.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function isValidDate(value: string) {
  return Boolean(value) && !Number.isNaN(new Date(value).getTime());
}

function isIso4217Currency(currency: string) {
  return /^[A-Z]{3}$/.test(currency);
}

function isIntegerMinorUnitAmount(amount: number) {
  return Number.isInteger(amount);
}

export function validateGenerateCommissionRunInput(
  input: GenerateCommissionRunInput
): ValidationResult {
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

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateCreateCommissionAdjustmentInput(
  input: CreateCommissionAdjustmentInput
): ValidationResult {
  const errors: string[] = [];

  if (!input.accountId) {
    errors.push("Account id is required.");
  }

  if (!input.runId) {
    errors.push("Commission run id is required.");
  }

  if (
    !isIntegerMinorUnitAmount(input.adjustmentAmount) ||
    input.adjustmentAmount === 0
  ) {
    errors.push("Adjustment amount must be a non-zero integer minor unit value.");
  }

  if (!input.reasonCode.trim()) {
    errors.push("Reason code is required.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
