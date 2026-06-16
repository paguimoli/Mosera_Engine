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

export type PostLedgerEntryCommand = {
  walletId: string;
  transactionType: LedgerTransactionType;
  direction: LedgerDirection;
  amount: number;
  referenceType?: string | null;
  referenceId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
};

export type ReverseLedgerEntryCommand = {
  ledgerEntryId: string;
  reason: string;
  actorUserId?: string | null;
  idempotencyKey?: string | null;
  correlationId?: string | null;
};

export type LedgerEntryPostedEvent = {
  eventType: "ledger.entry.posted";
  ledgerEntryId: string;
  walletId: string;
  accountId: string;
  transactionType: LedgerTransactionType;
  direction: LedgerDirection;
  amount: number;
  balanceAfter: number;
  currencyCode: string;
  correlationId?: string | null;
  occurredAt: string;
};

export type LedgerEntryReversedEvent = {
  eventType: "ledger.entry.reversed";
  ledgerEntryId: string;
  reversedLedgerEntryId: string;
  walletId: string;
  accountId: string;
  amount: number;
  currencyCode: string;
  reason: string;
  correlationId?: string | null;
  occurredAt: string;
};
