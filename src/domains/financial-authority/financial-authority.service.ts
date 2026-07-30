import {
  approveCashierTransaction as approveCashierTransactionInternal,
  cancelCashierTransaction as cancelCashierTransactionInternal,
  completeCashierTransaction as completeCashierTransactionInternal,
  listCashierTransactions as listCashierTransactionsInternal,
  listCashierTransactionsForAccount as listCashierTransactionsForAccountInternal,
  rejectCashierTransaction as rejectCashierTransactionInternal,
  requestDeposit as requestDepositInternal,
  requestWithdrawal as requestWithdrawalInternal,
} from "../cashier/cashier.service";
import {
  getWalletById as getWalletByIdInternal,
  listWalletsForAccount as listWalletsForAccountInternal,
  provisionWalletsForAccount as provisionWalletsForAccountInternal,
} from "../wallets/wallet.service";
import type { FinancialAuthorityReadiness } from "./financial-authority.types";

export * from "./financial-authority-credit";
export * from "./financial-authority-ledger";
export * from "./financial-authority.policy";

export const getWalletById = getWalletByIdInternal;
export const listWalletsForAccount = listWalletsForAccountInternal;
export const provisionWalletsForAccount = provisionWalletsForAccountInternal;

export const requestDeposit = requestDepositInternal;
export const requestWithdrawal = requestWithdrawalInternal;
export const approveCashierTransaction = approveCashierTransactionInternal;
export const rejectCashierTransaction = rejectCashierTransactionInternal;
export const cancelCashierTransaction = cancelCashierTransactionInternal;
export const completeCashierTransaction = completeCashierTransactionInternal;
export const listCashierTransactions = listCashierTransactionsInternal;
export const listCashierTransactionsForAccount =
  listCashierTransactionsForAccountInternal;

export function getFinancialAuthorityReadiness(): FinancialAuthorityReadiness {
  return {
    authority: "FinancialAuthority",
    ledgerAuthority: "CANONICAL",
    walletAuthority: "CANONICAL",
    reservationAuthority: "CANONICAL",
    settlementAuthority: "CANONICAL",
    operatingModeAuthority: "CANONICAL",
    fundingInstrumentAuthority: "CANONICAL",
    launchFundingInstruments: ["CREDIT"],
    futureFundingInstruments: ["FREE_PLAY"],
    compensationConsumerEnabled: true,
  };
}
