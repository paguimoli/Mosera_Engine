export type CashierTransactionType = "DEPOSIT" | "WITHDRAWAL";

export type RequestDepositCommand = {
  accountId: string;
  walletId?: string | null;
  amount: number;
  currencyCode: string;
  paymentMethod?: string | null;
  provider?: string | null;
  providerReference?: string | null;
  requestedByUserId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
};

export type RequestWithdrawalCommand = RequestDepositCommand;

export type ApproveCashierTransactionCommand = {
  transactionId: string;
  approvedByUserId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
};

export type CompleteCashierTransactionCommand = {
  transactionId: string;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
};

export type CashierTransactionCompletedEvent = {
  eventType: "cashier.transaction.completed";
  transactionId: string;
  accountId: string;
  walletId: string;
  transactionType: CashierTransactionType;
  amount: number;
  currencyCode: string;
  ledgerEntryId: string;
  correlationId?: string | null;
  occurredAt: string;
};
