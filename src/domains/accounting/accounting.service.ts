import { logger } from "@/src/lib/observability/logger";
import {
  generateWeeklyAccountingSnapshots,
  listWeeklyAccountingSnapshots,
} from "./accounting.repository";
import type {
  CloseWeeklyAccountingInput,
  ListWeeklyAccountingSnapshotsInput,
  WeeklyAccountingSnapshot,
} from "./accounting.types";
import {
  validateCloseWeeklyAccountingInput,
  validateListWeeklyAccountingSnapshotsInput,
} from "./accounting.validation";

export class AccountingValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "AccountingValidationError";
    this.errors = errors;
  }
}

export async function closeWeeklyAccounting(
  input: CloseWeeklyAccountingInput
): Promise<WeeklyAccountingSnapshot[]> {
  const normalized: CloseWeeklyAccountingInput = {
    ...input,
    currency: input.currency.trim().toUpperCase(),
    closeMode:
      typeof input.closeMode === "string"
        ? input.closeMode.trim().toUpperCase()
        : input.closeMode ?? null,
    accountScope: input.accountScope || null,
  };
  const validation = validateCloseWeeklyAccountingInput(normalized);

  if (!validation.valid) {
    throw new AccountingValidationError(validation.errors);
  }

  logger.info({
    message: "Weekly accounting close requested.",
    correlationId: normalized.correlationId,
    metadata: {
      weekStart: normalized.weekStart,
      weekEnd: normalized.weekEnd,
      accountScope: normalized.accountScope,
      currency: normalized.currency,
      closeMode: normalized.closeMode,
    },
  });

  return generateWeeklyAccountingSnapshots(normalized);
}

export async function getWeeklyAccountingSnapshots(
  input: ListWeeklyAccountingSnapshotsInput
): Promise<WeeklyAccountingSnapshot[]> {
  const normalized: ListWeeklyAccountingSnapshotsInput = {
    ...input,
    currency: input.currency?.trim().toUpperCase() || null,
    accountId: input.accountId || null,
    weekStart: input.weekStart || null,
    weekEnd: input.weekEnd || null,
  };
  const validation = validateListWeeklyAccountingSnapshotsInput(normalized);

  if (!validation.valid) {
    throw new AccountingValidationError(validation.errors);
  }

  return listWeeklyAccountingSnapshots(normalized);
}
