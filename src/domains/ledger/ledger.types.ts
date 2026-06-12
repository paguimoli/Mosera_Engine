import type { WalletType } from "../wallets/wallet.types";

export type LedgerCategory = "accounting" | "operational" | "freeplay";

export type TransactionType =
  | "deposit"
  | "withdrawal"
  | "zero_balance_credit"
  | "zero_balance_debit"
  | "transfer_in"
  | "transfer_out"
  | "manual_adjustment"
  | "bet_stake"
  | "bet_win"
  | "win"
  | "loss"
  | "credit_adjustment"
  | "debit_adjustment"
  | "freeplay_win"
  | "freeplay_grant"
  | "freeplay_wager"
  | "freeplay_expiration"
  | "freeplay_adjustment"
  | "freeplay_reversal"
  | "settlement_reversal"
  | "reversal";

export type LedgerTransaction = {
  id: string;
  accountId: string;
  category: LedgerCategory;
  transactionType: TransactionType;
  walletType?: WalletType | null;
  amount: number;
  description: string;
  referenceId?: string | null;
  parentTransactionId?: string | null;
  createdBy?: string | null;
  recordHash?: string | null;
  previousHash?: string | null;
  hashVersion?: string | null;
  createdAt: string;
};

export type AccountFinancialSummary = {
  accountId: string;
  accountingBalance: number;
  weeklyFigure: number;
  freeplayBalance: number;
  pendingExposure: number;
  availableCredit: number;
};
