import type { LedgerTransaction } from "../ledger/ledger.types";
import type { SettlementExecutionInput } from "./settlement-executor.service";
import type { SettlementRecord, SettlementRun } from "./settlement.types";

export type AccountingPeriodStatus = "open" | "closed" | "locked";

export type AccountingPeriod = {
  id: string;
  marketId?: string | null;
  periodCode: string;
  startsAt: string;
  endsAt: string;
  status: AccountingPeriodStatus;
};

export type OverrideApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired";

export type OverrideApproval = {
  id: string;
  actionType: string;
  entityType: string;
  entityId: string;
  requestedBy: string;
  approvedBy?: string | null;
  status: OverrideApprovalStatus;
  reasonCode: string;
  createdAt: string;
  approvedAt?: string | null;
};

export type ResettlementEligibilityResult = {
  eligible: boolean;
  errors: string[];
};

export type ResettlementExecutionInput = {
  settlementRun: SettlementRun;
  accountingPeriod: AccountingPeriod;
  overrideApproval?: OverrideApproval | null;
  requestedByAdminId: string;
  originalSettlementRecords: SettlementRecord[];
  existingLedgerTransactions: LedgerTransaction[];
  correctedSettlementExecutionInput: SettlementExecutionInput;
};

export type ResettlementExecutionResult = {
  success: boolean;
  errors: string[];
  reversalSettlementRecords: SettlementRecord[];
  reversalLedgerTransactions: LedgerTransaction[];
  correctedSettlementRecords: SettlementRecord[];
  correctedLedgerTransactions: LedgerTransaction[];
};
