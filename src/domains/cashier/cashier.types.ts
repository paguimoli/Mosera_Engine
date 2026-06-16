export type CashierTransactionType = "DEPOSIT" | "WITHDRAWAL";

export type CashierTransactionStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED"
  | "COMPLETED";

export type CashierTransaction = {
  id: string;
  accountId: string;
  walletId?: string | null;
  transactionType: CashierTransactionType;
  status: CashierTransactionStatus;
  amount: number;
  currencyCode: string;
  paymentMethod?: string | null;
  provider?: string | null;
  providerReference?: string | null;
  requestedByUserId?: string | null;
  approvedByUserId?: string | null;
  rejectedByUserId?: string | null;
  cancelledByUserId?: string | null;
  ledgerEntryId?: string | null;
  reason?: string | null;
  metadata: Record<string, unknown>;
  requestedAt: string;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  cancelledAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt?: string | null;
};

export type CreateCashierTransactionInput = {
  accountId: string;
  walletId?: string | null;
  transactionType: CashierTransactionType;
  amount: number;
  currencyCode: string;
  paymentMethod?: string | null;
  provider?: string | null;
  providerReference?: string | null;
  requestedByUserId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
};

export type ApproveCashierTransactionInput = {
  transactionId: string;
  approvedByUserId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
};

export type RejectCashierTransactionInput = {
  transactionId: string;
  rejectedByUserId?: string | null;
  reason: string;
  metadata?: Record<string, unknown>;
};

export type CancelCashierTransactionInput = {
  transactionId: string;
  cancelledByUserId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
};

export type CompleteCashierTransactionInput = {
  transactionId: string;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpdateCashierTransactionStatusInput = {
  transactionId: string;
  status: CashierTransactionStatus;
  approvedByUserId?: string | null;
  rejectedByUserId?: string | null;
  cancelledByUserId?: string | null;
  ledgerEntryId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  cancelledAt?: string | null;
  completedAt?: string | null;
};
