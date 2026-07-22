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

export type LedgerDirection = "CREDIT" | "DEBIT";

export type LedgerTransactionType =
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "TICKET_STAKE"
  | "TICKET_WIN"
  | "TICKET_REFUND"
  | "TICKET_VOID"
  | "FREE_PLAY_CREDIT"
  | "FREE_PLAY_STAKE"
  | "FREE_PLAY_WIN"
  | "MANUAL_CREDIT_ADJUSTMENT"
  | "MANUAL_DEBIT_ADJUSTMENT"
  | "SETTLEMENT_CREDIT"
  | "SETTLEMENT_DEBIT"
  | "ZERO_BALANCE_CREDIT"
  | "ZERO_BALANCE_DEBIT"
  | "REVERSAL";

export type LedgerReference = {
  referenceType?: string | null;
  referenceId?: string | null;
};

export type LedgerEntry = {
  id: string;
  walletId: string;
  accountId: string;
  transactionType: LedgerTransactionType;
  direction: LedgerDirection;
  amount: number;
  balanceAfter: number;
  currencyCode: string;
  referenceType?: string | null;
  referenceId?: string | null;
  idempotencyKey?: string | null;
  reversalOfLedgerEntryId?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type CreateLedgerEntryInput = {
  walletId: string;
  transactionType: LedgerTransactionType;
  direction: LedgerDirection;
  amount: number;
  effectiveAt?: string | null;
  reference?: LedgerReference;
  idempotencyKey?: string | null;
  reversalOfLedgerEntryId?: string | null;
  metadata?: Record<string, unknown>;
};
