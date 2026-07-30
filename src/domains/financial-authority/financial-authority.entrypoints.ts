// Sole production boundary for financial callers. Domain services behind this
// facade remain implementation details of the canonical Financial Authority.

export * from "./financial-authority.service";
export type * from "./financial-authority.types";

export {
  executeResettlement,
  reverseSettlementRecordsForResettlement,
  applySettlementResults,
  executeSettlement,
  resumeSettlement,
} from "../settlement/settlement.entrypoints";

export {
  createCompensationConfiguration,
  executeWeeklyCompensation,
  reverseCompensationEntitlement,
} from "../compensation/compensation.service";

export {
  CreditReservationValidationError,
} from "../credit/credit.entrypoints";
export {
  LedgerBusinessRuleError,
  LedgerValidationError,
} from "../ledger/ledger.entrypoints";
export {
  CashierBusinessRuleError,
  CashierValidationError,
} from "../cashier/cashier.service";
export {
  WalletBusinessRuleError,
  WalletValidationError,
} from "../wallets/wallet.service";
