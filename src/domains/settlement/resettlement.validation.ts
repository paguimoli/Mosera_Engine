import type { SettlementRun } from "./settlement.types";
import type {
  AccountingPeriod,
  OverrideApproval,
  ResettlementEligibilityResult,
} from "./resettlement.types";

export const RESETTLEMENT_ACTION_TYPE = "settlement.resettlement";

export function validateResettlementEligibility({
  settlementRun,
  accountingPeriod,
  overrideApproval,
  requestedByAdminId,
}: {
  settlementRun: SettlementRun;
  accountingPeriod: AccountingPeriod;
  overrideApproval?: OverrideApproval | null;
  requestedByAdminId: string;
}): ResettlementEligibilityResult {
  const errors: string[] = [];

  if (accountingPeriod.status === "closed") {
    errors.push("RESETTLEMENT_BLOCKED_PERIOD_CLOSED");
  }

  if (accountingPeriod.status === "locked") {
    errors.push("RESETTLEMENT_BLOCKED_PERIOD_LOCKED");
  }

  if (accountingPeriod.status !== "open") {
    return {
      eligible: false,
      errors,
    };
  }

  if (!overrideApproval) {
    errors.push("RESETTLEMENT_REQUIRES_OVERRIDE_APPROVAL");
  }

  if (overrideApproval && overrideApproval.status !== "approved") {
    errors.push("RESETTLEMENT_REQUIRES_OVERRIDE_APPROVAL");
  }

  if (
    overrideApproval &&
    overrideApproval.actionType !== RESETTLEMENT_ACTION_TYPE
  ) {
    errors.push("RESETTLEMENT_REQUIRES_OVERRIDE_APPROVAL");
  }

  if (overrideApproval && overrideApproval.entityId !== settlementRun.id) {
    errors.push("RESETTLEMENT_REQUIRES_OVERRIDE_APPROVAL");
  }

  if (!overrideApproval?.approvedBy) {
    errors.push("RESETTLEMENT_REQUIRES_OVERRIDE_APPROVAL");
  }

  if (
    overrideApproval?.approvedBy &&
    overrideApproval.approvedBy === requestedByAdminId
  ) {
    errors.push("RESETTLEMENT_REQUIRES_DUAL_CONTROL");
  }

  return {
    eligible: errors.length === 0,
    errors,
  };
}
